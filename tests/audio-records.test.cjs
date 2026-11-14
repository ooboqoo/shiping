const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const load = require('./load-source.cjs')

const startedAt = new Date(2026, 10, 8, 9, 5).getTime()
const format = load('src/main/save-conversation.ts', { './settings': {} }).formatConversation
test('legacy and single-system Markdown retain the exact original bytes', () => {
  for (const source of [undefined, 'system']) {
    assert.equal(
      format({
        startedAt,
        utterances: [{ id: 1, text: '第一句\n第二行', final: true, source }],
        hints: []
      }),
      '# 对话记录 2026-11-08 09:05\n\n**对方**\n\n> 第一句 第二行\n'
    )
  }
})
test('mixed-source Markdown identifies actual self speech and preserves order', () => {
  const text = format({
    startedAt,
    utterances: [
      { id: 1, text: '问题', final: true, source: 'system' },
      { id: 2, text: '实际回答', final: true, source: 'microphone' },
      { id: 3, text: '追问', final: true, source: 'system' }
    ],
    hints: []
  })
  assert.match(text, /> 对方：问题\n>\n> 我（实际回答）：实际回答\n>\n> 对方：追问/)
})

function phone() {
  const nodes = new Map()
  const node = () => ({
    dataset: {},
    classList: {
      toggle() {
        /* unused mock */
      }
    },
    setAttribute() {
      /* unused mock */
    },
    addEventListener() {
      /* unused mock */
    },
    querySelectorAll: () => [],
    lastElementChild: {},
    innerHTML: '',
    scrollHeight: 100
  })
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, node())
    return nodes.get(id)
  }
  const context = {
    URLSearchParams,
    URL,
    location: { hash: '#t=test', href: 'http://localhost/', protocol: 'http:' },
    localStorage: {
      getItem: () => null,
      setItem() {
        /* unused mock */
      }
    },
    document: {
      getElementById: get,
      documentElement: node(),
      querySelectorAll: () => [],
      addEventListener() {
        /* unused mock */
      },
      visibilityState: 'visible'
    },
    window: { isSecureContext: false },
    navigator: {},
    marked: {
      use() {
        /* unused mock */
      },
      parse: (x) => x
    },
    hljs: {},
    addEventListener() {
      /* unused mock */
    },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (f) => f(),
    innerHeight: 500,
    scrollY: 0,
    scrollTo() {
      /* unused mock */
    },
    scrollBy() {
      /* unused mock */
    },
    fetch: async () => ({ status: 200 }),
    WebSocket: class {
      constructor() {
        context.socket = this
      }
    }
  }
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../relay/public/app.js'), 'utf8'),
    context
  )
  return {
    nodes,
    context,
    async state(utterances) {
      await new Promise((r) => setImmediate(r))
      context.socket.onmessage({
        data: JSON.stringify({
          type: 'state',
          data: { mode: 'conversation', conversation: { utterances, hints: [] } }
        })
      })
      return get('hints').innerHTML
    }
  }
}
test('phone keeps legacy all-system rendering and escapes/source-labels mixed speech', async () => {
  const h = phone()
  const legacy = await h.state([{ id: 1, text: '原文', final: true }])
  assert.match(legacy, /<div class="who">对方<\/div><div class="bubble"><p>原文<\/p>/)
  const mixed = await h.state([
    { id: 1, text: '问题', final: true, source: 'system' },
    { id: 2, text: '我说<script>', final: false, source: 'microphone' }
  ])
  assert.match(mixed, /我（实际回答）/)
  assert.match(mixed, /我说&lt;script&gt;/)
  assert.doesNotMatch(mixed, /我说<script>/)
})

test('desktop transcript identifies own speech separately from the other side', () => {
  const utterances = [
    { id: 1, text: '对方问题', final: true, source: 'system' },
    { id: 2, text: '自己的实际回答', final: true, source: 'microphone' }
  ]
  const { TranscriptPanel } = load('src/renderer/src/conversation/TranscriptPanel.tsx', {
    '@/lib/utils': { cn: (...xs) => xs.filter(Boolean).join(' ') },
    '@/components/ScrollPanel': {
      // eslint-disable-next-line react/prop-types -- test stand-in
      ScrollPanel: ({ children }) => React.createElement('div', null, children)
    },
    '@/lib/store/settings': {
      useSettingsStore: (f) =>
        f({
          updateSetting() {
            /* unused mock */
          }
        })
    },
    '@/lib/store/transcription': { useTranscriptionStore: (f) => f({ isTranscribing: true }) },
    '@/lib/store/conversation': { useConversationStore: (f) => f({ utterances, hints: [] }) }
  })
  const html = renderToStaticMarkup(React.createElement(TranscriptPanel))
  assert.match(html, /我（实际回答）/)
  assert.match(html, /对方：/)
})

test('fresh and persisted settings keep microphone capture opt-in and distinct input IDs', () => {
  const saved = new Map()
  global.localStorage = {
    getItem: (k) => saved.get(k) ?? null,
    setItem: (k, v) => saved.set(k, v),
    removeItem: (k) => saved.delete(k)
  }
  try {
    let store = load('src/renderer/src/lib/store/settings.ts').useSettingsStore
    assert.equal(store.getState().conversationAudioMode, 'system')
    assert.equal(store.getState().conversationMicrophoneDeviceId, '')
    store.getState().updateSetting('audioInputDeviceId', 'virtual-cable')
    store.getState().updateSetting('conversationMicrophoneDeviceId', 'own-mic')
    store.getState().updateSetting('conversationAudioMode', 'dual')
    store = load('src/renderer/src/lib/store/settings.ts').useSettingsStore
    assert.equal(store.getState().conversationAudioMode, 'dual')
    assert.equal(store.getState().audioInputDeviceId, 'virtual-cable')
    assert.equal(store.getState().conversationMicrophoneDeviceId, 'own-mic')
    // Real raw prompts must survive default-import interop so rehydrate does not
    // silently discard the saved store when composing its scene prompts.
    store.getState().updateSetting('apiKey', 'saved-fixture-key')
    store.getState().updateSetting('stealthEnabled', false)
    const restarted = load('src/renderer/src/lib/store/settings.ts')
    assert.equal(typeof restarted.PRESET_SCENE_PROMPTS.coding, 'string')
    assert.equal(restarted.useSettingsStore.getState().apiKey, 'saved-fixture-key')
    assert.equal(restarted.useSettingsStore.getState().stealthEnabled, false)
  } finally {
    delete global.localStorage
  }
})
