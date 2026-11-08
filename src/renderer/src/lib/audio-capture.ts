import { useSettingsStore } from '@/lib/store/settings'
import { isMac } from '@/lib/utils/env'
import type { AudioSource, ConversationAudioMode } from '../../../shared/conversation'

const streams: MediaStream[] = []
const processors: ScriptProcessorNode[] = []
let audioContext: AudioContext | null = null
let stopping = false
let generation = 0

function sendPCM(float32: Float32Array, source: AudioSource): void {
  const int16 = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const sample = Math.max(-1, Math.min(1, float32[i]))
    int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  window.api.sendTranscriptionAudioChunk(int16.buffer, source)
}
async function openMicrophone(deviceId: string, ownSpeech = false): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      ...(ownSpeech ? { echoCancellation: true, noiseSuppression: true } : {})
    },
    video: false
  })
}
async function openSystem(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
  stream.getVideoTracks().forEach((track) => track.stop())
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((track) => track.stop())
    throw new Error('未获得电脑声音，请确认共享了系统音频')
  }
  return stream
}

/** With no options, preserve screenshot mode's selected input and single ASR session. */
export async function startAudioCapture(options?: {
  mode: ConversationAudioMode
}): Promise<AudioSource[]> {
  stopAudioCapture()
  stopping = false
  const current = ++generation
  const { audioInputDeviceId, audioOutputDeviceId, conversationMicrophoneDeviceId } =
    useSettingsStore.getState()
  const sources: AudioSource[] = options
    ? options.mode === 'dual'
      ? ['system', 'microphone']
      : [options.mode]
    : ['system']
  try {
    if (
      options?.mode === 'dual' &&
      audioInputDeviceId &&
      audioInputDeviceId === conversationMicrophoneDeviceId
    ) {
      throw new Error('对方音源和自己的麦克风不能选择同一设备')
    }
    audioContext = new AudioContext({ sampleRate: 16000 })
    if (audioOutputDeviceId && 'setSinkId' in audioContext) {
      try {
        await (
          audioContext as AudioContext & { setSinkId: (id: string) => Promise<void> }
        ).setSinkId(audioOutputDeviceId)
      } catch (error) {
        console.warn('Failed to set audio output device:', error)
      }
    }
    for (const source of sources) {
      let stream: MediaStream
      if (source === 'system' && audioInputDeviceId) {
        try {
          stream = await openMicrophone(audioInputDeviceId)
        } catch (error) {
          // Preserve screenshot mode's historical selected-input fallback.
          if (options) throw captureFailure(error, 'microphone')
          stream = await openSystem()
        }
      } else
        try {
          stream = await (source === 'microphone'
            ? openMicrophone(conversationMicrophoneDeviceId || '', true)
            : openSystem())
        } catch (error) {
          throw captureFailure(error, source)
        }
      if (current !== generation) {
        stream.getTracks().forEach((track) => track.stop())
        throw new Error('录音启动已取消')
      }
      streams.push(stream)
      if (source === 'microphone' && audioInputDeviceId && sources.length > 1) {
        const otherDevice = streams[0].getAudioTracks()[0]?.getSettings?.().deviceId
        const ownDevice = stream.getAudioTracks()[0]?.getSettings?.().deviceId
        if (otherDevice && ownDevice && otherDevice === ownDevice) {
          throw new Error('对方音源和自己的麦克风解析为同一设备，请分别选择')
        }
      }
      for (const track of stream.getAudioTracks())
        track.addEventListener('ended', () => {
          if (stopping || current !== generation) return
          stopAudioCapture()
          void window.api.stopTranscription()
        })
      const node = audioContext!.createMediaStreamSource(new MediaStream(stream.getAudioTracks()))
      const processor = audioContext!.createScriptProcessor(2048, 1, 1)
      processor.onaudioprocess = (event) => sendPCM(event.inputBuffer.getChannelData(0), source)
      // Keep the processing graph alive without feeding either input back to speakers.
      const mute = audioContext!.createGain()
      mute.gain.value = 0
      node.connect(processor)
      processor.connect(mute)
      mute.connect(audioContext!.destination)
      processors.push(processor)
    }
    return sources
  } catch (error) {
    if (current === generation) stopAudioCapture()
    throw error
  }
}

/**
 * The message for a capture that failed to start. System audio is taken from a
 * screen capture, so on macOS it needs 屏幕与系统音频录制, granted to this app
 * and in effect only after a restart. The error itself is appended: in a
 * packaged app it is the only clue a user's report can carry.
 */
export function describeCaptureError(failure: string, err: unknown): string {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  const source = (err as { source?: AudioSource } | null)?.source
  const hint =
    source === 'microphone'
      ? '，请检查麦克风权限和所选的麦克风设备'
      : isMac
        ? '：请在「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」中允许本应用，然后完全退出（⌘Q）再重新打开'
        : '，请检查系统音频权限'
  return `${failure}${hint}（${detail}）`
}

function captureFailure(error: unknown, source: AudioSource): Error {
  const failure = error instanceof Error ? error : new Error(String(error))
  return Object.assign(failure, { source })
}

export function stopAudioCapture(): void {
  stopping = true
  generation++
  for (const processor of processors) {
    processor.onaudioprocess = null
    processor.disconnect()
  }
  processors.length = 0
  for (const stream of streams) stream.getTracks().forEach((track) => track.stop())
  streams.length = 0
  if (audioContext) {
    void audioContext.close()
    audioContext = null
  }
}
