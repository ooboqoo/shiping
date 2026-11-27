import { ipcMain } from 'electron'
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import type { AudioSource } from '../shared/conversation'

const WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/'
const START_TIMEOUT_MS = 8000
const PING_INTERVAL_MS = 20_000
const PONG_TIMEOUT_MS = 10_000
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000]
/** ~4s of 16kHz mono 16-bit PCM (2048 samples ≈ 128ms per chunk) kept across startup or a brief reconnect */
const MAX_BUFFERED_CHUNKS = 32
/** ~16s of unsent PCM in the socket write buffer signals a stalled TCP connection */
const MAX_BUFFERED_AMOUNT = 512 * 1024

export type TranscriptionPurpose = 'screenshot' | 'conversation'
export interface TranscriptionOptions {
  /** Screenshot text or conversation sentences, without changing the other's text. */
  purpose?: TranscriptionPurpose
  /** Silence (ms) that ends a sentence; the recogniser's default (1300ms) when absent */
  maxSentenceSilence?: number
  sources?: AudioSource[]
}
interface Session {
  socket: WebSocket | null
  taskId: string
  source: AudioSource
  apiKey: string
  maxSentenceSilence?: number
  started: boolean
  /** True once initial startup succeeded; only established sessions auto-reconnect */
  everStarted: boolean
  buffered: Buffer[]
  /** Unfinalised partial text on this source, committed before reconnecting so a new task does not overwrite it */
  lastPartial: string
  reconnectAttempts: number
  startTimer?: ReturnType<typeof setTimeout>
  pingInterval?: ReturnType<typeof setInterval>
  pongTimer?: ReturnType<typeof setTimeout>
  reconnectTimer?: ReturnType<typeof setTimeout>
  resolveStart?: () => void
  rejectStart?: (error: Error) => void
  resolveStop?: () => void
}
const sessions = new Map<AudioSource, Session>()
let purpose: TranscriptionPurpose = 'screenshot'
let stopping = false
let lifecycle = 0
let stopPromise: Promise<void> | undefined
let accumulatedText = ''
let currentPartial = ''
const sentenceListeners = new Set<(text: string, final: boolean, source: AudioSource) => void>()
const startListeners = new Set<(purpose: TranscriptionPurpose) => void>()
const errorListeners = new Set<(message: string) => void>()
const endListeners = new Set<() => void>()
/** Recognition started, for screenshot text or conversation sentences. */
export function onTranscriptionStart(listener: (purpose: TranscriptionPurpose) => void): void {
  startListeners.add(listener)
}
/** Recognition failed; it is reported stopped right after. */
export function onTranscriptionError(listener: (message: string) => void): void {
  errorListeners.add(listener)
}
export function onConversationSentence(
  listener: (text: string, final: boolean, source: AudioSource) => void
): void {
  sentenceListeners.add(listener)
}
export function onTranscriptionEnd(listener: () => void): void {
  endListeners.add(listener)
}
export function isTranscriptionRunning(wanted: TranscriptionPurpose): boolean {
  return sessions.size > 0 && purpose === wanted
}
function send(channel: string, ...args: unknown[]) {
  const window = global.mainWindow
  if (window && !window.isDestroyed()) window.webContents.send(channel, ...args)
}
function clearKeepalive(session: Session) {
  if (session.pingInterval) {
    clearInterval(session.pingInterval)
    session.pingInterval = undefined
  }
  if (session.pongTimer) {
    clearTimeout(session.pongTimer)
    session.pongTimer = undefined
  }
}
function clearSessionTimers(session: Session) {
  if (session.startTimer) {
    clearTimeout(session.startTimer)
    session.startTimer = undefined
  }
  clearKeepalive(session)
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer)
    session.reconnectTimer = undefined
  }
}
function detachSocket(session: Session, force = false) {
  clearKeepalive(session)
  if (session.startTimer) {
    clearTimeout(session.startTimer)
    session.startTimer = undefined
  }
  const socket = session.socket
  session.socket = null
  session.started = false
  if (!socket) return
  socket.removeAllListeners()
  // ws emits an asynchronous error when close() cancels a pending handshake.
  // This session is detached: consume shutdown errors without affecting a new start.
  socket.on('error', () => undefined)
  if (force && typeof socket.terminate === 'function') {
    socket.terminate()
  } else if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close()
  }
}
function cleanup() {
  for (const session of sessions.values()) {
    clearSessionTimers(session)
    session.rejectStart?.(new Error('语音识别已停止'))
    session.resolveStart = undefined
    session.rejectStart = undefined
    session.resolveStop?.()
    session.resolveStop = undefined
    detachSocket(session)
  }
  sessions.clear()
}
function reportStopped() {
  send('transcription-stopped')
  endListeners.forEach((listener) => listener())
}
/** A failure from `ws` / Node (`code` like `ENOTFOUND`), or a `task-failed` event's code and message */
type AsrFailure = Error & { code?: string }

const NETWORK_CODES =
  /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE)$|CERT|SSL|TLS/
const RETRYABLE_NETWORK_CODES =
  /^(ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|EPIPE)$/
const NON_RETRYABLE_PATTERNS =
  /InvalidApiKey|Invalid API-?key|Arrearage|AccessDenied|good standing|Throttling/i
const RETRYABLE_FAILURE_PATTERNS =
  /(?:request\s+)?timeout|timed[\s-]*out|idle|heartbeat|disconnect|internal|server.?error|service.?unavailable|connection.*(?:closed|reset|lost|broken)/i

/** Whether a mid-session error is transient and worth reconnecting this source on its own */
function isRecoverableError(error: AsrFailure | string): boolean {
  if (typeof error === 'string') return true
  const status = /Unexpected server response: (\d+)/.exec(error.message)?.[1]
  if (status) return /^5\d\d$/.test(status)
  const said = `${error.code ?? ''} ${error.message}`
  if (NON_RETRYABLE_PATTERNS.test(said)) return false
  if (error.code && /CERT|SSL|TLS|ENOTFOUND/.test(error.code)) return false
  if (error.code && RETRYABLE_NETWORK_CODES.test(error.code)) return true
  return RETRYABLE_FAILURE_PATTERNS.test(said)
}

/**
 * A failure in words the user can act on, with the recogniser's own code (or
 * HTTP status) in brackets for anyone searching it. `shared` failures (the key,
 * the account, the network) hit every source alike, so they name none; the
 * others start with 语音识别, which `fail()` may prefix with the source
 */
function describeFailure(error: AsrFailure): { message: string; shared: boolean } {
  const status = /Unexpected server response: (\d+)/.exec(error.message)?.[1]
  const code = error.code ?? (status ? `HTTP ${status}` : undefined)
  const said = `${error.code ?? ''} ${error.message}`
  const detail = `（${code ?? error.message}）`
  if (status === '401' || /InvalidApiKey|Invalid API-?key/i.test(said))
    return { message: `百炼平台 API Key 无效，请到「设置 → 语音」重新填写${detail}`, shared: true }
  if (status === '403' || /Arrearage|AccessDenied|good standing/i.test(said))
    return {
      message: `百炼平台拒绝了语音识别，请到百炼控制台确认账户没有欠费、能使用 Fun-ASR 实时语音识别${detail}`,
      shared: true
    }
  if (status === '429' || /Throttling/i.test(said))
    return { message: `百炼平台的语音识别请求太频繁，请稍后再开始监听${detail}`, shared: true }
  if (error.code === 'ETIMEDOUT')
    return { message: `连接百炼平台超时，请检查网络${detail}`, shared: true }
  if (error.code && NETWORK_CODES.test(error.code))
    return { message: `连不上百炼平台，请检查网络${detail}`, shared: true }
  if (/(?:request\s+)?timeout|timed[\s-]*out/i.test(said))
    return { message: `语音识别连接超时，请检查网络或重新开始监听${detail}`, shared: false }
  if (status) return { message: `百炼平台语音识别连接失败${detail}`, shared: true }
  return {
    message: `语音识别失败：${error.message}${error.code ? `（${error.code}）` : ''}`,
    shared: false
  }
}

function sourcePrefix(session: Session): string {
  if (sessions.size <= 1) return ''
  return session.source === 'microphone' ? '麦克风' : '对方音源'
}

/** Flush any unfinalised text before a source reconnects so the new ASR task starts a fresh sentence */
function commitOpenPartial(session: Session) {
  if (purpose === 'conversation') {
    const text = session.lastPartial
    session.lastPartial = ''
    if (text.trim()) sentenceListeners.forEach((listener) => listener(text, true, session.source))
  } else if (currentPartial) {
    accumulatedText += currentPartial
    currentPartial = ''
  }
}

/**
 * `error` is a recogniser / connection failure to describe, or a message of
 * ours (starting with 语音识别) as it is
 */
function fail(session: Session, error: AsrFailure | string) {
  if (sessions.get(session.source) !== session) return
  const { message: text, shared } =
    typeof error === 'string' ? { message: error, shared: false } : describeFailure(error)
  // Name the source only when two are running; 截图模式 and single-source listening have one
  const prefix = shared ? '' : sourcePrefix(session)
  const message = prefix ? `${prefix}的${text}` : text
  // The same words for a start still waiting on it (the page shows that one)
  session.rejectStart?.(new Error(message))
  session.resolveStart = undefined
  session.rejectStart = undefined
  if (stopping) {
    session.resolveStop?.()
    return
  }
  send('transcription-error', message)
  errorListeners.forEach((listener) => listener(message))
  cleanup()
  reportStopped()
}

/**
 * Reconnect only the failed source on transient mid-session disconnects/timeouts;
 * fatal errors or exhausted retries fall through to `fail()`.
 */
function handleFailure(session: Session, error: AsrFailure | string, forceClose = false) {
  if (sessions.get(session.source) !== session) return
  if (stopping) {
    session.resolveStop?.()
    return
  }
  if (
    session.everStarted &&
    isRecoverableError(error) &&
    session.reconnectAttempts < RECONNECT_DELAYS_MS.length
  ) {
    const delay = RECONNECT_DELAYS_MS[session.reconnectAttempts]
    session.reconnectAttempts++
    detachSocket(session, forceClose)
    commitOpenPartial(session)
    if (session.reconnectAttempts === 1 && purpose === 'conversation') {
      const prefix = sourcePrefix(session)
      send('conversation-notice', `${prefix ? `${prefix}的` : ''}语音识别连接波动，正在自动重连…`)
    }
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = undefined
      if (stopping || sessions.get(session.source) !== session) return
      openSocket(session)
    }, delay)
    session.reconnectTimer.unref?.()
    return
  }
  fail(session, error)
}

function startKeepalive(session: Session, socket: WebSocket) {
  clearKeepalive(session)
  if (typeof socket.ping !== 'function') return
  session.pingInterval = setInterval(() => {
    if (stopping || sessions.get(session.source) !== session || session.socket !== socket) {
      clearKeepalive(session)
      return
    }
    if (socket.readyState !== WebSocket.OPEN) return
    if (session.pongTimer) return
    session.pongTimer = setTimeout(() => {
      session.pongTimer = undefined
      if (stopping || sessions.get(session.source) !== session || session.socket !== socket) return
      handleFailure(session, '语音识别连接超时，请重新开始监听', true)
    }, PONG_TIMEOUT_MS)
    session.pongTimer.unref?.()
    try {
      socket.ping()
    } catch (error) {
      handleFailure(session, error instanceof Error ? error : new Error(String(error)), true)
    }
  }, PING_INTERVAL_MS)
  session.pingInterval.unref?.()
}

function openSocket(session: Session) {
  detachSocket(session)
  const { source } = session
  const socket = new WebSocket(WS_URL, { headers: { Authorization: `bearer ${session.apiKey}` } })
  session.socket = socket
  session.taskId = randomUUID()
  session.started = false
  session.startTimer = setTimeout(() => {
    session.startTimer = undefined
    if (sessions.get(source) !== session || session.socket !== socket) return
    handleFailure(session, Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), true)
  }, START_TIMEOUT_MS)
  session.startTimer.unref?.()

  const markAlive = () => {
    if (session.pongTimer) {
      clearTimeout(session.pongTimer)
      session.pongTimer = undefined
    }
  }

  socket.on('open', () => {
    if (sessions.get(source) !== session || session.socket !== socket) return
    socket.send(
      JSON.stringify({
        header: { action: 'run-task', task_id: session.taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task: 'asr',
          function: 'recognition',
          model: 'fun-asr-realtime',
          parameters: {
            format: 'pcm',
            sample_rate: 16000,
            heartbeat: true,
            ...(session.maxSentenceSilence
              ? {
                  max_sentence_silence: Math.min(
                    // The recogniser accepts 200–6000ms
                    6000,
                    Math.max(200, session.maxSentenceSilence)
                  )
                }
              : {})
          },
          input: {}
        }
      })
    )
  })
  socket.on('pong', () => {
    if (sessions.get(source) !== session || session.socket !== socket) return
    markAlive()
  })
  socket.on('message', (data: WebSocket.Data) => {
    if (sessions.get(source) !== session || session.socket !== socket) return
    markAlive()
    try {
      const message = JSON.parse(data.toString())
      const event = message.header?.event
      if (event === 'task-started') {
        if (session.startTimer) {
          clearTimeout(session.startTimer)
          session.startTimer = undefined
        }
        const recovered = session.everStarted && session.reconnectAttempts > 0
        session.started = true
        session.everStarted = true
        session.reconnectAttempts = 0
        const queued = session.buffered
        session.buffered = []
        for (const chunk of queued) {
          if (socket.readyState !== WebSocket.OPEN) break
          socket.send(chunk)
        }
        startKeepalive(session, socket)
        session.resolveStart?.()
        session.resolveStart = undefined
        session.rejectStart = undefined
        if (recovered && purpose === 'conversation') {
          const prefix = sourcePrefix(session)
          send('conversation-notice', `${prefix ? `${prefix}的` : ''}语音识别已自动恢复`)
        }
      } else if (event === 'result-generated') {
        const sentence = message.payload?.output?.sentence
        if (!sentence || sentence.heartbeat) return
        const text: string = sentence.text || ''
        const final = sentence.sentence_end === true
        if (purpose === 'conversation') {
          session.lastPartial = final ? '' : text
          sentenceListeners.forEach((listener) => listener(text, final, source))
        } else {
          if (final) {
            accumulatedText += text
            currentPartial = ''
          } else currentPartial = text
          send('transcription-text', { text: getTranscriptionText(), isPartial: !final })
        }
      } else if (event === 'task-failed') {
        handleFailure(
          session,
          Object.assign(new Error(message.header?.error_message || '未知错误'), {
            code: message.header?.error_code || undefined
          })
        )
      } else if (event === 'task-finished') {
        if (stopping) session.resolveStop?.()
        else handleFailure(session, '语音识别连接已结束，请重新开始监听')
      }
    } catch (error) {
      console.error('Failed to parse transcription message:', error)
    }
  })
  socket.on('error', (error) => {
    if (sessions.get(source) !== session || session.socket !== socket) return
    handleFailure(session, error)
  })
  socket.on('close', () => {
    if (sessions.get(source) !== session || session.socket !== socket) return
    if (stopping) session.resolveStop?.()
    else handleFailure(session, '语音识别连接中断，请重新开始监听')
  })
}

async function startTranscription(apiKey: string, options: TranscriptionOptions = {}) {
  stopping = false
  purpose = options.purpose ?? 'screenshot'
  const sources: AudioSource[] =
    purpose === 'conversation'
      ? [...new Set<AudioSource>(options.sources ?? ['system'])]
      : ['system']
  if (!sources.length || sources.some((source) => source !== 'system' && source !== 'microphone'))
    throw new Error('无效的录音来源')
  const owned = new Set<Session>()
  try {
    await Promise.all(
      sources.map(
        (source) =>
          new Promise<void>((resolve, reject) => {
            const session: Session = {
              socket: null,
              taskId: '',
              source,
              apiKey,
              maxSentenceSilence: options.maxSentenceSilence,
              started: false,
              everStarted: false,
              buffered: [],
              lastPartial: '',
              reconnectAttempts: 0,
              resolveStart: resolve,
              rejectStart: reject
            }
            owned.add(session)
            sessions.set(source, session)
            openSocket(session)
          })
      )
    )
    startListeners.forEach((listener) => listener(purpose))
  } catch (error) {
    if ([...owned].some((session) => sessions.get(session.source) === session)) {
      cleanup()
      reportStopped()
    }
    throw error
  }
}
function stopTranscription(): Promise<void> {
  if (stopPromise) return stopPromise
  if (!sessions.size) return Promise.resolve()
  stopPromise = (async () => {
    stopping = true
    await Promise.all(
      [...sessions.values()].map(
        (session) =>
          new Promise<void>((resolve) => {
            clearSessionTimers(session)
            const timeout = setTimeout(resolve, 700)
            session.resolveStop = () => {
              clearTimeout(timeout)
              resolve()
            }
            if (session.started && session.socket?.readyState === WebSocket.OPEN)
              session.socket.send(
                JSON.stringify({
                  header: { action: 'finish-task', task_id: session.taskId, streaming: 'duplex' },
                  payload: { input: {} }
                })
              )
            else session.resolveStop()
          })
      )
    )
    cleanup()
    stopping = false
    reportStopped()
  })().finally(() => {
    stopPromise = undefined
  })
  return stopPromise
}
async function requestStart(key: string, options?: TranscriptionOptions): Promise<void> {
  const request = ++lifecycle
  await stopTranscription()
  if (request !== lifecycle) throw new Error('录音启动已取消')
  await startTranscription(key, options)
  if (request !== lifecycle) throw new Error('录音启动已取消')
}
function requestStop(): Promise<void> {
  lifecycle++
  return stopTranscription()
}

function handleAudioChunk(chunk: ArrayBuffer, source: AudioSource = 'system') {
  if (stopping) return
  const session = sessions.get(source)
  if (!session) return
  const buffer = Buffer.from(chunk)
  const socket = session.socket
  if (session.started && socket && socket.readyState === WebSocket.OPEN) {
    if (typeof socket.bufferedAmount === 'number' && socket.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      handleFailure(session, '语音识别连接超时，请重新开始监听', true)
      return
    }
    try {
      socket.send(buffer, (error) => {
        if (error && sessions.get(source) === session && session.socket === socket) {
          handleFailure(session, error, true)
        }
      })
    } catch (error) {
      handleFailure(session, error instanceof Error ? error : new Error(String(error)), true)
    }
  } else {
    session.buffered.push(buffer)
    if (session.buffered.length > MAX_BUFFERED_CHUNKS) session.buffered.shift()
  }
}
export function getTranscriptionText(): string {
  return accumulatedText + currentPartial
}
export function clearTranscriptionText() {
  accumulatedText = ''
  currentPartial = ''
}
ipcMain.handle('start-transcription', (_event, key: string, options?: TranscriptionOptions) =>
  requestStart(key, options)
)
ipcMain.handle('stop-transcription', () => requestStop())
ipcMain.on('transcription-audio-chunk', (_event, chunk: ArrayBuffer, source?: AudioSource) =>
  handleAudioChunk(chunk, source)
)
ipcMain.handle('get-transcription-text', () => getTranscriptionText())
ipcMain.handle('clear-transcription-text', () => clearTranscriptionText())
