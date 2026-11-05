const { test } = require('node:test')
const assert = require('node:assert/strict')
const createLoader = require('./voice-load-source.cjs')
function harness(micFails = false) {
  const streams = [],
    processors = [],
    sent = [],
    gains = []
  function stream(kind) {
    const track = new EventTarget()
    track.kind = 'audio'
    track.stop = () => (track.stopped = true)
    const s = {
      kind,
      getAudioTracks: () => [track],
      getVideoTracks: () => [],
      getTracks: () => [track]
    }
    streams.push(s)
    return s
  }
  Object.defineProperty(global, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getDisplayMedia: async () => stream('system'),
        getUserMedia: async () => {
          if (micFails) throw new Error('mic denied')
          return stream('microphone')
        }
      }
    }
  })
  global.MediaStream = class {
    constructor(tracks) {
      this.getAudioTracks = () => tracks
    }
  }
  global.AudioContext = class {
    destination = {}
    sampleRate = 16000
    createMediaStreamSource() {
      return {
        connect() {
          /* unused mock */
        },
        disconnect() {
          /* unused mock */
        }
      }
    }
    createScriptProcessor() {
      const p = {
        connect() {
          /* unused mock */
        },
        disconnect() {
          /* unused mock */
        }
      }
      processors.push(p)
      return p
    }
    createGain() {
      const g = {
        gain: { value: 1 },
        connect() {
          /* unused mock */
        },
        disconnect() {
          /* unused mock */
        }
      }
      gains.push(g)
      return g
    }
    close() {
      return Promise.resolve()
    }
  }
  global.window = {
    api: {
      sendTranscriptionAudioChunk: (...v) => sent.push(v),
      stopTranscription: async () => {
        /* unused mock */
      }
    }
  }
  const api = createLoader({
    '@/lib/store/settings': {
      useSettingsStore: { getState: () => ({ audioInputDeviceId: '', audioOutputDeviceId: '' }) }
    },
    '@/lib/utils/env': { isMac: false }
  })('src/renderer/src/lib/audio-capture.ts')
  return { api, streams, processors, sent, gains }
}
test('dual capture opens both sources, routes distinct PCM and mutes monitoring', async () => {
  const h = harness()
  const sources = await h.api.startAudioCapture({ mode: 'dual' })
  assert.deepEqual(sources, ['system', 'microphone'])
  assert.equal(h.processors.length, 2)
  h.processors.forEach((p) =>
    p.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array([0.25, -0.25]) } })
  )
  assert.deepEqual(
    h.sent.map((x) => x[1]),
    ['system', 'microphone']
  )
  assert(h.gains.every((g) => g.gain.value === 0))
  assert.equal(h.gains.length, 2)
  h.api.stopAudioCapture()
  assert(h.streams.every((s) => s.getTracks()[0].stopped))
})
test('microphone failure cleans the already-open system stream instead of pretending dual capture succeeded', async () => {
  const h = harness(true)
  await assert.rejects(h.api.startAudioCapture({ mode: 'dual' }), /mic denied/)
  assert(h.streams.every((s) => s.getTracks()[0].stopped))
})
