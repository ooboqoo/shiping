import { ipcMain } from 'electron'
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'

const WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/'

let ws: WebSocket | null = null
let taskId: string | null = null
let isTranscribing = false
let taskStarted = false
let accumulatedText = ''
let currentPartial = ''

export type TranscriptionPurpose = 'screenshot' | 'conversation'

export interface TranscriptionOptions {
  /**
   * 截图模式 collects the text for the next screenshot; 对话模式 hands every
   * sentence to conversation.ts instead, leaving 截图模式's text untouched
   */
  purpose?: TranscriptionPurpose
  /** Silence (ms) that ends a sentence; the recogniser's default (1300ms) when absent */
  maxSentenceSilence?: number
}

let purpose: TranscriptionPurpose = 'screenshot'

type SentenceListener = (text: string, final: boolean) => void
const sentenceListeners = new Set<SentenceListener>()
const startListeners = new Set<(purpose: TranscriptionPurpose) => void>()
const errorListeners = new Set<(message: string) => void>()
const endListeners = new Set<() => void>()

/** 对话模式: every revision of the sentence being spoken, and its final text */
export function onConversationSentence(listener: SentenceListener): void {
  sentenceListeners.add(listener)
}

/** Recognition started, for 截图模式's text or 对话模式's sentences */
export function onTranscriptionStart(listener: (purpose: TranscriptionPurpose) => void): void {
  startListeners.add(listener)
}

/** Recognition failed; it is reported stopped right after */
export function onTranscriptionError(listener: (message: string) => void): void {
  errorListeners.add(listener)
}

/** Recognition stopped, for whatever reason */
export function onTranscriptionEnd(listener: () => void): void {
  endListeners.add(listener)
}

export function isTranscriptionRunning(purposeWanted: TranscriptionPurpose): boolean {
  return isTranscribing && purpose === purposeWanted
}

/** Tell the renderer and the listeners in main that recognition has stopped */
function reportStopped() {
  sendToRenderer('transcription-stopped')
  endListeners.forEach((listener) => listener())
}

function reportError(message: string) {
  sendToRenderer('transcription-error', message)
  errorListeners.forEach((listener) => listener(message))
}

function sendToRenderer(channel: string, ...args: unknown[]) {
  const mainWindow = global.mainWindow
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

function cleanup() {
  if (ws) {
    ws.removeAllListeners()
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
    ws = null
  }
  taskId = null
  isTranscribing = false
  taskStarted = false
}

function startTranscription(apiKey: string, options: TranscriptionOptions = {}) {
  if (isTranscribing) return

  cleanup()
  isTranscribing = true
  purpose = options.purpose ?? 'screenshot'
  taskId = randomUUID()
  const silence = options.maxSentenceSilence
  startListeners.forEach((listener) => listener(purpose))

  ws = new WebSocket(WS_URL, {
    headers: { Authorization: `bearer ${apiKey}` }
  })

  ws.on('open', () => {
    const runTask = {
      header: {
        action: 'run-task',
        task_id: taskId,
        streaming: 'duplex'
      },
      payload: {
        task_group: 'audio',
        task: 'asr',
        function: 'recognition',
        model: 'fun-asr-realtime',
        parameters: {
          format: 'pcm',
          sample_rate: 16000,
          // The recogniser accepts 200–6000ms
          ...(silence ? { max_sentence_silence: Math.min(6000, Math.max(200, silence)) } : {})
        },
        input: {}
      }
    }
    ws!.send(JSON.stringify(runTask))
  })

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString())
      const event = msg.header?.event

      if (event === 'task-started') {
        taskStarted = true
        return
      }

      if (event === 'result-generated') {
        const sentence = msg.payload?.output?.sentence
        if (!sentence) return

        const text: string = sentence.text || ''
        const sentenceEnd: boolean = sentence.sentence_end === true

        if (purpose === 'conversation') {
          sentenceListeners.forEach((listener) => listener(text, sentenceEnd))
          return
        }

        if (sentenceEnd) {
          if (text) {
            accumulatedText += (accumulatedText ? '' : '') + text
          }
          currentPartial = ''
        } else {
          currentPartial = text
        }

        sendToRenderer('transcription-text', {
          text: getTranscriptionText(),
          isPartial: !sentenceEnd
        })
        return
      }

      if (event === 'task-failed') {
        const errorMsg = msg.header?.error_message || '语音识别失败'
        console.error('Transcription task failed:', errorMsg)
        reportError(errorMsg)
        cleanup()
        reportStopped()
        return
      }

      if (event === 'task-finished') {
        cleanup()
        reportStopped()
      }
    } catch (e) {
      console.error('Failed to parse transcription message:', e)
    }
  })

  ws.on('error', (err) => {
    console.error('Transcription WebSocket error:', err)
    reportError(err.message || 'WebSocket 连接失败')
    cleanup()
    reportStopped()
  })

  ws.on('close', () => {
    if (isTranscribing) {
      isTranscribing = false
      reportStopped()
    }
    ws = null
    taskStarted = false
  })
}

function stopTranscription() {
  if (!isTranscribing) return

  if (ws && ws.readyState === WebSocket.OPEN && taskId && taskStarted) {
    const finishTask = {
      header: {
        action: 'finish-task',
        task_id: taskId,
        streaming: 'duplex'
      },
      payload: {
        input: {}
      }
    }
    ws.send(JSON.stringify(finishTask))
  }

  isTranscribing = false
  cleanup()
  reportStopped()
}

function handleAudioChunk(chunk: ArrayBuffer) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !taskStarted) return
  ws.send(Buffer.from(chunk))
}

export function getTranscriptionText(): string {
  return accumulatedText + currentPartial
}

export function clearTranscriptionText() {
  accumulatedText = ''
  currentPartial = ''
}

ipcMain.handle('start-transcription', (_event, apiKey: string, options?: TranscriptionOptions) => {
  startTranscription(apiKey, options)
})

ipcMain.handle('stop-transcription', () => {
  stopTranscription()
})

ipcMain.on('transcription-audio-chunk', (_event, chunk: ArrayBuffer) => {
  handleAudioChunk(chunk)
})

ipcMain.handle('get-transcription-text', () => {
  return getTranscriptionText()
})

ipcMain.handle('clear-transcription-text', () => {
  clearTranscriptionText()
})
