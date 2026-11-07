/**
 * 对话模式 data, shared by main (which owns it) and the renderer (which shows it).
 */

/** `auto` asks for a hint as soon as the other side finishes a sentence; `manual` waits for the shortcut */
export type HintMode = 'auto' | 'manual'
export type AudioSource = 'system' | 'microphone'
export type ConversationAudioMode = 'dual' | 'system' | 'microphone'

/** One sentence of the other side, as the speech recogniser reports it */
export interface Utterance {
  /** Increasing from 1 within a conversation */
  id: number
  source?: AudioSource
  updatedAt?: number
  finalAt?: number
  text: string
  /** False while the recogniser is still revising it */
  final: boolean
}

export type HintStatus =
  /** Being generated */
  | 'streaming'
  /** An automatic hint was cut short because the other side kept talking; it restarts once they finish */
  | 'waiting'
  | 'done'
  | 'stopped'
  | 'error'

export interface HintCard {
  id: number
  /** The utterances this hint answers, inclusive */
  fromId: number
  toId: number
  source: 'auto' | 'manual'
  status: HintStatus
  text: string
  /** What the model reasoned before `text`; empty for non-thinking models */
  reasoning: string
  error?: string
  /** From the request to the first chunk, in ms; absent until the first chunk */
  latencyMs?: number
  speechLatencyMs?: number
  requestedAt?: number
  firstTextAt?: number
  visibleLatencyMs?: number
  visibleSpeechLatencyMs?: number
  historyTokens?: number
  historyRounds?: number
}

export interface ConversationSnapshot {
  utterances: Utterance[]
  hints: HintCard[]
  /** Whether speech recognition is running for this conversation */
  listening: boolean
}

/** The preset prompts tell the model to answer this when nothing needs a reply */
export const NO_REPLY = '（无需回应）'

/** Characters that carry meaning: punctuation and spaces do not count towards the minimum */
export function countMeaningfulChars(text: string): number {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').length
}
