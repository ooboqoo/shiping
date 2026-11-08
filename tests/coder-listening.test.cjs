const { test } = require('node:test')
const assert = require('node:assert/strict')
const React = require('react')
const load = require('./load-source.cjs')

test('screenshot toggle cancels a pending capture without starting recognition afterward', async () => {
  const effects = []
  let toggle,
    resolveCapture,
    captures = 0,
    starts = 0,
    stops = 0
  const state = {
    isTranscribing: false,
    setIsTranscribing(v) {
      state.isTranscribing = v
    },
    setTranscriptionText() {
      /* unused mock */
    },
    clearText() {
      /* unused mock */
    }
  }
  const store = Object.assign(() => state, { getState: () => state })
  global.window = {
    api: {
      onToggleTranscription: (f) => {
        toggle = f
      },
      removeToggleTranscriptionListener() {
        /* unused mock */
      },
      startTranscription: async () => {
        starts++
      },
      stopTranscription: async () => {
        stops++
      },
      onTranscriptionText() {
        /* unused mock */
      },
      onTranscriptionError() {
        /* unused mock */
      },
      onTranscriptionStopped() {
        /* unused mock */
      },
      onTranscriptionCleared() {
        /* unused mock */
      },
      removeTranscriptionTextListener() {
        /* unused mock */
      },
      removeTranscriptionErrorListener() {
        /* unused mock */
      },
      removeTranscriptionStoppedListener() {
        /* unused mock */
      },
      removeTranscriptionClearedListener() {
        /* unused mock */
      }
    }
  }
  const mocks = {
    react: { ...React, useEffect: (f) => effects.push(f), useRef: (v) => ({ current: v }) },
    '@/lib/store/settings': { useSettingsStore: () => ({ dashscopeApiKey: 'test' }) },
    '@/conversation/listening': {
      stopListening() {
        /* unused mock */
      }
    },
    '@/lib/store/transcription': { useTranscriptionStore: store },
    '@/lib/store/solution': {
      useSolutionStore: () => ({
        setErrorMessage() {
          /* unused mock */
        }
      })
    },
    '@/lib/audio-capture': {
      startAudioCapture: () =>
        ++captures === 1
          ? new Promise((r) => {
              resolveCapture = r
            })
          : Promise.resolve(['system']),
      stopAudioCapture() {
        /* unused mock */
      },
      describeCaptureError: String
    },
    '@/lib/use-mode-page': {
      useModePage() {
        /* unused mock */
      }
    }
  }
  for (const name of [
    'AppHeader',
    'AppContent',
    'AppStatusBar',
    'PrerequisitesChecker',
    'SnipQuestionDialog',
    'TranscriptionBar'
  ])
    mocks['./' + name] = { [name]: () => null }
  load('src/renderer/src/coder/index.tsx', mocks).default()
  effects.forEach((f) => f())
  const first = toggle()
  await new Promise((r) => setImmediate(r))
  await toggle()
  resolveCapture(['system'])
  await first
  assert.equal(starts, 0)
  assert.equal(stops, 1)
  assert.equal(state.isTranscribing, false)
})
