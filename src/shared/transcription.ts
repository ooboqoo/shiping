export type TranscriptionProvider = 'dashscope' | 'openai-realtime' | 'openai-whisper'

export function normalizeTranscriptionProvider(value: unknown): TranscriptionProvider {
  return value === 'openai-realtime' || value === 'openai-whisper' ? value : 'dashscope'
}

interface VoiceSettings {
  transcriptionProvider?: TranscriptionProvider
  dashscopeApiKey?: string
  openaiTranscriptionApiKey?: string
}

/** Keep credentials scoped to their own provider; old settings default to Fun-ASR. */
export function voiceApiKey(settings: VoiceSettings): string {
  const key =
    normalizeTranscriptionProvider(settings.transcriptionProvider) === 'dashscope'
      ? settings.dashscopeApiKey
      : settings.openaiTranscriptionApiKey
  return typeof key === 'string' ? key.trim() : ''
}

export function voiceKeyLabel(settings: VoiceSettings): string {
  return normalizeTranscriptionProvider(settings.transcriptionProvider) === 'dashscope'
    ? '百炼平台 API Key'
    : 'OpenAI API Key'
}
