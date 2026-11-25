import { toast } from 'sonner'
import { useSettingsStore } from '@/lib/store/settings'
import { useTranscriptionStore } from '@/lib/store/transcription'
import { useConversationStore } from '@/lib/store/conversation'
import { describeCaptureError, startAudioCapture, stopAudioCapture } from '@/lib/audio-capture'
import {
  voiceApiKey,
  voiceKeyLabel,
  normalizeTranscriptionProvider
} from '../../../shared/transcription'

/**
 * Listening to the other side: the audio is captured here and recognised in
 * main (`purpose: 'conversation'`), which turns each sentence into the
 * conversation. It keeps running while the settings or help page is open, so
 * adjusting something mid-call does not drop what is being said.
 */
let operation = 0
let starting = false

export async function startListening(): Promise<void> {
  if (starting) return
  const request = ++operation
  starting = true
  const settings = useSettingsStore.getState()
  const { conversationSilenceMs, conversationAudioMode } = settings
  const key = voiceApiKey(settings)
  const { setErrorMessage } = useConversationStore.getState()
  if (!key) {
    starting = false
    setErrorMessage(`请先在「设置 → 语音」填写${voiceKeyLabel(settings)}，才能识别对方说话`)
    return
  }
  let phase: 'capture' | 'asr' = 'asr'
  try {
    await window.api.stopTranscription()
    if (request !== operation) return
    phase = 'capture'
    const sources = await startAudioCapture({ mode: conversationAudioMode || 'system' })
    if (request !== operation) return
    phase = 'asr'
    await window.api.startTranscription(key, {
      purpose: 'conversation',
      provider: normalizeTranscriptionProvider(settings.transcriptionProvider),
      sources,
      maxSentenceSilence: conversationSilenceMs
    })
    if (request !== operation) return
    useTranscriptionStore.getState().setIsTranscribing(true)
    setErrorMessage(null)
  } catch (err) {
    if (request !== operation) return
    console.error('Failed to start listening:', err)
    stopAudioCapture()
    await window.api.stopTranscription()
    if (request !== operation) return
    useTranscriptionStore.getState().setIsTranscribing(false)
    const message =
      phase === 'capture'
        ? describeCaptureError('启动录音失败', err)
        : err instanceof Error
          ? err.message
          : String(err)
    setErrorMessage(message)
    // Phones show why listening is off too; a capture failure is known only here
    void window.api.reportListenFailure(message)
  } finally {
    if (request === operation) starting = false
  }
}

export async function stopListening(): Promise<void> {
  const request = ++operation
  starting = false
  stopAudioCapture()
  await window.api.stopTranscription()
  if (request === operation) useTranscriptionStore.getState().setIsTranscribing(false)
}

export function toggleListening(): void {
  if (starting || useTranscriptionStore.getState().isTranscribing) void stopListening()
  else void startListening()
}

/**
 * `toggle-transcription` from main: the shortcut toggles (`want` absent), a
 * phone's button names what it wants, so a second tap before the first one's
 * start shows on the phone does not stop it again
 */
export function setListening(want?: boolean): void {
  if (want === undefined) return toggleListening()
  const on = starting || useTranscriptionStore.getState().isTranscribing
  if (want && !on) void startListening()
  else if (!want && on) void stopListening()
}

export function toggleHintMode(): void {
  const { conversationHintMode, updateSetting } = useSettingsStore.getState()
  const next = conversationHintMode === 'auto' ? 'manual' : 'auto'
  updateSetting('conversationHintMode', next)
  toast(next === 'auto' ? '已切换为自动出提示' : '已切换为手动出提示', {
    description:
      next === 'auto' ? '对方说完一句话就出提示，快捷键可随时干预' : '只在按快捷键时出提示',
    duration: 3000
  })
}
