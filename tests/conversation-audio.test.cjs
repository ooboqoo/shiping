const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./load-source.cjs')

function harness(t, extra = {}) {
  const handlers = new Map(),
    requests = [],
    memos = [],
    events = []
  let sentence, end, mobile
  const settings = {
    conversationHintMode: 'auto',
    conversationMinChars: 4,
    conversationSilenceMs: 800,
    ...extra
  }
  const api = load('src/main/conversation.ts', {
    electron: {
      app: {
        on() {
          /* unused mock */
        }
      },
      ipcMain: { handle: (k, f) => handlers.set(k, f) }
    },
    './settings': {
      settings,
      getModeProfile: () => ({ apiKey: 'test' }),
      onSettingsChanged() {
        /* unused mock */
      }
    },
    './save-conversation': {
      saveConversation: async () => {},
      saveConversationSync() {
        /* unused mock */
      }
    },
    './mobile-sync': {
      markMobileDirty() {
        /* unused mock */
      },
      registerMobileSource: (_k, f) => {
        mobile = f
      }
    },
    './transcription': {
      isTranscriptionRunning: () => true,
      onConversationSentence: (f) => {
        sentence = f
      },
      onTranscriptionEnd: (f) => {
        end = f
      },
      onTranscriptionStart() {
        /* unused mock */
      },
      onTranscriptionError() {
        /* unused mock */
      }
    },
    './ai': {
      getHintStream: (messages, signal, query) => {
        requests.push({ messages, signal, query })
        return 'hint'
      },
      getMemoStream: (system, prompt) => {
        memos.push({ system, prompt })
        return 'memo'
      }
    },
    './stream': {
      extractErrorMessage: String,
      consumeStream: async (factory, controller, onChunk) => {
        const kind = factory(controller.signal)
        if (kind === 'memo') return { status: 'complete', text: '备忘' }
        onChunk({ kind: 'text', delta: '建议' })
        return { status: 'complete', text: '建议' }
      }
    }
  })
  global.mainWindow = { isDestroyed: () => false, webContents: { send: (...x) => events.push(x) } }
  t.after(() => api.clearConversation())
  return {
    api,
    requests,
    memos,
    events,
    say: sentence,
    stop: () => end(),
    snapshot: () => handlers.get('conversation:get-snapshot')(),
    mobile: () => mobile()
  }
}
const flush = () => new Promise((r) => setImmediate(r))

test('interleaved revisions keep independent speakers and own speech never triggers or cancels hints', async (t) => {
  const h = harness(t)
  h.say('请解释线程池', false, 'system')
  h.say('我的回答', false, 'microphone')
  h.say('请解释线程池的拒绝策略', true, 'system')
  await flush()
  h.say('我使用自定义策略', true, 'microphone')
  await flush()
  assert.deepEqual(
    h.snapshot().utterances.map((u) => [u.source, u.text, u.final]),
    [
      ['system', '请解释线程池的拒绝策略', true],
      ['microphone', '我使用自定义策略', true]
    ]
  )
  assert.equal(h.requests.length, 1)
  assert.equal(h.snapshot().hints[0].status, 'done')
})

test('own speech stays out of the current question and short-query fallback', async (t) => {
  const h = harness(t, { conversationHintMode: 'manual' })
  h.say('请解释线程池的拒绝策略', true, 'system')
  h.api.requestHint()
  await flush()
  h.say('我自己的实际回答', true, 'microphone')
  h.say('那它呢？', true, 'system')
  h.api.requestHint()
  await flush()
  assert.equal(h.requests[1].query, '请解释线程池的拒绝策略\n那它呢？')
  const current = h.requests[1].messages[0].content.split('【对方刚才说的话】')[1]
  assert.doesNotMatch(current, /我自己的实际回答/)
})

test('own microphone alone cannot create a manual hint', async (t) => {
  const h = harness(t)
  h.say('我自己的陈述', true, 'microphone')
  h.api.requestHint()
  await flush()
  assert.equal(h.requests.length, 0)
})

test('stopping a waiting hint includes the latest open interviewer sentence even when microphone is last', async (t) => {
  const h = harness(t)
  h.say('解释一下线程池', true, 'system')
  // Keep this stream unsettled, as it would be while the model is writing.
  h.say('还要讲讲线程池的拒绝策略', false, 'system')
  h.say('我还没有说完', false, 'microphone')
  assert.equal(h.snapshot().hints[0].status, 'waiting')
  h.stop()
  await flush()
  assert.equal(h.requests.length, 2)
  assert.match(h.requests[1].query, /还要讲讲线程池的拒绝策略/)
  assert.doesNotMatch(h.requests[1].query, /我还没有说完/)
  assert(h.snapshot().utterances.every((u) => u.final))
})

test('a final interviewer sentence drained before stop submits a waiting hint once', async (t) => {
  const h = harness(t)
  h.say('解释一下线程池', true, 'system')
  h.say('还要讲讲拒绝策略', false, 'system')
  h.say('我的回答', false, 'microphone')
  h.say('还要讲讲拒绝策略', true, 'system')
  h.stop()
  await flush()
  assert.equal(h.requests.length, 2)
})

test('memo and mobile preserve actual self speech labels', async (t) => {
  const h = harness(t, { conversationHintMode: 'manual' })
  h.say('我的经历是自己实现了调度器', true, 'microphone')
  for (let i = 0; i < 15; i++) h.say('对方问题编号' + i, true, 'system')
  await flush()
  assert(h.memos.length)
  assert.match(h.memos[0].prompt, /我（实际回答）：我的经历是自己实现了调度器/)
  assert.doesNotMatch(h.memos[0].prompt, /对方：我的经历/)
  assert.equal(h.mobile().utterances[0].source, 'microphone')
})

test('memo waits for an older open microphone sentence before folding later dialogue', async (t) => {
  const h = harness(t, { conversationHintMode: 'manual' })
  h.say('我还在修订的实际回答', false, 'microphone')
  for (let i = 0; i < 15; i++) h.say('对方问题编号' + i, true, 'system')
  await flush()
  assert.equal(h.memos.length, 0)
  h.say('我的完整实际回答', true, 'microphone')
  await flush()
  assert.match(h.memos[0].prompt, /我（实际回答）：我的完整实际回答/)
  assert.doesNotMatch(h.memos[0].prompt, /还在修订/)
})

test('own answers within the new range share the existing raw history window', async (t) => {
  const h = harness(t, { conversationHintMode: 'manual' })
  for (let i = 0; i < 30; i++) h.say(`我已回答${i}，${'细节'.repeat(30)}`, true, 'microphone')
  h.say('现在请解释线程池', true, 'system')
  h.api.requestHint()
  await flush()
  const content = h.requests.at(-1).messages[0].content
  assert.doesNotMatch(content, /我已回答0，/)
  assert.match(content, /我（实际回答）：我已回答29/)
  assert.match(content, /【对方刚才说的话】\n现在请解释线程池/)
})

test('manual rewrite can use the actual self reply without turning it into the question', async (t) => {
  const h = harness(t, { conversationHintMode: 'manual' })
  h.say('请解释线程池的拒绝策略', true, 'system')
  h.api.requestHint()
  await flush()
  h.say('我实际使用了自定义拒绝策略', true, 'microphone')
  h.api.requestHint()
  await flush()
  const request = h.requests.at(-1)
  assert.match(request.messages[0].content, /我（实际回答）：我实际使用了自定义拒绝策略/)
  assert.equal(request.query, '请解释线程池的拒绝策略')
  assert.equal(h.snapshot().hints.length, 1)
})
