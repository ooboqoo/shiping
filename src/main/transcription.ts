import { ipcMain } from 'electron'
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import type { AudioSource } from '../shared/conversation'

const WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/'
export type TranscriptionPurpose = 'screenshot' | 'conversation'
export interface TranscriptionOptions {
  /** Screenshot text or conversation sentences, without changing the other's text. */
  purpose?: TranscriptionPurpose
  /** Silence (ms) that ends a sentence; the recogniser's default (1300ms) when absent */
  maxSentenceSilence?: number
  sources?: AudioSource[]
}
interface Session {
  socket: WebSocket
  taskId: string
  source: AudioSource
  started: boolean
  buffered: Buffer[]
  resolveStart: () => void
  rejectStart: (error: Error) => void
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
function cleanup() {
  for (const session of sessions.values()) {
    session.rejectStart(new Error('语音识别已停止'))
    session.resolveStop?.()
    session.socket.removeAllListeners()
    // ws emits an asynchronous error when close() cancels a pending handshake.
    // This session is detached: consume shutdown errors without affecting a new start.
    session.socket.on('error', () => undefined)
    if (
      session.socket.readyState === WebSocket.OPEN ||
      session.socket.readyState === WebSocket.CONNECTING
    )
      session.socket.close()
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
  if (status) return { message: `百炼平台语音识别连接失败${detail}`, shared: true }
  return {
    message: `语音识别失败：${error.message}${error.code ? `（${error.code}）` : ''}`,
    shared: false
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
  const message =
    sessions.size > 1 && !shared
      ? `${session.source === 'microphone' ? '麦克风' : '对方音源'}的${text}`
      : text
  // The same words for a start still waiting on it (the page shows that one)
  session.rejectStart(new Error(message))
  if (stopping) {
    session.resolveStop?.()
    return
  }
  send('transcription-error', message)
  errorListeners.forEach((listener) => listener(message))
  cleanup()
  reportStopped()
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
            const socket = new WebSocket(WS_URL, { headers: { Authorization: `bearer ${apiKey}` } })
            const timeout = setTimeout(
              () => fail(session, Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
              8000
            )
            const session: Session = {
              socket,
              taskId: randomUUID(),
              source,
              started: false,
              buffered: [],
              resolveStart: () => {
                clearTimeout(timeout)
                resolve()
              },
              rejectStart: (error) => {
                clearTimeout(timeout)
                reject(error)
              }
            }
            owned.add(session)
            sessions.set(source, session)
            socket.on('open', () => {
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
                      ...(options.maxSentenceSilence
                        ? {
                            max_sentence_silence: Math.min(
                              // The recogniser accepts 200–6000ms
                              6000,
                              Math.max(200, options.maxSentenceSilence)
                            )
                          }
                        : {})
                    },
                    input: {}
                  }
                })
              )
            })
            socket.on('message', (data: WebSocket.Data) => {
              if (sessions.get(source) !== session) return
              try {
                const message = JSON.parse(data.toString())
                const event = message.header?.event
                if (event === 'task-started') {
                  session.started = true
                  session.buffered.forEach((chunk) => socket.send(chunk))
                  session.buffered = []
                  session.resolveStart()
                } else if (event === 'result-generated') {
                  const sentence = message.payload?.output?.sentence
                  if (!sentence) return
                  const text: string = sentence.text || ''
                  const final = sentence.sentence_end === true
                  if (purpose === 'conversation')
                    sentenceListeners.forEach((listener) => listener(text, final, source))
                  else {
                    if (final) {
                      accumulatedText += text
                      currentPartial = ''
                    } else currentPartial = text
                    send('transcription-text', { text: getTranscriptionText(), isPartial: !final })
                  }
                } else if (event === 'task-failed')
                  fail(
                    session,
                    Object.assign(new Error(message.header?.error_message || '未知错误'), {
                      code: message.header?.error_code || undefined
                    })
                  )
                else if (event === 'task-finished') {
                  if (stopping) session.resolveStop?.()
                  else fail(session, '语音识别连接已结束，请重新开始监听')
                }
              } catch (error) {
                console.error('Failed to parse transcription message:', error)
              }
            })
            socket.on('error', (error) => fail(session, error))
            socket.on('close', () => {
              if (stopping) session.resolveStop?.()
              else fail(session, '语音识别连接中断，请重新开始监听')
            })
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
            const timeout = setTimeout(resolve, 700)
            session.resolveStop = () => {
              clearTimeout(timeout)
              resolve()
            }
            if (session.started && session.socket.readyState === WebSocket.OPEN)
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
  if (session.started && session.socket.readyState === WebSocket.OPEN) session.socket.send(buffer)
  else {
    session.buffered.push(buffer)
    if (session.buffered.length > 16) session.buffered.shift()
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
