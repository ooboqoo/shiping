import WebSocket from 'ws'

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription'
const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions'
const SAMPLE_RATE = 16000
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000
const MAX_TURN_MS = 20000

interface RecognitionCallbacks {
  ready(): void
  sentence(text: string, final: boolean): void
  error(message: string): void
  finished(): void
}

export interface OpenAIRecognition {
  start(): void
  append(pcm: Buffer): void
  finish(): void
  dispose(): void
}

/** Shared client-side turn detection for OpenAI: capture remains mono PCM16 at 16 kHz. */
function turnDetector(silenceMs: number, append: (pcm: Buffer) => void, commit: () => void) {
  let preRoll: Buffer[] = []
  let turnMs = 0
  let quietMs = 0
  const end = () => {
    if (!turnMs) return
    if (turnMs < 200) append(Buffer.alloc(Math.ceil(200 - turnMs) * BYTES_PER_MS))
    turnMs = quietMs = 0
    preRoll = []
    commit()
  }
  return {
    append(pcm: Buffer) {
      if (!pcm.length || pcm.length % 2) return
      let energy = 0
      for (let i = 0; i < pcm.length; i += 2) energy += (pcm.readInt16LE(i) / 32768) ** 2
      const voiced = Math.sqrt(energy / (pcm.length / 2)) >= 0.012
      if (!turnMs && !voiced) {
        preRoll.push(pcm)
        while (preRoll.reduce((bytes, chunk) => bytes + chunk.length, 0) > 250 * BYTES_PER_MS)
          preRoll.shift()
        return
      }
      if (!turnMs) {
        for (const chunk of preRoll) {
          append(chunk)
          turnMs += chunk.length / BYTES_PER_MS
        }
        preRoll = []
      }
      append(pcm)
      const ms = pcm.length / BYTES_PER_MS
      turnMs += ms
      quietMs = voiced ? 0 : quietMs + ms
      if (quietMs >= silenceMs || turnMs >= MAX_TURN_MS) end()
    },
    finish: end
  }
}

/** Realtime requires 24 kHz PCM. Whisper accepts the original 16 kHz WAV. */
export function pcm24k(pcm: Buffer): Buffer {
  const count = pcm.length / 2
  const output = Buffer.alloc(Math.floor(count * 1.5) * 2)
  for (let i = 0; i < output.length / 2; i++) {
    const pos = (i * 2) / 3
    const index = Math.floor(pos)
    const a = pcm.readInt16LE(index * 2)
    const b = pcm.readInt16LE(Math.min(index + 1, count - 1) * 2)
    output.writeInt16LE(Math.round(a + (b - a) * (pos - index)), i * 2)
  }
  return output
}

export function pcmWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function openAIError(status?: number, code?: unknown): string {
  if (status === 401 || code === 'invalid_api_key')
    return 'OpenAI API Key 无效，请到「设置 → 语音」重新填写'
  if (status === 403) return 'OpenAI 拒绝了语音识别，请检查账户及模型权限（HTTP 403）'
  if (status === 429 || code === 'rate_limit_exceeded' || code === 'insufficient_quota')
    return 'OpenAI 语音识别超出额度或速率限制，请检查账户额度后重试'
  if (status) return `OpenAI 语音识别失败（HTTP ${status}）`
  // Do not echo server messages that may include credentials or user speech.
  return 'OpenAI 语音识别失败，请检查网络、API Key 和模型权限'
}

function realtime(
  key: string,
  silenceMs: number,
  callbacks: RecognitionCallbacks
): OpenAIRecognition {
  let socket: WebSocket | undefined
  let disposed = false
  let finishing = false
  let pending = 0
  const items = new Map<string, { partial: string; final?: string }>()
  const order: string[] = []
  let lastPartial = ''
  const send = (event: object) => socket?.send(JSON.stringify(event))
  const detector = turnDetector(
    silenceMs,
    (pcm) => {
      send({ type: 'input_audio_buffer.append', audio: pcm24k(pcm).toString('base64') })
    },
    () => {
      pending++
      send({ type: 'input_audio_buffer.commit' })
    }
  )
  const publish = () => {
    // Final transcripts may arrive out of order; retain commit ordering.
    while (order.length) {
      const id = order[0]
      const item = items.get(id)
      if (item?.final === undefined) break
      order.shift()
      items.delete(id)
      pending = Math.max(0, pending - 1)
      lastPartial = ''
      callbacks.sentence(item.final, true)
    }
    const id = order[0] ?? items.keys().next().value
    const partial = id ? items.get(id)?.partial : undefined
    if (partial && partial !== lastPartial) {
      lastPartial = partial
      callbacks.sentence(partial, false)
    }
    if (finishing && !pending) callbacks.finished()
  }
  return {
    start() {
      socket = new WebSocket(REALTIME_URL, { headers: { Authorization: `Bearer ${key}` } })
      socket.on('open', () =>
        send({
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                transcription: { model: 'gpt-live-transcribe', delay: 'low' },
                turn_detection: null
              }
            }
          }
        })
      )
      socket.on('message', (data: WebSocket.Data) => {
        if (disposed) return
        try {
          const event = JSON.parse(data.toString())
          if (event.type === 'session.updated') callbacks.ready()
          else if (
            event.type === 'input_audio_buffer.committed' &&
            typeof event.item_id === 'string'
          ) {
            if (!order.includes(event.item_id)) order.push(event.item_id)
            publish()
          } else if (
            event.type === 'conversation.item.input_audio_transcription.delta' ||
            event.type === 'conversation.item.input_audio_transcription.completed'
          ) {
            if (typeof event.item_id !== 'string') return
            const item = items.get(event.item_id) ?? { partial: '' }
            if (event.type.endsWith('.delta')) item.partial += String(event.delta ?? '')
            else item.final = String(event.transcript ?? item.partial)
            items.set(event.item_id, item)
            publish()
          } else if (
            event.type === 'error' ||
            event.type === 'conversation.item.input_audio_transcription.failed'
          ) {
            callbacks.error(openAIError(undefined, event.error?.code))
          }
        } catch {
          callbacks.error(openAIError())
        }
      })
      socket.on('error', (error) => {
        const status = /Unexpected server response: (\d+)/.exec(error.message)?.[1]
        if (!disposed) callbacks.error(openAIError(status ? Number(status) : undefined))
      })
      socket.on('close', () => {
        if (disposed) return
        if (finishing) callbacks.finished()
        else callbacks.error('OpenAI 语音识别连接中断，请重新开始监听')
      })
    },
    append: detector.append,
    finish() {
      finishing = true
      detector.finish()
      if (!pending) callbacks.finished()
    },
    dispose() {
      disposed = true
      socket?.removeAllListeners()
      socket?.on('error', () => undefined)
      if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING)
        socket.close()
    }
  }
}

function whisper(
  key: string,
  silenceMs: number,
  callbacks: RecognitionCallbacks
): OpenAIRecognition {
  let disposed = false
  let finishing = false
  let running = false
  let buffers: Buffer[] = []
  const queue: Buffer[] = []
  let controller: AbortController | undefined
  async function drain() {
    if (running || disposed) return
    running = true
    try {
      while (queue.length && !disposed) {
        const pcm = queue.shift()!
        controller = new AbortController()
        const timeout = setTimeout(() => controller?.abort(), 30000)
        try {
          const form = new FormData()
          form.append('model', 'whisper-1')
          form.append(
            'file',
            new Blob([new Uint8Array(pcmWav(pcm))], { type: 'audio/wav' }),
            'speech.wav'
          )
          // Use the existing HTTP transport, including the user's proxy settings.
          const { apiFetch } = await import('./api-fetch')
          const response = await apiFetch(WHISPER_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}` },
            body: form,
            signal: controller.signal
          })
          if (disposed) return
          if (!response.ok) {
            callbacks.error(openAIError(response.status))
            return
          }
          const json = (await response.json()) as { text?: unknown }
          if (disposed) return
          if (typeof json.text !== 'string') {
            callbacks.error(openAIError())
            return
          }
          if (json.text.trim()) callbacks.sentence(json.text.trim(), true)
        } finally {
          clearTimeout(timeout)
          controller = undefined
        }
      }
    } catch {
      if (!disposed) callbacks.error(openAIError())
    } finally {
      running = false
      if (finishing && !disposed) callbacks.finished()
    }
  }
  const detector = turnDetector(
    silenceMs,
    (pcm) => buffers.push(pcm),
    () => {
      if (queue.length >= 8) {
        callbacks.error('Whisper 转录积压，请检查网络后重新开始监听')
        return
      }
      queue.push(Buffer.concat(buffers))
      buffers = []
      void drain()
    }
  )
  return {
    start: callbacks.ready,
    append: detector.append,
    finish() {
      finishing = true
      detector.finish()
      if (!running && !queue.length) callbacks.finished()
    },
    dispose() {
      disposed = true
      queue.length = 0
      buffers = []
      controller?.abort()
    }
  }
}

export function createOpenAIRecognition(
  provider: 'openai-realtime' | 'openai-whisper',
  key: string,
  silenceMs: number | undefined,
  callbacks: RecognitionCallbacks
): OpenAIRecognition {
  const silence = Math.min(6000, Math.max(200, silenceMs ?? 800))
  return provider === 'openai-realtime'
    ? realtime(key, silence, callbacks)
    : whisper(key, silence, callbacks)
}
