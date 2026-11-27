/**
 * 对话模式 data, shared by main (which owns it) and the renderer (which shows it).
 */

/** `auto` asks for a hint as soon as the other side finishes a sentence; `manual` waits for the shortcut */
export type HintMode = 'auto' | 'manual'

/** Logical speaker: a selected virtual input still belongs to the other side. */
export type AudioSource = 'system' | 'microphone'
export type ConversationAudioMode = AudioSource | 'dual'

/** One sentence of the other side, as the speech recogniser reports it */
export interface Utterance {
  /** Increasing from 1 within a conversation */
  id: number
  text: string
  /** Absent on legacy records: the other side. */
  source?: AudioSource
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
}

export interface ConversationSnapshot {
  utterances: Utterance[]
  hints: HintCard[]
  /** Whether speech recognition is running for this conversation */
  listening: boolean
}

/** The preset prompts tell the model to answer this when nothing needs a reply */
export const NO_REPLY = '（无需回应）'

const NO_REPLY_VARIANTS = [NO_REPLY, '(无需回应)', '无需回应']

/** Trim whitespace and trailing sentence punctuation before checking for NO_REPLY */
function trimNoReply(text: string): string {
  return text.trim().replace(/[。.!！]+$/, '')
}

/** Whether a finished hint says nothing needs a reply */
export function isNoReply(text: string): boolean {
  return NO_REPLY_VARIANTS.includes(trimNoReply(text))
}

/**
 * Whether an incomplete automatic hint could still end as NO_REPLY. Holds back
 * only the first few characters while they stay a prefix of a NO_REPLY form.
 */
export function maybeNoReply(text: string): boolean {
  const trimmed = text.trimStart()
  if (!trimmed || isNoReply(trimmed)) return true
  return NO_REPLY_VARIANTS.some((variant) => variant.startsWith(trimmed))
}

/**
 * Common standalone backchannels / fillers prefilled for 「屏蔽词」. Matched
 * against the whole sentence (ignoring punctuation and ASCII case), so normal
 * sentences starting with them (「嗯，那你们怎么保证…」) stay untouched.
 */
export const DEFAULT_CONVERSATION_IGNORE_WORDS = [
  '嗯、嗯嗯、啊、哦、呃、额',
  '好、好的、对、是的、明白、了解',
  'OK、Okay、Yeah、Yes、Right、Sure'
].join('\n')

/** Strip whitespace, punctuation and symbols and fold case for exact filler matching */
function normalizeIgnoreKey(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}

/** Parse newline / comma / enumeration-comma separated ignore words into normalized keys */
export function parseIgnoreWords(raw: string): Set<string> {
  const set = new Set<string>()
  for (const part of raw.split(/[\r\n,，、;；]+/)) {
    const key = normalizeIgnoreKey(part)
    if (key) set.add(key)
  }
  return set
}

/** Whether an entire sentence matches one of the configured ignore words */
export function isIgnoredSentence(text: string, ignoreSet: ReadonlySet<string>): boolean {
  if (ignoreSet.size === 0) return false
  const key = normalizeIgnoreKey(text)
  return key.length > 0 && ignoreSet.has(key)
}

/**
 * CJK characters count as one each; contiguous non-CJK letters/digits (e.g. an
 * English word like "Okay") count as one unit so 4-letter fillers do not cross
 * the minimum trigger length on their own.
 */
const MEANINGFUL_UNIT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[^\s\p{P}\p{S}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu

/** Units that carry meaning: punctuation and spaces do not count towards the minimum */
export function countMeaningfulChars(text: string): number {
  return text.match(MEANINGFUL_UNIT)?.length ?? 0
}

/** Ends like a question: a question mark, or a closing particle */
const QUESTION_END = /(?:[?？]|[吗呢么嘛])[\s\p{P}]*$/u
/** Asks something anywhere in the sentence; English only at its start, where it is reliable */
const QUESTION_WORDS =
  /什么|怎么|怎样|为什么|为啥|如何|哪(?!怕)|多少|几[个种次年点]|是否|能不能|可不可以|会不会|有没有|是不是|对不对|行不行|介绍一下|讲讲|讲一下|说说|说一下|谈谈|聊聊|解释一下|区别|举个例子|你觉得|你认为|^\s*(?:what|how|why|when|where|which|who|whose|can|could|would|will|do|does|did|is|are|have|has|tell me|describe|explain|walk me)\b/i

/**
 * Whether a sentence reads as a question. Speech recognition leaves out most
 * punctuation in a sentence still being spoken, hence the words as well.
 */
export function looksLikeQuestion(text: string): boolean {
  return QUESTION_END.test(text) || QUESTION_WORDS.test(text)
}
