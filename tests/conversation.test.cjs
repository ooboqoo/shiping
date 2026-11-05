const { test } = require('node:test')
const assert = require('node:assert/strict')
const createLoader = require('./voice-load-source.cjs')

function harness(extraSettings = {}, options = {}) {
  const handlers = new Map(),
    sent = [],
    requests = [],
    end = []
  let sentence
  const settings = {
    conversationHintMode: 'auto',
    conversationMinChars: 4,
    conversationContextEnabled: true,
    conversationContextRounds: 3,
    conversationContextTokenBudget: 1000,
    ...extraSettings
  }
  const load = createLoader({
    electron: {
      app: {
        on() {
          /* unused mock */
        }
      },
      ipcMain: { handle: (k, v) => handlers.set(k, v) }
    },
    './settings': {
      settings,
      getModeProfile: () => ({ apiKey: 'test' }),
      onSettingsChanged() {
        /* unused mock */
      }
    },
    './save-conversation': {
      saveConversation: async () => {
        /* unused mock */
      },
      saveConversationSync() {
        /* unused mock */
      }
    },
    './mobile-sync': {
      markMobileDirty() {
        /* unused mock */
      },
      registerMobileSource() {
        /* unused mock */
      }
    },
    './transcription': {
      isTranscriptionRunning: () => true,
      onConversationSentence: (f) => (sentence = f),
      onTranscriptionEnd: (f) => end.push(f)
    },
    './ai': {
      getHintStream: (messages, signal, query) => {
        requests.push({ messages, signal, query })
        return (async function* () {
          yield { kind: 'reasoning', delta: 'not an answer' }
          if (options.whitespaceFirst) {
            yield { kind: 'text', delta: '\n\n' }
            await new Promise((r) => setTimeout(r, 35))
          }
          yield { kind: 'text', delta: '建议使用缓存，设置过期时间。' }
        })()
      },
      summarizeConversation: async () => '面试官问题：缓存。AI 建议：设置过期时间。'
    }
  })
  global.mainWindow = { isDestroyed: () => false, webContents: { send: (...v) => sent.push(v) } }
  const api = load('src/main/conversation.ts')
  return {
    api,
    sent,
    requests,
    settings,
    handlers,
    say: (text, final = true, source = 'system') => sentence(text, final, source),
    stop: () => end.forEach((f) => f())
  }
}
const flush = () => new Promise((r) => setTimeout(r, 10))

test('external retrieval uses interviewer speech without treating microphone replies as questions', async () => {
  const h = harness({ conversationHintMode: 'manual' })
  h.say('请解释线程池的拒绝策略')
  h.api.requestHint()
  await flush()
  h.say('我的本地回复不能当作检索问题', true, 'microphone')
  h.say('那它呢？')
  h.api.requestHint()
  await flush()
  assert.equal(h.requests[1].query, '请解释线程池的拒绝策略\n那它呢？')
  h.api.clearConversation()
})

test('interleaved microphone revisions do not overwrite interviewer text or trigger/cancel hints', async () => {
  const h = harness()
  h.say('请解释线程池', false)
  h.say('我使用过线程池', false, 'microphone')
  h.say('请解释线程池的拒绝策略', true)
  await flush()
  h.say('我使用了自定义策略', true, 'microphone')
  await flush()
  const snap = h.handlers.get('conversation:get-snapshot')()
  assert.deepEqual(
    snap.utterances.map((u) => [u.source, u.text]),
    [
      ['system', '请解释线程池的拒绝策略'],
      ['microphone', '我使用了自定义策略']
    ]
  )
  assert.equal(h.requests.length, 1)
  assert.equal(snap.hints[0].status, 'done')
  h.api.clearConversation()
})

test('current long question stays complete, microphone-only manual submit cannot create a new hint', async () => {
  const h = harness({ conversationHintMode: 'manual' })
  h.say('我自己的陈述', true, 'microphone')
  h.api.requestHint()
  await flush()
  assert.equal(h.requests.length, 0)
  h.say('当前完整问题'.repeat(1000))
  h.api.requestHint()
  await flush()
  assert(h.requests[0].messages[0].content.includes('当前完整问题'.repeat(1000)))
  h.say('补充我的实际回答', true, 'microphone')
  h.api.requestHint()
  await flush()
  assert.equal(h.handlers.get('conversation:get-snapshot')().hints.length, 1)
  h.api.clearConversation()
})

test('context-disabled rewrite excludes previous AI draft, cached-summary request is nonblocking', async () => {
  const h = harness({ conversationContextEnabled: false })
  h.say('面试官的第一道问题')
  await flush()
  h.api.requestHint()
  await flush()
  assert(!h.requests[1].messages[0].content.includes('建议使用缓存'))
  h.api.clearConversation()
})

test('first text emits timing immediately, independently from reasoning and completion', async () => {
  const h = harness()
  h.say('请解释缓存一致性')
  await flush()
  const hints = h.sent.filter((x) => x[0] === 'conversation-hint').map((x) => x[1])
  assert(hints.some((c) => c.status === 'streaming' && typeof c.latencyMs === 'number'))
  assert(hints.some((c) => typeof c.speechLatencyMs === 'number'))
  h.api.clearConversation()
})

test('leading whitespace is retained but never counted as an answer first token', async () => {
  const h = harness({}, { whitespaceFirst: true })
  h.say('请解释缓存一致性')
  await flush()
  let card = h.handlers.get('conversation:get-snapshot')().hints[0]
  assert.equal(card.text, '\n\n')
  assert.equal(card.latencyMs, undefined)
  await new Promise((r) => setTimeout(r, 45))
  card = h.handlers.get('conversation:get-snapshot')().hints[0]
  assert(card.latencyMs >= 30)
  h.api.clearConversation()
})

test('manual rewrite includes actual self reply and all background shares one budget', async () => {
  const h = harness({ conversationContextTokenBudget: 100 })
  h.say('介绍你会怎么处理缓存')
  await flush()
  h.say('我实际使用数据库索引。'.repeat(100), true, 'microphone')
  h.api.requestHint()
  await flush()
  const content = h.requests.at(-1).messages[0].content
  assert(content.includes('我实际使用数据库索引'))
  const background = content.split('【对方刚才说的话】')[0]
  const estimate = require('./voice-load-source.cjs')()('src/shared/knowledge.ts').estimateTokens
  assert(estimate(background) <= 100)
  h.api.clearConversation()
})
