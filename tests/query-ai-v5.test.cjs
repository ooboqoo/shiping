const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  load = require('./load-source.cjs')
test('AI configuration is private, web override wins and provider errors never expose secrets', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiping-ai-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const { AIClient } = load('src/main/library-v4/ai-client.ts'),
    client = new AIClient(dir),
    profile = {
      apiBaseURL: 'https://api.deepseek.com/v1',
      apiKey: 'private-test-key',
      apiHeaders: 'X-Secret: private-header',
      model: 'deepseek-chat',
      disableThinking: true
    }
  client.configure(profile, 'desktop', '1')
  assert.equal(client.status().configured, true)
  assert.doesNotMatch(JSON.stringify(client.status()), /private-test/)
  assert.equal(fs.statSync(path.join(dir, 'ai.json')).mode & 0o777, 0o600)
  client.configure({ ...profile, model: 'explicit-web' }, 'web', '2')
  client.configure(profile, 'desktop', '3')
  assert.equal(client.status().model, 'explicit-web')
  const again = new AIClient(dir)
  assert.equal(again.status().model, 'explicit-web')
  assert.throws(() =>
    client.configure({ ...profile, apiBaseURL: 'https://key@example.com' }, 'web', '4')
  )
  assert.throws(() =>
    client.configure(
      { ...profile, proxy: { mode: 'custom', url: 'ftp://127.0.0.1:1' } },
      'web',
      '5'
    )
  )
})
test('query planner skips simple questions, bounds expansion and rejects changed identifiers', async () => {
  const { planQuery } = load('src/main/library-v4/query-planner.ts')
  let calls = 0
  const ai = {
    rewrite: async () => {
      calls++
      return { query: 'E9999 的解决办法', terms: ['错误'] }
    }
  }
  const simple = await planQuery('错误 E7319 如何处理', [], ai, true)
  assert.equal(calls, 0)
  assert.deepEqual(simple.queries, [])
  const bad = await planQuery('嗯我想问一下这个错误 E7319 到底怎么处理呢', [], ai, true)
  assert.equal(calls, 1)
  assert.equal(bad.diagnostics.status, 'fallback')
  assert.deepEqual(bad.queries, [])
  const good = await planQuery(
    '嗯我想问一下这个错误 E7319 到底怎么处理呢',
    [],
    { rewrite: async () => ({ query: 'E7319 错误如何处理', terms: ['处理方法', '排查'] }) },
    true
  )
  assert.ok(good.queries[0].includes('E7319'))
  assert.ok(good.queries.length <= 2)
})
test('follow-up rewrite only uses bounded successful recent history, keeps original and fails closed', async () => {
  const { planQuery } = load('src/main/library-v4/query-planner.ts')
  const history = [
    { role: 'user', content: '如何建立全量索引' },
    { role: 'assistant', content: '可用全量索引按钮重建。' }
  ]
  let seen
  const p = await planQuery(
    '它和增量有啥区别',
    history,
    {
      rewrite: async (q, h) => {
        seen = h
        return { query: '全量索引与增量索引有什么区别', terms: ['全量索引', '增量索引'] }
      }
    },
    true
  )
  assert.equal(p.original, '它和增量有啥区别')
  assert.equal(seen.length, 2)
  assert.equal(p.diagnostics.status, 'rewritten')
  const bad = await planQuery(
    '它和增量有啥区别',
    history,
    {
      rewrite: async () => {
        throw Error('sk-secret')
      }
    },
    true
  )
  assert.equal(bad.diagnostics.status, 'fallback')
  assert.doesNotMatch(JSON.stringify(bad), /sk-secret/)
  const c = new AbortController()
  c.abort()
  await assert.rejects(
    planQuery('这个呢', history, {}, true, c.signal),
    (e) => e.name === 'AbortError'
  )
})

test('compatible provider sends bounded rewrite and streams answers, errors are sanitized', async (t) => {
  const logged = [],
    priorError = console.error
  console.error = (...v) => logged.push(v)
  t.after(() => {
    console.error = priorError
  })
  const http = require('node:http'),
    requests = [],
    server = http.createServer(async (req, res) => {
      let body = ''
      for await (const b of req) body += b
      const value = JSON.parse(body)
      requests.push(value)
      assert.equal(req.headers.authorization, 'Bearer fake-private-key')
      if (value.model === 'error-model') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'fake-private-key should never escape' } }))
        return
      }
      if (value.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        for (const content of ['答案', '731 [1]'])
          res.write(
            'data: ' +
              JSON.stringify({
                id: 'x',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'fixture',
                choices: [{ index: 0, delta: { content }, finish_reason: null }]
              }) +
              '\n\n'
          )
        res.end(
          'data: ' +
            JSON.stringify({
              id: 'x',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'fixture',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
            }) +
            '\n\ndata: [DONE]\n\n'
        )
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'x',
            object: 'chat.completion',
            created: 1,
            model: 'fixture',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '{"query":"全量索引步骤","terms":["重建"]}'
                },
                finish_reason: 'stop'
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
          })
        )
      }
    })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => server.close(r)))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiping-provider-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const { AIClient } = load('src/main/library-v4/ai-client.ts'),
    client = new AIClient(dir),
    profile = {
      apiBaseURL: 'http://127.0.0.1:' + server.address().port + '/v1',
      apiKey: 'fake-private-key',
      model: 'fixture'
    }
  client.configure(profile, 'web', '1')
  const rewrite = await client.rewrite('嗯怎么重建', [])
  assert.equal(rewrite.query, '全量索引步骤')
  let answer = ''
  for await (const text of client.answer(
    [{ role: 'user', content: '编号是多少' }],
    '编号731，资料[1]'
  ))
    answer += text
  assert.equal(answer, '答案731 [1]')
  assert.equal(requests[0].max_tokens, 350)
  assert.equal(
    requests[0].thinking?.type,
    'disabled',
    'bounded rewrite should not spend its tiny budget on hidden reasoning'
  )
  assert.equal(requests[1].max_tokens, 2048)
  for await (const _ of client.answer([{ role: 'user', content: '你好' }], '', undefined, false)) {
  }
  assert.match(requests[2].messages[0].content, /当前未使用知识库/)
  assert.doesNotMatch(requests[2].messages[0].content, /只依据本轮编号参考资料/)
  client.configure({ ...profile, model: 'error-model' }, 'web', '2')
  await assert.rejects(
    async () => {
      for await (const _ of client.answer([{ role: 'user', content: 'q' }], 'c')) {
      }
    },
    (e) => !/fake-private-key/.test(e.message)
  )
  assert.equal(requests.length, 4)
  assert.equal(logged.length, 0, 'SDK errors must not dump provider request/response secrets')
})

test('provider internal deadline rejects partial output instead of completing successfully', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiping-ai-deadline-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const originalTimeout = AbortSignal.timeout
  AbortSignal.timeout = (ms) => originalTimeout(ms === 90000 ? 30 : ms)
  t.after(() => {
    AbortSignal.timeout = originalTimeout
  })
  const { AIClient } = load('src/main/library-v4/ai-client.ts'),
    client = new AIClient(
      dir,
      async (_url, options) =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                new TextEncoder().encode(
                  'data: ' +
                    JSON.stringify({
                      id: 'x',
                      object: 'chat.completion.chunk',
                      created: 1,
                      model: 'fixture',
                      choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }]
                    }) +
                    '\n\n'
                )
              )
              options.signal.addEventListener('abort', () => c.error(options.signal.reason), {
                once: true
              })
            }
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
    )
  client.configure(
    { apiBaseURL: 'https://api.deepseek.com/v1', apiKey: 'fake-private', model: 'fixture' },
    'web',
    '1'
  )
  let answer = ''
  await assert.rejects(async () => {
    for await (const text of client.answer([{ role: 'user', content: '问题' }], '证据'))
      answer += text
  }, /请求失败|超时/)
  assert.equal(answer, 'partial')
})
test('rewrite protects single-digit chapter numbers, quantities and decimals', async () => {
  const { planQuery } = load('src/main/library-v4/query-planner.ts')
  for (const [question, query] of [
    ['嗯，第3章的2个阶段是什么', '第4章的5个阶段是什么'],
    ['嗯，阈值0.5和3.14有什么区别', '阈值0.6和3.14有什么区别'],
    ['嗯，第3章和13章分别有什么', '第13章分别有什么']
  ]) {
    const result = await planQuery(
      question,
      [],
      { rewrite: async () => ({ query, terms: [] }) },
      true
    )
    assert.equal(result.diagnostics.status, 'fallback')
  }
})
