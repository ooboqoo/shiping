const { test } = require('node:test')
const assert = require('node:assert/strict')
const createLoader = require('./voice-load-source.cjs')
test('first answer text reaches the renderer store without waiting for an animation frame', () => {
  const callbacks = {},
    frames = []
  const state = {
    hints: [{ id: 1, text: '', status: 'streaming' }],
    applySnapshot() {
      /* unused mock */
    },
    upsertHint() {
      /* unused mock */
    },
    upsertUtterance() {
      /* unused mock */
    },
    removeUtterance() {
      /* unused mock */
    },
    clear() {
      /* unused mock */
    },
    appendHintText(chunks) {
      for (const h of state.hints) if (chunks.has(h.id)) h.text += chunks.get(h.id)
    }
  }
  const settings = (fn) => fn({ conversationTranscriptHidden: false })
  const transcription = { getState: () => ({ isTranscribing: false }) }
  global.window = {
    requestAnimationFrame: (cb) => {
      frames.push(cb)
      return frames.length
    },
    cancelAnimationFrame() {
      /* unused mock */
    },
    api: new Proxy(
      { getConversationSnapshot: async () => ({ utterances: [], hints: [] }) },
      { get: (obj, key) => obj[key] || ((cb) => (callbacks[key] = cb)) }
    )
  }
  const page = createLoader({
    react: { useEffect: (fn) => fn(), useRef: (value) => ({ current: value }) },
    sonner: {
      toast() {
        /* unused mock */
      }
    },
    '@/lib/store/settings': { useSettingsStore: settings },
    '@/lib/store/transcription': { useTranscriptionStore: transcription },
    '@/lib/store/conversation': { useConversationStore: { getState: () => state } },
    '@/lib/audio-capture': {
      stopAudioCapture() {
        /* unused mock */
      }
    },
    '@/lib/use-mode-page': {
      useModePage() {
        /* unused mock */
      }
    },
    '@/coder/AppHeader': {
      AppHeader() {
        /* unused mock */
      }
    },
    '@/coder/PrerequisitesChecker': {
      PrerequisitesChecker() {
        /* unused mock */
      }
    },
    './TranscriptPanel': {
      TranscriptPanel() {
        /* unused mock */
      }
    },
    './HintPanel': {
      HintPanel() {
        /* unused mock */
      }
    },
    './ConversationStatusBar': {
      ConversationStatusBar() {
        /* unused mock */
      }
    },
    './listening': {
      toggleHintMode() {
        /* unused mock */
      },
      toggleListening() {
        /* unused mock */
      }
    }
  })('src/renderer/src/conversation/index.tsx').default
  page()
  callbacks.onConversationHintChunk(1, '第一句结论')
  assert.equal(state.hints[0].text, '第一句结论')
  callbacks.onConversationHintChunk(1, '，随后解释')
  assert.equal(state.hints[0].text, '第一句结论')
  frames.at(-1)()
  assert.equal(state.hints[0].text, '第一句结论，随后解释')
})
