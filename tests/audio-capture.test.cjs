const { test } = require('node:test')
const assert = require('node:assert/strict')
const createLoader = require('./load-source.cjs').createLoader
function harness(micFails = false, settings = {}, actualDevice = () => '') {
  const streams = [],
    processors = [],
    sent = [],
    gains = [],
    requests = []
  function stream(kind) {
    const track = new EventTarget()
    track.kind = 'audio'
    track.stop = () => (track.stopped = true)
    track.getSettings = () => ({ deviceId: actualDevice(kind) })
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
        getUserMedia: async (options) => {
          requests.push(options)
          if (
            micFails &&
            (!options.audio.deviceId || options.audio.deviceId.exact !== 'virtual-cable')
          )
            throw new Error('mic denied')
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
      useSettingsStore: {
        getState: () => ({
          audioInputDeviceId: '',
          audioOutputDeviceId: '',
          conversationMicrophoneDeviceId: '',
          ...settings
        })
      }
    },
    '@/lib/utils/env': { isMac: false }
  })('src/renderer/src/lib/audio-capture.ts')
  return { api, streams, processors, sent, gains, requests }
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

test('default capture never requests the user microphone', async () => {
  const h = harness()
  assert.deepEqual(await h.api.startAudioCapture(), ['system'])
  assert.equal(h.requests.length, 0)
  h.api.stopAudioCapture()
})
test('selected virtual cable remains the interviewer source in single and dual modes', async () => {
  for (const mode of ['system', 'dual']) {
    const h = harness(false, {
      audioInputDeviceId: 'virtual-cable',
      conversationMicrophoneDeviceId: 'own-mic'
    })
    assert.deepEqual(
      await h.api.startAudioCapture({ mode }),
      mode === 'dual' ? ['system', 'microphone'] : ['system']
    )
    assert.equal(h.requests[0].audio.deviceId.exact, 'virtual-cable')
    assert.notEqual(h.requests[0].audio.echoCancellation, true)
    if (mode === 'dual') {
      assert.equal(h.requests[1].audio.deviceId.exact, 'own-mic')
      assert.equal(h.requests[1].audio.echoCancellation, true)
    }
    h.processors[0].onaudioprocess({
      inputBuffer: { getChannelData: () => new Float32Array([0.25]) }
    })
    assert.equal(h.sent[0][1], 'system')
    h.api.stopAudioCapture()
  }
})
test('a rejected own microphone releases the selected interviewer input', async () => {
  const h = harness(true, { audioInputDeviceId: 'virtual-cable' })
  await assert.rejects(h.api.startAudioCapture({ mode: 'dual' }), /mic denied/)
  assert(h.streams.every((s) => s.getTracks()[0].stopped))
})
test('the same explicitly selected device cannot be both speakers', async () => {
  const h = harness(false, {
    audioInputDeviceId: 'virtual-cable',
    conversationMicrophoneDeviceId: 'virtual-cable'
  })
  await assert.rejects(h.api.startAudioCapture({ mode: 'dual' }), /同一/)
  assert.equal(h.requests.length, 0)
})
test('microphone permission guidance does not point to screen recording', () => {
  const h = harness()
  const error = new Error('mic denied')
  error.source = 'microphone'
  const message = h.api.describeCaptureError('启动失败', error)
  assert.match(message, /麦克风/)
  assert.doesNotMatch(message, /屏幕/)
})

test('default microphone resolving to the selected interviewer device is rejected and both streams close', async () => {
  const h = harness(false, { audioInputDeviceId: 'virtual-cable' }, () => 'same-device')
  await assert.rejects(h.api.startAudioCapture({ mode: 'dual' }), /同一/)
  assert(h.streams.every((s) => s.getTracks()[0].stopped))
})

test('a capture permission result arriving after stop is released without starting a graph', async () => {
  const h = harness()
  const original = navigator.mediaDevices.getDisplayMedia
  let resolve
  navigator.mediaDevices.getDisplayMedia = () =>
    new Promise((r) => {
      resolve = r
    })
  const starting = h.api.startAudioCapture()
  h.api.stopAudioCapture()
  resolve(await original())
  await assert.rejects(starting, /取消/)
  assert(h.streams.every((s) => s.getTracks()[0].stopped))
  assert.equal(h.processors.length, 0)
})

test('selected interviewer input denied by getUserMedia points to microphone permissions', async () => {
  const h = harness(true, { audioInputDeviceId: 'denied-input' })
  await assert.rejects(h.api.startAudioCapture({ mode: 'system' }), (error) => {
    assert.match(h.api.describeCaptureError('录音失败', error), /麦克风/)
    return true
  })
})
