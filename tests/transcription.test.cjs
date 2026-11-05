const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const createLoader = require('./voice-load-source.cjs')

test('canceling real CONNECTING sockets safely handles the ws close error', () => {
  const { spawnSync } = require('node:child_process')
  const path = require('node:path')
  // An unhandled socket error must fail a child, not terminate this test runner.
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
      const assert = require('node:assert/strict')
      const http = require('node:http')
      const WebSocket = require('ws')
      const createLoader = require('./tests/voice-load-source.cjs')
      ;(async () => {
        const connections = new Set(), handlers = new Map()
        let bothConnected
        const connected = new Promise(resolve => { bothConnected = resolve })
        const server = http.createServer()
        server.on('upgrade', (_request, socket) => {
          connections.add(socket)
          if (connections.size === 2) bothConnected()
        })
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        class Socket extends WebSocket {
          constructor() { super('ws://127.0.0.1:' + server.address().port) }
        }
        const api = createLoader({
          electron: { ipcMain: {
            handle: (key, handler) => handlers.set(key, handler),
            on: (key, handler) => handlers.set(key, handler)
          } },
          ws: Socket
        })('src/main/transcription.ts')
        const starting = handlers.get('start-transcription')(null, 'test', {
          purpose: 'conversation', sources: ['system', 'microphone']
        }).then(() => { throw new Error('canceled startup unexpectedly succeeded') }, error => error)
        await connected
        await handlers.get('stop-transcription')()
        assert((await starting) instanceof Error)
        await new Promise(resolve => setTimeout(resolve, 30))
        assert.equal(api.isTranscriptionRunning('conversation'), false)
        for (const socket of connections) socket.destroy()
        await new Promise(resolve => server.close(resolve))
      })().catch(error => { console.error(error); process.exit(1) })
      `
    ],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 5000, windowsHide: true }
  )
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
})

function harness(delayStop = false) {
  const sockets = [],
    handlers = new Map(),
    messages = []
  class Socket extends EventEmitter {
    static OPEN = 1
    static CONNECTING = 0
    readyState = 1
    sent = []
    constructor() {
      super()
      sockets.push(this)
      queueMicrotask(() => this.emit('open'))
    }
    send(data) {
      this.sent.push(data)
      if (typeof data === 'string') {
        const m = JSON.parse(data)
        if (m.header.action === 'run-task')
          queueMicrotask(() =>
            this.emit('message', Buffer.from(JSON.stringify({ header: { event: 'task-started' } })))
          )
        if (m.header.action === 'finish-task' && !delayStop)
          queueMicrotask(() => {
            this.emit(
              'message',
              Buffer.from(
                JSON.stringify({
                  header: { event: 'result-generated' },
                  payload: { output: { sentence: { text: '尾句', sentence_end: true } } }
                })
              )
            )
            this.emit(
              'message',
              Buffer.from(JSON.stringify({ header: { event: 'task-finished' } }))
            )
          })
      }
    }
    close() {
      this.readyState = 3
      this.emit('close')
    }
  }
  global.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (...v) => messages.push(v) }
  }
  const api = createLoader({
    electron: {
      ipcMain: { handle: (k, v) => handlers.set(k, v), on: (k, v) => handlers.set(k, v) }
    },
    ws: Socket
  })('src/main/transcription.ts')
  return { api, sockets, handlers, messages }
}
test('two independent sessions tag transcripts, route PCM and drain final sentences on stop', async () => {
  const h = harness(),
    sentences = []
  h.api.onConversationSentence((...v) => sentences.push(v))
  await h.handlers.get('start-transcription')(null, 'test', {
    purpose: 'conversation',
    sources: ['system', 'microphone']
  })
  assert.equal(h.sockets.length, 2)
  h.handlers.get('transcription-audio-chunk')(null, new Uint8Array([1, 2]).buffer, 'microphone')
  assert(!h.sockets[0].sent.some(Buffer.isBuffer))
  assert(h.sockets[1].sent.some(Buffer.isBuffer))
  for (const socket of h.sockets)
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          header: { event: 'result-generated' },
          payload: { output: { sentence: { text: '识别', sentence_end: true } } }
        })
      )
    )
  assert.deepEqual(
    sentences.map((x) => x[2]),
    ['system', 'microphone']
  )
  await h.handlers.get('stop-transcription')()
  assert.equal(sentences.filter((x) => x[0] === '尾句').length, 2)
  assert(!h.api.isTranscriptionRunning('conversation'))
})

test('new start waits for a draining old session and creates the requested purpose', async () => {
  const h = harness(true)
  await h.handlers.get('start-transcription')(null, 'test', {
    purpose: 'conversation',
    sources: ['system', 'microphone']
  })
  const stopping = h.handlers.get('stop-transcription')()
  const starting = h.handlers.get('start-transcription')(null, 'test', { purpose: 'screenshot' })
  for (const s of h.sockets.slice(0, 2))
    s.emit('message', Buffer.from(JSON.stringify({ header: { event: 'task-finished' } })))
  await stopping
  await starting
  assert.equal(h.sockets.length, 3)
  assert(h.api.isTranscriptionRunning('screenshot'))
  h.sockets[2].emit('message', Buffer.from(JSON.stringify({ header: { event: 'task-finished' } })))
})
