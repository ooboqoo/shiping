const { test } = require('node:test')
const assert = require('node:assert/strict')
const loadSource = require('./load-source.cjs')

function mainHarness(t, overrides = {}) {
  const handlers = new Map()
  const requests = []
  const events = []
  let sentence
  let ended
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  const sender = { send: (...args) => events.push(args) }
  const oldWindow = global.mainWindow
  global.mainWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    getOpacity: () => 1,
    isMinimized: () => false,
    webContents: sender
  }
  t.after(() => {
    global.mainWindow = oldWindow
  })
  const main = loadSource('src/main/conversation.ts', {
    electron: {
      app: {
        on() {
          /* unused mock */
        }
      },
      ipcMain: { handle: (id, fn) => handlers.set(id, fn) }
    },
    './settings': {
      settings: {
        conversationHintMode: 'auto',
        conversationMinChars: 1,
        conversationSilenceMs: 800,
        ...overrides
      },
      getModeProfile: () => ({ apiKey: 'test' }),
      onSettingsChanged() {
        /* unused mock */
      }
    },
    './ai': {
      getHintStream() {
        /* unused mock */
      },
      getMemoStream() {
        /* unused mock */
      },
      getPrewarmStream() {
        /* unused mock */
      }
    },
    './stream': {
      consumeStream: (_create, controller, onChunk) =>
        new Promise((resolve) => {
          requests.push({ controller, onChunk, resolve })
        }),
      extractErrorMessage: String
    },
    './save-conversation': {
      saveConversation() {
        /* unused mock */
      },
      saveConversationSync() {
        /* unused mock */
      }
    },
    './transcription': {
      isTranscriptionRunning: () => false,
      onConversationSentence: (fn) => {
        sentence = fn
      },
      onTranscriptionEnd: (fn) => {
        ended = fn
      },
      onTranscriptionError() {
        /* unused mock */
      },
      onTranscriptionStart() {
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
    }
  })
  const snapshot = () => handlers.get('conversation:get-snapshot')()
  return {
    main,
    requests,
    events,
    sender,
    snapshot,
    sentence: (...args) => sentence(...args),
    end: () => ended(),
    at: (time) => {
      now = time
    },
    ack: (...args) => handlers.get('conversation:first-visible')({ sender }, ...args),
    rawAck: (...args) => handlers.get('conversation:first-visible')(...args)
  }
}

function rendererHarness(t) {
  const callbacks = {}
  const frames = new Map()
  const cleanups = []
  let nextFrame = 0
  const { useConversationStore } = loadSource('src/renderer/src/lib/store/conversation.ts')
  useConversationStore.getState().upsertHint({ id: 1, text: '', status: 'streaming' })
  const originalWindow = global.window
  global.window = {
    requestAnimationFrame: (fn) => {
      frames.set(++nextFrame, fn)
      return nextFrame
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    api: new Proxy(
      {
        getConversationSnapshot: () =>
          new Promise(() => {
            /* unused mock */
          })
      },
      {
        get: (obj, key) =>
          obj[key] ||
          ((fn) => {
            callbacks[key] = fn
          })
      }
    )
  }
  t.after(() => {
    cleanups.forEach((fn) => fn())
    global.window = originalWindow
  })
  const noop = () => {
    /* unused mock */
  }
  const page = loadSource('src/renderer/src/conversation/index.tsx', {
    react: {
      useEffect: (fn) => {
        const cleanup = fn()
        if (cleanup) cleanups.push(cleanup)
      },
      useRef: (value) => ({ current: value })
    },
    sonner: { toast: noop },
    '@/lib/store/conversation': { useConversationStore },
    '@/lib/store/settings': { useSettingsStore: (fn) => fn({}) },
    '@/lib/store/transcription': { useTranscriptionStore: { getState: () => ({}) } },
    '@/lib/audio-capture': { stopAudioCapture: noop },
    '@/lib/use-mode-page': { useModePage: noop },
    '@/coder/AppHeader': { AppHeader: noop },
    '@/coder/PrerequisitesChecker': { PrerequisitesChecker: noop },
    './TranscriptPanel': { TranscriptPanel: noop },
    './HintPanel': { HintPanel: noop },
    './ConversationStatusBar': { ConversationStatusBar: noop },
    './listening': { toggleHintMode: noop, toggleListening: noop }
  }).default
  page()
  return {
    callbacks,
    state: useConversationStore.getState,
    flush() {
      const scheduled = [...frames.values()]
      frames.clear()
      scheduled.forEach((fn) => fn())
    }
  }
}

test('first meaningful answer reaches the real renderer store before rAF, later text is batched', (t) => {
  const h = rendererHarness(t)
  h.callbacks.onConversationHintChunk(1, '  ')
  h.callbacks.onConversationHintChunk(1, '**')
  h.callbacks.onConversationHintChunk(1, '结论')
  assert.equal(h.state().hints[0].text, '  **结论')
  h.callbacks.onConversationHintChunk(1, '，解释')
  assert.equal(h.state().hints[0].text, '  **结论')
  h.flush()
  assert.equal(h.state().hints[0].text, '  **结论，解释')
})

test('renderer discards pending chunks when a rewrite snapshot or clear arrives', (t) => {
  const h = rendererHarness(t)
  h.callbacks.onConversationHintChunk(1, '旧答案')
  h.callbacks.onConversationHintChunk(1, '旧尾巴')
  h.callbacks.onConversationHint({ id: 1, text: '', status: 'streaming' })
  h.callbacks.onConversationHintChunk(1, '新答案')
  assert.equal(h.state().hints[0].text, '新答案')
  h.flush()
  assert.equal(h.state().hints[0].text, '新答案')
  h.callbacks.onConversationHintChunk(1, '清空前尾巴')
  h.callbacks.onConversationCleared()
  h.callbacks.onConversationHint({ id: 1, text: '', status: 'streaming' })
  h.flush()
  assert.equal(h.state().hints[0].text, '')
})

test('reasoning, empty text, whitespace and Markdown markers do not start first-text timing', (t) => {
  const h = mainHarness(t)
  h.sentence('为什么使用缓存？', true)
  h.at(1100)
  const request = h.requests[0]
  for (const chunk of [
    { kind: 'reasoning', delta: '推理' },
    { kind: 'text', delta: '' },
    { kind: 'text', delta: '\n **' }
  ])
    request.onChunk(chunk)
  assert.equal(h.snapshot().hints[0].latencyMs, undefined)
  assert.equal(h.snapshot().hints[0].firstTextAt, undefined)
  h.at(1300)
  request.onChunk({ kind: 'text', delta: '降低延迟' })
  const card = h.snapshot().hints[0]
  assert.equal(card.requestedAt, 1000)
  assert.equal(card.firstTextAt, 1300)
  assert.equal(card.latencyMs, 300)
  assert.equal(card.speechLatencyMs, 300)
  assert.equal(
    h.events.filter(([channel]) => channel === 'conversation-hint').at(-1)[1].firstTextAt,
    1300
  )
})

test('first-visible validates sender, numeric payload and request identity; accepts one acknowledgement', (t) => {
  const h = mainHarness(t)
  h.sentence('解释一下缓存', true)
  const initial = h.snapshot().hints[0]
  h.ack(initial.id, initial.requestedAt, initial.requestId)
  assert.equal(h.snapshot().hints[0].visibleLatencyMs, undefined)
  h.at(1300)
  h.requests[0].onChunk({ kind: 'text', delta: '结论' })
  const card = h.snapshot().hints[0]
  h.at(1400)
  for (const args of [
    [card.id, NaN, card.requestId],
    [String(card.id), card.requestedAt, card.requestId],
    [card.id, card.requestedAt, card.requestId + 1]
  ])
    h.ack(...args)
  h.rawAck({ sender: {} }, card.id, card.requestedAt, card.requestId)
  assert.equal(h.snapshot().hints[0].visibleLatencyMs, undefined)
  global.mainWindow.getOpacity = () => 0
  h.ack(card.id, card.requestedAt, card.requestId)
  assert.equal(
    h.snapshot().hints[0].visibleLatencyMs,
    undefined,
    'Windows soft-hide is not visible'
  )
  global.mainWindow.getOpacity = () => 1
  h.ack(card.id, card.requestedAt, card.requestId)
  assert.equal(h.snapshot().hints[0].visibleLatencyMs, 400)
  h.at(1500)
  h.ack(card.id, card.requestedAt, card.requestId)
  assert.equal(h.snapshot().hints[0].visibleLatencyMs, 400)
})

test('same-millisecond rewrites and clear/id reuse reject stale visibility and old stream callbacks', async (t) => {
  const h = mainHarness(t)
  h.sentence('介绍一下缓存', true)
  const first = h.requests[0]
  first.onChunk({ kind: 'text', delta: '旧答案' })
  const old = h.snapshot().hints[0]
  first.resolve({ status: 'complete', text: '旧答案' })
  await Promise.resolve()
  h.main.requestHint()
  first.onChunk({ kind: 'text', delta: '迟到的内容' })
  h.ack(old.id, old.requestedAt, old.requestId)
  let card = h.snapshot().hints[0]
  assert.equal(card.text, '')
  assert.equal(card.firstTextAt, undefined)
  assert.equal(card.visibleLatencyMs, undefined)
  h.requests[1].onChunk({ kind: 'text', delta: '新答案' })
  h.ack(old.id, old.requestedAt, old.requestId)
  assert.equal(h.snapshot().hints[0].visibleLatencyMs, undefined)
  h.main.clearConversation()
  h.sentence('第二个问题', true)
  h.requests[2].onChunk({ kind: 'text', delta: '清空后的答案' })
  h.ack(old.id, old.requestedAt, old.requestId)
  card = h.snapshot().hints[0]
  assert.equal(card.id, old.id)
  assert.equal(card.visibleLatencyMs, undefined)
})

test('a withdrawn hint clears first-text metrics and rejects acknowledgements', (t) => {
  const h = mainHarness(t)
  h.sentence('介绍一下缓存', true)
  h.at(1200)
  h.requests[0].onChunk({ kind: 'text', delta: '结论' })
  const old = h.snapshot().hints[0]
  h.sentence('还有一个补充问题', false)
  h.ack(old.id, old.requestedAt, old.requestId)
  assert.equal(h.snapshot().hints[0].status, 'waiting')
  assert.equal(h.snapshot().hints[0].firstTextAt, undefined)
  assert.equal(h.snapshot().hints[0].visibleLatencyMs, undefined)
})

test('visible acknowledgement waits for a frame in view, retries soft-hide and cancels obsolete frames', async (t) => {
  const frames = new Map()
  const listeners = new Map()
  let nextFrame = 0
  let observer
  let visible = false
  let calls = 0
  let accepted = true
  const previous = {
    window: global.window,
    document: global.document,
    IntersectionObserver: global.IntersectionObserver
  }
  global.window = {
    innerWidth: 800,
    innerHeight: 600,
    requestAnimationFrame: (fn) => {
      frames.set(++nextFrame, fn)
      return nextFrame
    },
    cancelAnimationFrame: (id) => frames.delete(id)
  }
  global.document = {
    visibilityState: 'visible',
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name)
  }
  global.IntersectionObserver = class {
    constructor(fn) {
      observer = fn
    }
    observe() {
      /* unused mock */
    }
    disconnect() {
      /* unused mock */
    }
  }
  t.after(() => Object.assign(global, previous))
  const element = {
    isConnected: true,
    getBoundingClientRect: () => ({
      top: visible ? 10 : 700,
      bottom: visible ? 100 : 800,
      left: 0,
      right: 200
    }),
    closest: () => ({ getBoundingClientRect: () => ({ top: 0, bottom: 400, left: 0, right: 800 }) })
  }
  const flush = () => {
    const jobs = [...frames.values()]
    frames.clear()
    jobs.forEach((fn) => fn())
  }
  const { observeHintVisible } = loadSource('src/renderer/src/conversation/hint-visibility.ts')
  const report = () => {
    calls++
    return accepted
  }
  const cleanup = observeHintVisible(element, report)
  flush()
  flush()
  assert.equal(calls, 0, 'offscreen answers must not count')
  visible = true
  global.document.visibilityState = 'hidden'
  observer()
  flush()
  flush()
  assert.equal(calls, 0, 'background documents must not count')
  global.document.visibilityState = 'visible'
  listeners.get('visibilitychange')()
  flush()
  assert.equal(calls, 0, 'one rAF is before paint')
  flush()
  assert.equal(calls, 1)
  observer()
  flush()
  flush()
  assert.equal(calls, 1, 'only the first visible frame counts')
  cleanup()
  const cancel = observeHintVisible(element, report)
  flush()
  cancel()
  flush()
  assert.equal(calls, 1, 'an obsolete request cannot acknowledge a later frame')
  const timers = new Map()
  let nextTimer = 0
  t.mock.method(global, 'setTimeout', (fn) => {
    timers.set(++nextTimer, fn)
    return nextTimer
  })
  t.mock.method(global, 'clearTimeout', (id) => timers.delete(id))
  accepted = false
  const retryCleanup = observeHintVisible(element, report)
  flush()
  flush()
  await Promise.resolve()
  assert.equal(calls, 2)
  assert.equal(timers.size, 1, 'main can reject a soft-hidden window despite visible DOM')
  accepted = true
  const retry = [...timers.values()][0]
  timers.clear()
  retry()
  flush()
  flush()
  await Promise.resolve()
  assert.equal(calls, 3, 'restoring the window allows another visible-frame acknowledgement')
  assert.equal(timers.size, 0)
  retryCleanup()
})

test('HintPanel renders timing in protected DOM without native tooltip attributes', () => {
  const noop = () => {
    /* unused mock */
  }
  const card = {
    id: 1,
    fromId: 1,
    toId: 1,
    status: 'done',
    source: 'auto',
    text: '结论',
    reasoning: '',
    latencyMs: 300,
    speechLatencyMs: 500,
    visibleLatencyMs: 400
  }
  const state = { hints: [card], utterances: [], setFocusedHintId: noop }
  const { HintPanel } = loadSource('src/renderer/src/conversation/HintPanel.tsx', {
    react: { useEffect: noop, useRef: (value) => ({ current: value }) },
    'react-router': { useNavigate: noop },
    'lucide-react': new Proxy({}, { get: () => noop }),
    '@/lib/utils': { cn: (...args) => args.filter(Boolean).join(' ') },
    '@/components/ui/button': { Button: noop },
    '@/components/MarkdownRenderer': { default: noop },
    '@/components/ShortcutRenderer': { default: noop },
    '@/lib/store/settings': { useSettingsStore: (fn) => fn({}) },
    '@/lib/store/shortcuts': { useShortcutsStore: noop },
    '@/lib/store/transcription': { useTranscriptionStore: noop },
    '@/lib/store/conversation': { useConversationStore: (fn) => fn(state) },
    './listening': { startListening: noop }
  })
  const nodes = []
  function visit(node) {
    if (node == null || typeof node === 'boolean') return
    if (Array.isArray(node)) return node.forEach(visit)
    if (typeof node !== 'object') {
      nodes.push(String(node))
      return
    }
    assert.equal(Object.hasOwn(node.props, 'title'), false)
    if (typeof node.type === 'function' && node.type.name === 'HintCardView')
      visit(node.type(node.props))
    else visit(node.props.children)
  }
  visit(HintPanel())
  const text = nodes.join('')
  assert.match(text, /首字.*0\.3s/)
  assert.match(text, /语音.*0\.5s/)
  assert.match(text, /上屏.*0\.4s/)
})

test('speech latency starts at recognised sentence receipt, separately from a later manual request', (t) => {
  const h = mainHarness(t, { conversationHintMode: 'manual' })
  h.sentence('解释一下缓存', true)
  h.at(1500)
  h.main.requestHint()
  h.at(1800)
  h.requests[0].onChunk({ kind: 'text', delta: '结论' })
  const card = h.snapshot().hints[0]
  assert.equal(card.latencyMs, 300)
  assert.equal(card.speechLatencyMs, 800)
})

test('manual hints on unfinished speech use the latest revision as the timing baseline', (t) => {
  const h = mainHarness(t, { conversationHintMode: 'manual' })
  h.sentence('缓存', false)
  h.at(1200)
  h.sentence('缓存有什么作用', false)
  h.at(1400)
  h.main.requestHint()
  h.at(1600)
  h.requests[0].onChunk({ kind: 'text', delta: '结论' })
  assert.equal(h.snapshot().hints[0].latencyMs, 200)
  assert.equal(h.snapshot().hints[0].speechLatencyMs, 400)
})
