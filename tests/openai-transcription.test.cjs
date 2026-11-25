const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const loadSource = require('./load-source.cjs')

const VOICE = Buffer.alloc(3200)
for (let i = 0; i < VOICE.length; i += 2) VOICE.writeInt16LE(3000, i)
const SILENCE = Buffer.alloc(3200)
const PREFIX = 'conversation.item.input_audio_transcription.'

function harness(fetcher) {
  const sockets = [],
    events = [],
    handlers = new Map(),
    sentences = []
  class Socket extends EventEmitter {
    static OPEN = 1
    static CONNECTING = 0
    readyState = 1
    sent = []
    constructor(url, options) {
      super()
      this.url = url
      this.options = options
      sockets.push(this)
      queueMicrotask(() => this.emit('open'))
    }
    send(data) {
      const event = JSON.parse(data)
      this.sent.push(event)
      if (event.type === 'session.update')
        queueMicrotask(() => this.event({ type: 'session.updated' }))
    }
    event(event) {
      this.emit('message', Buffer.from(JSON.stringify(event)))
    }
    close() {
      this.readyState = 3
      this.emit('close')
    }
  }
  global.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (...args) => events.push(args) }
  }
  const api = loadSource('src/main/transcription.ts', {
    electron: {
      ipcMain: { handle: (k, v) => handlers.set(k, v), on: (k, v) => handlers.set(k, v) }
    },
    ws: Socket,
    './api-fetch': { apiFetch: fetcher }
  })
  api.onConversationSentence((...args) => sentences.push(args))
  const start = (provider, sources = ['system']) =>
    handlers.get('start-transcription')(null, 'test-key', {
      provider,
      purpose: 'conversation',
      sources,
      maxSentenceSilence: 200
    })
  const stop = () => handlers.get('stop-transcription')()
  function audio(source, buffer) {
    handlers.get('transcription-audio-chunk')(null, Uint8Array.from(buffer).buffer, source)
  }
  function turn(source) {
    audio(source, VOICE)
    audio(source, SILENCE)
    audio(source, SILENCE)
  }
  return { api, sockets, events, sentences, start, stop, audio, turn }
}

test('provider selection never reuses the other provider key', () => {
  const { voiceApiKey, normalizeTranscriptionProvider } = loadSource('src/shared/transcription.ts')
  const keys = { dashscopeApiKey: 'alibaba', openaiTranscriptionApiKey: ' openai ' }
  assert.equal(voiceApiKey(keys), 'alibaba')
  assert.equal(voiceApiKey({ ...keys, transcriptionProvider: 'openai-realtime' }), 'openai')
  assert.equal(voiceApiKey({ ...keys, transcriptionProvider: 'openai-whisper' }), 'openai')
  assert.equal(
    voiceApiKey({ dashscopeApiKey: 'alibaba', transcriptionProvider: 'openai-whisper' }),
    ''
  )
  assert.equal(normalizeTranscriptionProvider('unknown'), 'dashscope')
})

test('Realtime uses 24 kHz, streams partials and preserves final turn order per source', async () => {
  const h = harness()
  await h.start('openai-realtime', ['system', 'microphone'])
  const [system, mic] = h.sockets
  assert.equal(mic.url, 'wss://api.openai.com/v1/realtime?intent=transcription')
  assert.equal(mic.options.headers.Authorization, 'Bearer test-key')
  assert.equal(mic.sent[0].session.audio.input.format.rate, 24000)
  assert.equal(mic.sent[0].session.audio.input.transcription.model, 'gpt-live-transcribe')
  assert.equal(mic.sent[0].session.audio.input.turn_detection, null)
  h.audio('microphone', SILENCE)
  assert.equal(mic.sent.length, 1)
  h.turn('microphone')
  h.turn('microphone')
  assert.equal(system.sent.length, 1)
  assert.equal(Buffer.from(mic.sent[1].audio, 'base64').length, 4800)
  assert.equal(mic.sent.filter((e) => e.type === 'input_audio_buffer.commit').length, 2)
  mic.event({ type: PREFIX + 'delta', item_id: 'a', delta: 'First' })
  mic.event({ type: 'input_audio_buffer.committed', item_id: 'a' })
  mic.event({ type: 'input_audio_buffer.committed', item_id: 'b' })
  mic.event({ type: PREFIX + 'completed', item_id: 'b', transcript: 'Second.' })
  assert.deepEqual(h.sentences, [['First', false, 'microphone']])
  mic.event({ type: PREFIX + 'completed', item_id: 'a', transcript: 'First.' })
  assert.deepEqual(h.sentences, [
    ['First', false, 'microphone'],
    ['First.', true, 'microphone'],
    ['Second.', true, 'microphone']
  ])
  await h.stop()
  assert(h.sockets.every((s) => s.readyState === 3))
})

test('Realtime drains a final turn on stop', async () => {
  const h = harness()
  await h.start('openai-realtime')
  h.audio('system', VOICE)
  const stopping = h.stop()
  const socket = h.sockets[0]
  assert.equal(socket.sent.at(-1).type, 'input_audio_buffer.commit')
  socket.event({ type: 'input_audio_buffer.committed', item_id: 'tail' })
  socket.event({ type: PREFIX + 'completed', item_id: 'tail', transcript: 'Tail.' })
  await stopping
  assert.deepEqual(h.sentences, [['Tail.', true, 'system']])
})

test('Whisper uploads one 16 kHz WAV per speech turn and drains in order', async () => {
  const requests = []
  const h = harness(async (url, options) => {
    requests.push({ url, options })
    return new Response(JSON.stringify({ text: 'Question ' + requests.length }), { status: 200 })
  })
  await h.start('openai-whisper')
  h.audio('system', SILENCE)
  assert.equal(requests.length, 0)
  h.turn('system')
  h.audio('system', VOICE) // stop commits this incomplete turn as well
  await h.stop()
  assert.equal(h.sockets.length, 0)
  assert.equal(requests.length, 2)
  const { url, options } = requests[0]
  assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions')
  assert.equal(options.headers.Authorization, 'Bearer test-key')
  assert.equal(options.body.get('model'), 'whisper-1')
  const wav = Buffer.from(await options.body.get('file').arrayBuffer())
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.readUInt32LE(24), 16000)
  assert.equal(wav.readUInt16LE(22), 1)
  assert.equal(wav.readUInt32LE(40), wav.length - 44)
  assert.deepEqual(h.sentences, [
    ['Question 1', true, 'system'],
    ['Question 2', true, 'system']
  ])
})

test('OpenAI failure closes both sources and does not disclose server error text', async () => {
  const h = harness()
  await h.start('openai-realtime', ['system', 'microphone'])
  h.sockets[0].event({ type: 'error', error: { code: 'invalid_api_key', message: 'secret-key' } })
  assert(h.sockets.every((s) => s.readyState === 3))
  const error = h.events.find((e) => e[0] === 'transcription-error')[1]
  assert.match(error, /OpenAI API Key 无效/)
  assert(!error.includes('secret-key'))
})

test('Whisper request failure stops recognition without crashing', async () => {
  const h = harness(async () => new Response('private server message', { status: 429 }))
  const ended = new Promise((resolve) => h.api.onTranscriptionEnd(resolve))
  await h.start('openai-whisper')
  h.turn('system')
  await ended
  assert.equal(h.api.isTranscriptionRunning('conversation'), false)
  assert.match(h.events.find((e) => e[0] === 'transcription-error')[1], /额度或速率限制/)
})
