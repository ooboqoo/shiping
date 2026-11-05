const { test } = require('node:test')
const assert = require('node:assert/strict')
const createLoader = require('./voice-load-source.cjs')
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
