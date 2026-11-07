import { toast } from 'sonner'
import { useSettingsStore } from '@/lib/store/settings'
import { useTranscriptionStore } from '@/lib/store/transcription'
import { useConversationStore } from '@/lib/store/conversation'
import { describeCaptureError, startAudioCapture, stopAudioCapture } from '@/lib/audio-capture'

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
  const { dashscopeApiKey, conversationSilenceMs, conversationAudioMode } =
    useSettingsStore.getState()
  const { setErrorMessage } = useConversationStore.getState()
  if (!dashscopeApiKey) {
    starting = false
    setErrorMessage('请先在「设置 → 语音」填写百炼平台 API Key，才能识别对方说话')
    return
  }
  try {
    await window.api.stopTranscription()
    if (request !== operation) return
    const sources = await startAudioCapture({ mode: conversationAudioMode })
    if (request !== operation) return
    await window.api.startTranscription(dashscopeApiKey, {
      purpose: 'conversation',
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
    useTranscriptionStore.getState().setIsTranscribing(false)
    setErrorMessage(describeCaptureError('启动语音识别失败', err))
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
