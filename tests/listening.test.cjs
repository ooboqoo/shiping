const { test } = require('node:test')
const assert = require('node:assert/strict')
const createLoader = require('./load-source.cjs').createLoader

for (const phase of ['capture', 'asr']) {
  test(`${phase} startup failure uses the correct guidance`, async (t) => {
    t.mock.method(console, 'error', () => {})
    const errors = []
    const state = {
      setIsTranscribing() {
        /* unused mock */
      }
    }
    global.window = {
      api: {
        stopTranscription: async () => {},
        startTranscription: async () => {
          if (phase === 'asr') throw new Error('InvalidApiKey')
        }
      }
    }
    const api = createLoader({
      sonner: {
        toast() {
          /* unused mock */
        }
      },
      '@/lib/store/settings': {
        useSettingsStore: {
          getState: () => ({ dashscopeApiKey: 'test', conversationAudioMode: 'system' })
        }
      },
      '@/lib/store/transcription': { useTranscriptionStore: { getState: () => state } },
      '@/lib/store/conversation': {
        useConversationStore: { getState: () => ({ setErrorMessage: (e) => errors.push(e) }) }
      },
      '@/lib/audio-capture': {
        startAudioCapture: async () => {
          if (phase === 'capture') throw new Error('permission')
          return ['system']
        },
        stopAudioCapture() {
          /* unused mock */
        },
        describeCaptureError: () => 'screen recording permission guidance'
      }
    })('src/renderer/src/conversation/listening.ts')
    await api.startListening()
    if (phase === 'asr') {
      assert.match(errors.at(-1), /InvalidApiKey/)
      assert.doesNotMatch(errors.at(-1), /screen recording/)
    } else assert.equal(errors.at(-1), 'screen recording permission guidance')
  })
}
test('canceling an in-flight capture cannot stop or mark a newer start as failed', async () => {
  let finishCapture,
    openCount = 0,
    closeCount = 0,
    asrStarts = 0
  const state = {
    isTranscribing: false,
    setIsTranscribing(value) {
      state.isTranscribing = value
    }
  }
  const errors = []
  global.window = {
    api: {
      stopTranscription: async () => {
        /* unused mock */
      },
      startTranscription: async () => asrStarts++
    }
  }
  const api = createLoader({
    sonner: {
      toast() {
        /* unused mock */
      }
    },
    '@/lib/store/settings': {
      useSettingsStore: {
        getState: () => ({
          dashscopeApiKey: 'test',
          conversationAudioMode: 'dual',
          conversationSilenceMs: 800
        })
      }
    },
    '@/lib/store/transcription': { useTranscriptionStore: { getState: () => state } },
    '@/lib/store/conversation': {
      useConversationStore: { getState: () => ({ setErrorMessage: (e) => errors.push(e) }) }
    },
    '@/lib/audio-capture': {
      startAudioCapture: () => {
        openCount++
        return openCount === 1
          ? new Promise((r) => (finishCapture = r))
          : Promise.resolve(['system', 'microphone'])
      },
      stopAudioCapture: () => closeCount++,
      describeCaptureError: () => 'failed'
    }
  })('src/renderer/src/conversation/listening.ts')
  const first = api.startListening()
  await new Promise((r) => setTimeout(r, 0))
  await api.stopListening()
  const second = api.startListening()
  await second
  finishCapture(['system', 'microphone'])
  await first
  assert.equal(asrStarts, 1)
  assert.equal(closeCount, 1)
  assert.equal(state.isTranscribing, true)
  assert(!errors.includes('failed'))
})
