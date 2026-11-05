import type { HintCard, Utterance } from './conversation'
import { estimateTokens } from './knowledge'

export interface ContextOptions {
  enabled: boolean
  rounds: number
  tokenBudget: number
}

export function normalizeContextOptions(options: Partial<ContextOptions>): ContextOptions {
  const integer = (value: number | undefined, fallback: number, min: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, Math.floor(value)))
      : fallback
  return {
    enabled: options.enabled !== false,
    rounds: integer(options.rounds, 3, 0, 20),
    tokenBudget: integer(options.tokenBudget, 1000, 100, 4000)
  }
}

/** A local, conservative estimate, not the provider's exact tokenizer. */
export function fitTokens(text: string, budget: number): string {
  if (budget <= 0) return ''
  if (estimateTokens(text) <= budget) return text
  const points = Array.from(text)
  let low = 0
  let high = points.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (estimateTokens(points.slice(0, mid).join('') + '…') <= budget) low = mid
    else high = mid - 1
  }
  return low ? points.slice(0, low).join('') + '…' : ''
}

interface HistoryInput extends Partial<ContextOptions> {
  hints: HintCard[]
  utterances: Utterance[]
  summaries: ReadonlyMap<number, string>
  fromId: number
}

/** Select ready summaries synchronously; never pull older rounds to replace an unready one. */
export function buildHistory(input: HistoryInput): string {
  const { enabled, rounds, tokenBudget } = normalizeContextOptions(input)
  if (!enabled || !rounds) return ''
  const eligible = input.hints.filter((h) => h.status === 'done' && h.toId < input.fromId)
  const selected = eligible.slice(-rounds)
  const blocks: string[] = []
  // Budget the newest first, then put selected blocks back into chronological order.
  for (let index = selected.length - 1; index >= 0; index--) {
    const card = selected[index]
    const summary = input.summaries.get(card.id)
    if (!summary?.trim()) continue
    const next = input.hints.find((h) => h.fromId > card.toId)
    const nextQuestion =
      next &&
      input.utterances.find(
        (u) => u.source !== 'microphone' && u.id >= next.fromId && u.id <= next.toId
      )
    const end = nextQuestion?.id ?? input.fromId
    const self = input.utterances
      .filter((u) => u.source === 'microphone' && u.final && u.id >= card.fromId && u.id < end)
      .map((u) => u.text)
      .join('\n')
    const heading = `【第 ${card.id} 轮摘要】\n`
    const remaining = tokenBudget - estimateTokens(blocks.join('\n\n')) - (blocks.length ? 1 : 0)
    if (remaining < 30) break
    // Reserve room for what the user actually said, even when the AI suggestion is long.
    const actual = self
      ? `\n我的实际发言：${fitTokens(self, Math.min(250, Math.floor(remaining / 2)))}`
      : ''
    const body = fitTokens(summary.trim(), remaining - estimateTokens(heading + actual))
    const block = fitTokens(heading + body + actual, remaining)
    blocks.unshift(block)
  }
  return fitTokens(blocks.join('\n\n'), tokenBudget)
}

/** All historical background, including actual speech and rewrite drafts, shares one budget. */
export function buildBackground(
  input: HistoryInput & { self?: string; previous?: string }
): string {
  const options = normalizeContextOptions(input)
  if (!options.enabled || !options.rounds) return ''
  const blocks: string[] = []
  const self = input.self?.trim()
  const previous = input.previous?.trim()
  if (self) {
    blocks.push(
      fitTokens(
        `【我的实际发言，不能当作面试官的新问题】\n${self}`,
        Math.min(250, Math.floor(options.tokenBudget * 0.45))
      )
    )
  }
  if (previous) {
    blocks.push(
      fitTokens(
        `【上一版提示，请换角度，不重复】\n${previous}`,
        Math.min(250, Math.floor(options.tokenBudget * 0.3))
      )
    )
  }
  const remaining =
    options.tokenBudget - estimateTokens(blocks.join('\n\n')) - (blocks.length ? 2 : 0)
  if (remaining >= 30) {
    const history = fitTokens(buildHistory({ ...input, tokenBudget: remaining }), remaining)
    if (history) blocks.unshift(history)
  }
  return fitTokens(blocks.join('\n\n'), options.tokenBudget)
}
