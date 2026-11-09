const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const React = require('react')
const load = require('./load-source.cjs')

for (const [established, cancel] of [
  [false, false],
  [false, true],
  [true, false]
])
  test(`switching from ${established ? 'listening' : 'partly started'} dual ASR ${cancel ? 'can cancel a queued screenshot start before retrying' : 'drains before opening screenshot capture'}`, async (t) => {
    t.mock.method(console, 'log', () => undefined)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const noop = () => undefined
    const handlers = new Map(),
      bus = new EventEmitter(),
      sockets = [],
      streams = [],
      order = []
    class Socket extends EventEmitter {
      static OPEN = 1
      static CONNECTING = 0
      readyState = 1
      constructor() {
        super()
        this.index = sockets.length
        sockets.push(this)
        queueMicrotask(() => this.emit('open'))
      }
      send(data) {
        if (typeof data !== 'string') return
        const action = JSON.parse(data).header.action
        // The first source starts, the second stays pending unless the conversation
        // is `established`; finish never answers, so a stop drains for the full 700ms.
        if (action === 'run-task' && (established || this.index !== 1))
          queueMicrotask(() =>
            this.emit('message', Buffer.from(JSON.stringify({ header: { event: 'task-started' } })))
          )
      }
      close() {
        this.readyState = 3
        this.emit('close')
      }
    }
    const state = {
      isTranscribing: false,
      setIsTranscribing(v) {
        state.isTranscribing = v
      },
      setTranscriptionText: noop,
      clearText: noop
    }
    const transcriptionStore = Object.assign(() => state, { getState: () => state })
    const settings = {
      dashscopeApiKey: 'test',
      conversationAudioMode: 'dual',
      conversationSilenceMs: 800,
      audioInputDeviceId: '',
      audioOutputDeviceId: '',
      conversationMicrophoneDeviceId: '',
      syncSettings: noop
    }
    const settingsStore = Object.assign((selector) => (selector ? selector(settings) : settings), {
      getState: () => settings
    })
    const previous = {
      window: global.window,
      navigator: global.navigator,
      AudioContext: global.AudioContext,
      MediaStream: global.MediaStream,
      mainWindow: global.mainWindow
    }
    t.after(() => Object.assign(global, previous))
    const stream = () => {
      const track = new EventTarget()
      track.stopped = false
      track.stop = () => {
        track.stopped = true
      }
      const value = {
        getAudioTracks: () => [track],
        getVideoTracks: () => [],
        getTracks: () => [track]
      }
      streams.push(value)
      order.push('capture-open')
      return value
    }
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      writable: true,
      value: {
        mediaDevices: { getDisplayMedia: async () => stream(), getUserMedia: async () => stream() }
      }
    })
    global.MediaStream = class {
      constructor(tracks) {
        this.getAudioTracks = () => tracks
      }
    }
    global.AudioContext = class {
      destination = {}
      createMediaStreamSource() {
        return { connect: noop }
      }
      createScriptProcessor() {
        return { connect: noop, disconnect: noop }
      }
      createGain() {
        return { gain: { value: 1 }, connect: noop }
      }
      close() {
        return Promise.resolve()
      }
    }
    global.mainWindow = {
      isDestroyed: () => false,
      webContents: {
        send: (channel, ...args) => {
          if (channel === 'transcription-stopped') order.push('old-asr-stopped')
          bus.emit(channel, ...args)
        }
      }
    }
    const main = load('src/main/transcription.ts', {
      electron: {
        ipcMain: { handle: (k, f) => handlers.set(k, f), on: (k, f) => handlers.set(k, f) }
      },
      ws: Socket
    })
    let toggle
    global.window = {
      api: new Proxy(
        {
          stopTranscription: () => handlers.get('stop-transcription')(),
          startTranscription: (key, options) =>
            handlers.get('start-transcription')(null, key, options),
          onTranscriptionStopped: (f) => bus.on('transcription-stopped', f),
          onToggleTranscription: (f) => {
            toggle = f
          }
        },
        { get: (api, key) => api[key] ?? (() => Promise.resolve({})) }
      )
    }
    const capture = load('src/renderer/src/lib/audio-capture.ts', {
      '@/lib/store/settings': { useSettingsStore: settingsStore },
      '@/lib/utils/env': { isMac: false }
    })
    const listening = load('src/renderer/src/conversation/listening.ts', {
      sonner: { toast: noop },
      '@/lib/store/settings': { useSettingsStore: settingsStore },
      '@/lib/store/transcription': { useTranscriptionStore: transcriptionStore },
      '@/lib/store/conversation': {
        useConversationStore: { getState: () => ({ setErrorMessage: noop }) }
      },
      '@/lib/audio-capture': capture
    })
    let effects = []
    const hooks = {
      ...React,
      useEffect: (f) => effects.push(f),
      useRef: (v) => ({ current: v }),
      useState: (v) => [v, noop]
    }
    const mocks = {
      react: hooks,
      sonner: { toast: noop, Toaster: noop },
      '@/lib/store/settings': { useSettingsStore: settingsStore },
      '@/lib/store/transcription': { useTranscriptionStore: transcriptionStore },
      '@/lib/store/solution': { useSolutionStore: () => ({ setErrorMessage: noop }) },
      '@/lib/audio-capture': capture,
      '@/conversation/listening': listening,
      '@/lib/use-mode-page': { useModePage: noop, MODE_PATHS: {} },
      '@/lib/store/shortcuts': { useShortcutsStore: () => ({ shortcuts: {} }) },
      '@/lib/store/app': { useAppStore: { getState: () => ({ setUpdate: noop }) } },
      '@/lib/utils': { getCloneableFields: () => ({}) },
      '@/lib/theme': { applyTheme: noop }
    }
    for (const id of ['@/coder', '@/conversation', '@/settings', '@/help'])
      mocks[id] = { default: noop }
    mocks['@/coder/OverlayToolbar'] = { OverlayToolbar: noop }
    mocks['@/components/WindowResizeHandles'] = { WindowResizeHandles: noop }
    load('src/renderer/src/App.tsx', mocks).default()
    effects.forEach((f) => f())
    const conversationStart = listening.startListening()
    const flush = () => new Promise((r) => setImmediate(r))
    await flush()
    assert.equal(sockets.length, 2)
    // Listening: a toggle during the drain must still read as a start
    assert.equal(state.isTranscribing, established)
    assert.equal(streams.length, 2)
    effects = []
    for (const name of [
      'AppHeader',
      'AppContent',
      'AppStatusBar',
      'PrerequisitesChecker',
      'SnipQuestionDialog',
      'TranscriptionBar'
    ])
      mocks['./' + name] = { [name]: noop }
    load('src/renderer/src/coder/index.tsx', mocks).default()
    effects.forEach((f) => f())
    const screenshotStart = toggle()
    await flush()
    const canceledStop = cancel ? toggle() : Promise.resolve()
    t.mock.timers.tick(700)
    await conversationStart
    await screenshotStart
    await canceledStop
    await flush()
    if (cancel) {
      assert.equal(streams.length, 2, 'a canceled request opened capture after its drain barrier')
      assert.equal(main.isTranscriptionRunning('screenshot'), false)
      assert.equal(state.isTranscribing, false)
      await toggle()
    }
    assert(main.isTranscriptionRunning('screenshot'))
    assert.equal(state.isTranscribing, true)
    assert.equal(streams.length, 3)
    assert.equal(
      streams[2].getTracks()[0].stopped,
      false,
      'new screenshot capture was closed by the old ASR stopped event'
    )
    assert(order.lastIndexOf('capture-open') > order.indexOf('old-asr-stopped'))
    const stopping = window.api.stopTranscription()
    t.mock.timers.tick(700)
    await stopping
    capture.stopAudioCapture()
  })
