import type { HintCard, Utterance, ConversationContextUsage } from '../shared/conversation'
import { NO_REPLY } from '../shared/conversation'
import { estimateTokens } from '../shared/knowledge'
import { normalizeSummarySettings } from '../shared/conversation-summary'

export const cut = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text

export function answered(card: HintCard): boolean {
  return card.status === 'done' && !!card.text.trim() && !card.text.includes(NO_REPLY)
}

/** Ordinals follow question chronology, independent of card allocation/rewrite order. */
export function completedRounds(hints: HintCard[]): HintCard[] {
  return hints.filter(answered).sort((a, b) => a.fromId - b.fromId || a.toId - b.toId)
}

interface ContextInput {
  utterances: Utterance[]
  hints: HintCard[]
  fromId: number
  toId: number
  previous?: string
  early?: boolean
  memo?: string
  memoUpTo?: number
  summaries: ReadonlyMap<number, string>
  enabled?: boolean
  rounds?: number
  budget?: number
}

/** Only the added summary block is budgeted; the upstream baseline stays intact. */
export function buildConversationContext(input: ContextInput): {
  text: string
  usage: ConversationContextUsage
} {
  const { utterances, hints, fromId, toId, previous, early, memo, memoUpTo = 0 } = input
  const options = normalizeSummarySettings(input)
  const context: string[] = []
  let chars = 0
  const earlier = utterances.filter(
    (u) => u.text.trim() && (u.id < fromId || u.source === 'microphone')
  )
  const hasSelf = earlier.some((u) => u.source === 'microphone')
  for (let i = earlier.length - 1; i >= 0 && context.length < 20; i--) {
    const text = hasSelf
      ? `${earlier[i].source === 'microphone' ? '我（实际回答）' : '对方'}：${earlier[i].text}`
      : earlier[i].text
    chars += text.length
    if (chars > 1500 && context.length > 0) break
    context.unshift(text)
  }
  const focus = utterances.filter(
    (u) => u.source !== 'microphone' && u.id >= fromId && u.id <= toId && u.text.trim()
  )
  const unfinished = !early && focus.length > 0 && !focus[focus.length - 1].final
  const given = hints
    .filter((card) => card.toId < fromId && answered(card))
    .slice(-2)
    .map((card) => cut(card.text.trim(), 160))
  const parts: string[] = []
  if (memo && fromId > memoUpTo)
    parts.push(`【更早对话的备忘】（前面对话的摘要，提示要与其中的说法保持一致）\n${memo}`)
  if (context.length > 0)
    parts.push(
      `${hasSelf ? '【之前对话原文】（我（实际回答）是用户说过的话）' : '【之前对方说过的话】'}\n${context.join('\n')}`
    )
  if (given.length > 0)
    parts.push(
      `【你最近给过的提示（节选）】\n${given.join('\n---\n')}\n\n对方若是追问，接着这个思路往下说；不要重复已经给过的内容。`
    )

  const selected: { ordinal: number; text: string }[] = []
  const rounds = completedRounds(hints)
    .map((card, index) => ({ card, ordinal: index + 1 }))
    .filter(({ card }) => card.toId < fromId)
    .slice(-options.rounds)
  const heading = '【最近已完成问答的补充摘要】（AI 建议不代表用户实际说过）\n'
  const render = () => (selected.length ? heading + selected.map((s) => s.text).join('\n') : '')
  if (options.enabled) {
    for (const { card, ordinal } of [...rounds].reverse()) {
      const summary = input.summaries.get(card.id)?.trim()
      if (!summary) continue
      const prefix = `第${ordinal}轮：`
      // Fit text including heading, labels, separators and truncation marker.
      let low = 0,
        high = summary.length
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        const text = prefix + summary.slice(0, mid) + (mid < summary.length ? '…' : '')
        const block = heading + [text, ...selected.map((s) => s.text)].join('\n')
        if (estimateTokens(block) <= options.budget) low = mid
        else high = mid - 1
      }
      if (!low) break
      selected.unshift({
        ordinal,
        text: prefix + summary.slice(0, low) + (low < summary.length ? '…' : '')
      })
    }
  }
  const summaryText = render()
  if (summaryText) parts.push(summaryText)
  const history = parts.join('\n\n')
  parts.push(
    `【对方刚才说的话】${unfinished ? '（还没说完）' : ''}\n${focus.map((u) => u.text).join('\n')}`
  )
  if (previous?.trim())
    parts.push(`【上一版提示】\n${previous}\n\n请换一个角度重新给出提示，不要重复上一版。`)
  const text = parts.join('\n\n')
  return {
    text,
    usage: {
      rawUtterances: context.length,
      summaryRounds: selected.map((s) => s.ordinal),
      summaryTokens: estimateTokens(summaryText),
      historyChars: history.length,
      historyTokens: estimateTokens(history),
      textChars: text.length,
      estimatedTokens: estimateTokens(text)
    }
  }
}
