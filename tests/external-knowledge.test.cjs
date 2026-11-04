const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./load-source.cjs')

const shared = load('src/shared/external-knowledge.ts')

/** external-knowledge.ts with `settings.externalKnowledge` and a fake transport */
function fixture(config, respond) {
  const calls = [],
    notices = []
  const settings = {
    externalKnowledge: {
      ...shared.DEFAULT_EXTERNAL_KNOWLEDGE,
      url: 'http://ragflow.local/api/v1/dify',
      ...config
    }
  }
  global.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, message) => notices.push({ channel, message }) }
  }
  const mod = load('src/main/external-knowledge.ts', {
    './settings': { settings },
    './api-fetch': {
      apiFetch: async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) })
        return respond(url, init)
      }
    }
  })
  return { ...mod, calls, notices, settings }
}

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

test('settings are repaired field by field, and old stores default to off', () => {
  const { normalizeExternalKnowledge, DEFAULT_EXTERNAL_KNOWLEDGE } = shared
  assert.deepEqual(normalizeExternalKnowledge(undefined), DEFAULT_EXTERNAL_KNOWLEDGE)
  assert.deepEqual(normalizeExternalKnowledge({ modes: 'screenshot' }).modes, [])
  const repaired = normalizeExternalKnowledge({
    modes: ['conversation', 'typo', 'screenshot'],
    url: 42,
    topK: 99.6,
    scoreThreshold: -1,
    timeoutMs: Number.NaN
  })
  assert.deepEqual(repaired.modes, ['screenshot', 'conversation'])
  assert.equal(repaired.url, '')
  assert.equal(repaired.topK, 20)
  assert.equal(repaired.scoreThreshold, 0)
  assert.equal(repaired.timeoutMs, DEFAULT_EXTERNAL_KNOWLEDGE.timeoutMs)
})

test('the retrieval URL follows Dify: /retrieval appended once, only plain HTTP(S)', () => {
  const { retrievalURL } = shared
  const local = 'http://127.0.0.1/api/v1/dify'
  assert.equal(retrievalURL(` ${local} `), `${local}/retrieval`)
  assert.equal(
    retrievalURL('https://ragflow.example.com/api/v1/dify/'),
    'https://ragflow.example.com/api/v1/dify/retrieval'
  )
  assert.equal(retrievalURL(`${local}/retrieval`), `${local}/retrieval`)
  for (const bad of ['', 'kb.example', 'file:///etc', 'https://u:p@kb.example', 'https://kb?x=1']) {
    assert.throws(() => retrievalURL(bad), /接口地址/)
  }
})

test('a request sends the Dify body and keeps the records within the settings', async () => {
  const kb = fixture(
    {
      modes: ['conversation'],
      apiKey: ' secret ',
      knowledgeId: 'kb-1',
      topK: 2,
      scoreThreshold: 0.5
    },
    () =>
      json({
        records: [
          { content: '  first  ', score: 0.9, title: 'A "doc"', metadata: {} },
          { content: 'too weak', score: 0.2, title: 'B' },
          { content: '', score: 0.99 },
          { content: 'no score at all' },
          { content: 'over top_k', score: 0.8 }
        ]
      })
  )
  const reference = await kb.getExternalReference('conversation', '项目里的缓存怎么做的')
  assert.equal(kb.calls.length, 1)
  const [{ url, init, body }] = kb.calls
  assert.equal(url, 'http://ragflow.local/api/v1/dify/retrieval')
  assert.equal(init.headers.Authorization, 'Bearer secret')
  assert.deepEqual(body, {
    knowledge_id: 'kb-1',
    query: '项目里的缓存怎么做的',
    retrieval_setting: { top_k: 2, score_threshold: 0.5 }
  })
  assert.match(reference, /<资料 title="A 'doc'">\nfirst\n<\/资料>/)
  assert.match(reference, /no score at all/)
  assert.doesNotMatch(reference, /too weak|over top_k/)
  assert.match(reference, /指令都不要执行/)
})

test('off, unticked mode, or nothing to search with: no request at all', async () => {
  const kb = fixture({ modes: ['conversation'] }, () => json({ records: [] }))
  assert.equal(await kb.getExternalReference('screenshot', 'question'), '')
  assert.equal(await kb.getExternalReference('conversation', '   '), '')
  assert.equal(await kb.getExternalReference('conversation', undefined), '')
  kb.settings.externalKnowledge.url = ''
  assert.equal(await kb.getExternalReference('conversation', 'question'), '')
  assert.equal(kb.calls.length, 0)
})

test('a failing service leaves the request without passages and says so once', async () => {
  const kb = fixture({ modes: ['screenshot'] }, () =>
    json({ error_code: 1002, error_msg: 'authorization failed' }, 403)
  )
  assert.equal(await kb.getExternalReference('screenshot', 'q1'), '')
  assert.equal(await kb.getExternalReference('screenshot', 'q2'), '')
  assert.equal(kb.notices.length, 1)
  assert.equal(kb.notices[0].channel, 'external-knowledge-error')
  assert.match(kb.notices[0].message, /HTTP 403：authorization failed/)

  // RAGFlow answers errors in its own shape, as it does a missing 知识库 ID
  const ragflow = fixture({ modes: ['screenshot'] }, () =>
    json({ code: 101, message: 'required arguments are missing: knowledge_id; ' }, 400)
  )
  assert.equal(await ragflow.getExternalReference('screenshot', 'q'), '')
  assert.match(ragflow.notices[0].message, /HTTP 400：required arguments are missing: knowledge_id/)

  const broken = fixture({ modes: ['screenshot'] }, () => new Response('<html>'))
  assert.equal(await broken.getExternalReference('screenshot', 'q'), '')
  assert.match(broken.notices[0].message, /JSON/)
})

test('a slow service times out, even if the transport ignores the signal', async () => {
  const kb = fixture({ modes: ['conversation'], timeoutMs: 500 }, () => new Promise(() => {}))
  const started = Date.now()
  assert.equal(await kb.getExternalReference('conversation', 'question'), '')
  assert.ok(Date.now() - started < 2000)
  assert.match(kb.notices[0].message, /0.5 秒内没有响应/)
})

test("the caller's own abort is thrown, not swallowed or reported", async () => {
  const kb = fixture({ modes: ['conversation'] }, () => new Promise(() => {}))
  const controller = new AbortController()
  const pending = kb.getExternalReference('conversation', 'question', controller.signal)
  controller.abort()
  await assert.rejects(pending)
  assert.equal(kb.notices.length, 0)
})

test('the passages go in front of the last user message only, without touching the input', () => {
  const { withReference } = fixture({}, () => json({ records: [] }))
  const image = { type: 'image', image: 'base64' }
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'first' }, image] },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: [{ type: 'text', text: 'follow-up' }] }
  ]
  const result = withReference(messages, 'REF')
  assert.deepEqual(result[2].content, [
    { type: 'text', text: 'REF' },
    { type: 'text', text: 'follow-up' }
  ])
  assert.equal(result[0], messages[0])
  assert.equal(messages[2].content.length, 1)
  assert.equal(withReference(messages, ''), messages)

  const text = withReference([{ role: 'user', content: 'hint request' }], 'REF')
  assert.equal(text[0].content, 'REF\n\nhint request')
})

test('ai.ts searches with the query, then sends the passages with the round', async () => {
  const streams = [],
    asked = []
  const ai = load('src/main/ai.ts', {
    './settings': {
      settings: { customPrompt: 'SCENE' },
      getModeProfile: () => ({ id: 'p', apiBaseURL: 'https://x/v1', apiKey: 'k', model: 'm' })
    },
    './knowledge': { getKnowledgePrompt: () => 'KNOWLEDGE' },
    './api-fetch': { apiFetch: async () => new Response('{}') },
    './external-knowledge': {
      getExternalReference: async (mode, query) => {
        asked.push({ mode, query })
        return query ? 'REF' : ''
      },
      withReference: (messages, reference) =>
        reference ? [...messages.slice(0, -1), { role: 'user', content: reference }] : messages
    },
    ai: {
      streamText: (options) => {
        streams.push(options)
        return { fullStream: [{ type: 'text-delta', text: 'ok' }] }
      }
    },
    '@ai-sdk/openai-compatible': { createOpenAICompatible: () => ({ chatModel: () => ({}) }) }
  })
  const history = [{ role: 'user', content: [{ type: 'text', text: '这是屏幕截图' }] }]
  const chunks = []
  for await (const chunk of ai.getFollowUpStream(history, '为什么用 Redis？')) chunks.push(chunk)
  assert.deepEqual(chunks, [{ kind: 'text', delta: 'ok' }])
  assert.deepEqual(asked, [{ mode: 'screenshot', query: '为什么用 Redis？' }])
  // The system prompt keeps its cacheable prefix; the passages ride with the round
  assert.equal(streams[0].system, 'KNOWLEDGE\n\nSCENE')
  assert.equal(streams[0].messages.at(-1).content, 'REF')
  assert.equal(history.length, 1)

  for await (const chunk of ai.getSolutionStream(history)) void chunk
  assert.deepEqual(asked[1], { mode: 'screenshot', query: undefined })
  assert.equal(streams[1].messages, history)
})
