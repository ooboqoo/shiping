const test = require('node:test'),
  assert = require('node:assert/strict'),
  load = require('./load-source.cjs')
let captured,
  contextCalls = 0
const ai = load('src/main/ai.ts', {
  ai: {
    streamText: (opts) => {
      captured = opts
      return {
        fullStream: (async function* () {
          yield { type: 'text-delta', text: 'ok' }
        })()
      }
    }
  },
  '@ai-sdk/openai-compatible': { createOpenAICompatible: () => ({ chatModel: () => ({}) }) },
  './settings': {
    settings: { customPrompt: 'scene', conversationPrompt: 'conversation' },
    getModeProfile: () => ({ apiBaseURL: '', apiKey: '', model: 'mock' })
  },
  './api-fetch': { apiFetch: () => {} },
  './knowledge': { getKnowledgePrompt: () => 'WHOLE_CORPUS' },
  './rag/service': {
    getRagContext: async (mode, messages, signal) => {
      contextCalls++
      signal?.throwIfAborted()
      return 'RETRIEVED_ONLY'
    }
  },
  './thinking': { createThinkingOffFetch: () => {} }
})
test('retrieved context reaches AI and whole corpus is absent', async () => {
  for await (const c of ai.getHintStream([{ role: 'user', content: 'Redis?' }]))
    assert.equal(c.delta, 'ok')
  assert.ok(captured.system.includes('RETRIEVED_ONLY'))
  assert.ok(!captured.system.includes('WHOLE_CORPUS'))
  assert.equal(contextCalls, 1)
})
test('abort during retrieval never calls AI', async () => {
  const old = captured,
    c = new AbortController()
  c.abort()
  await assert.rejects(async () => {
    for await (const x of ai.getHintStream([], c.signal)) void x
  })
  assert.equal(captured, old)
})
const { extractQuery } = load('src/main/rag/query.ts')
test('pure image has no invented text query; follow-up uses recent text', () => {
  assert.equal(extractQuery([{ role: 'user', content: [{ type: 'image', image: 'base64' }] }]), '')
  assert.ok(
    extractQuery([
      { role: 'user', content: 'Redis 缓存项目' },
      { role: 'assistant', content: 'ignored' },
      { role: 'user', content: '怎么优化的' }
    ]).endsWith('怎么优化的')
  )
})

test('real screenshot boilerplate is not a retrieval query; transcript is', () => {
  const image = { type: 'image', image: 'base64' }
  for (const text of [
    '这是屏幕截图',
    '这是下一部分截图，请结合之前所有截图和分析，继续分析解答，不要遗漏任何信息。'
  ])
    assert.equal(extractQuery([{ role: 'user', content: [{ type: 'text', text }, image] }]), '')
  assert.equal(
    extractQuery([
      {
        role: 'user',
        content: [
          { type: 'text', text: '这是语音转录内容：\nRedis 怎么优化？\n\n同时附上屏幕截图：' },
          image
        ]
      }
    ]),
    'Redis 怎么优化？'
  )
})

test('conversation retrieval uses focused question and drops transcript boilerplate', () => {
  const content =
    '【之前对方说过的话】\n我们讨论Redis缓存\n\n【对方刚才说的话】\n嗯。\n爬爬老师课程网址是什么？\nう。\n\n【上一版提示】\n不确定，请澄清\n\n请换一个角度重新给出提示，不要重复上一版。'
  assert.equal(extractQuery([{ role: 'user', content }]), '爬爬老师课程网址是什么？')
})
test('a follow-up pronoun can retain useful preceding conversation context', () => {
  const content = '【之前对方说过的话】\n我们讨论Redis缓存\n\n【对方刚才说的话】\n它有什么缺点？'
  assert.ok(extractQuery([{ role: 'user', content }]).includes('Redis'))
})
test('new independent question does not inherit the previous unrelated topic',()=>{assert.equal(extractQuery([{role:'user',content:'Redis持久化怎么做'},{role:'assistant',content:'回答'},{role:'user',content:'爬爬老师课程网址是什么'}]),'爬爬老师课程网址是什么')})
