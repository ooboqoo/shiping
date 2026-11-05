/**
 * The two ways the app is used: 截图模式 answers screenshots, 对话模式 turns
 * what the other side of a call says into hints. Each picks its own AI profile
 * and has its own prompt scenes.
 */
export type AppMode = 'screenshot' | 'conversation'

/** Where requests go when a profile's API Base URL is left empty: OpenAI itself */
export const DEFAULT_API_BASE_URL = 'https://api.openai.com/v1'

/**
 * How hard a thinking model is asked to think (see main thinking.ts). Empty
 * leaves it to the model; the rest are the levels OpenAI's `reasoning_effort`
 * names and most platforms that read it share.
 */
export type ReasoningEffort = '' | 'low' | 'medium' | 'high'

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['', 'low', 'medium', 'high']

/** A stored value that is not a known level (an older version, a hand edit) means the default */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort) ? (value as ReasoningEffort) : ''
}

/**
 * One saved AI endpoint: everything needed to send a request. The renderer
 * keeps and edits the list; main picks the one the current mode uses.
 */
export interface ApiProfile {
  id: string
  /** User-facing label, e.g. 「DeepSeek 主力」 */
  name: string
  apiBaseURL: string
  apiKey: string
  /** Extra request headers some platforms need, one `Name: Value` per line */
  apiHeaders: string
  model: string
  /**
   * Ask the model to skip its thinking phase (see main thinking.ts). Kept per
   * profile because whether it helps, and how it is spelled, depends on the
   * platform and model — and so a fast profile and a careful one can sit side by side.
   */
  disableThinking: boolean
  /**
   * 「思考强度」, per profile for the same reasons. Ignored while
   * `disableThinking` is on: thinking that is off has no strength
   */
  reasoningEffort: ReasoningEffort
  /**
   * Whether the model takes image input: true / false when the platform's model
   * list, the preset table or a refused screenshot said so, absent when unknown.
   * Only 截图模式 needs it; 对话模式 sends text alone.
   */
  vision?: boolean
}
