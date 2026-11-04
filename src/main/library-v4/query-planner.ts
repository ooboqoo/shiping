import { queryEntities, numericLiterals } from './query-identifiers'
import type { ChatHistory } from './ai-client'
interface Rewriter {
  rewrite(query: string, history: ChatHistory, signal?: AbortSignal): Promise<any>
}
/** Original query is always kept; generated variants only broaden the same two routes. */
export async function planQuery(
  original: string,
  history: ChatHistory,
  ai: Rewriter,
  enabled: boolean,
  signal?: AbortSignal
) {
  signal?.throwIfAborted()
  const pronoun = /(这个|那个|它|他|她|刚才|上面|前面|继续|还有呢|这两|两者)/.test(original),
    noisy =
      original.length > 180 ||
      /^(嗯|呃|啊|那个|我想问一下|请问一下)|到底|咋|啥|怎么说/.test(original)
  const base = { original, queries: [] as string[], terms: [] as string[] }
  if (!enabled || (!noisy && !pronoun))
    return { ...base, diagnostics: { status: enabled ? 'skipped' : 'disabled' } }
  const recent = pronoun
    ? history.slice(-6).map((x) => ({ role: x.role, content: x.content.slice(-1500) }))
    : []
  try {
    const result = await ai.rewrite(original, recent, signal)
    signal?.throwIfAborted()
    if (
      !result ||
      typeof result.query !== 'string' ||
      !result.query.trim() ||
      result.query.length > 1000 ||
      !Array.isArray(result.terms) ||
      result.terms.length > 3 ||
      result.terms.some((t: any) => typeof t !== 'string' || !t.trim() || t.length > 40)
    )
      throw Error('invalid rewrite')
    const source = original + '\n' + recent.map((h) => h.content).join('\n'),
      anchors = queryEntities(original),
      rewritten = result.query + ' ' + result.terms.join(' ')
    if (
      numericLiterals(original).some((n) => !numericLiterals(rewritten).includes(n)) ||
      numericLiterals(rewritten).some((n) => !numericLiterals(source).includes(n))
    )
      throw Error('changed numeric literals')
    if (
      anchors.some((a) => !rewritten.toLowerCase().includes(a.toLowerCase())) ||
      queryEntities(rewritten).some((a) => !source.toLowerCase().includes(a.toLowerCase()))
    )
      throw Error('changed identifiers')
    const queries = [
      ...new Set(
        [result.query.trim(), result.terms.join(' ').trim()].filter((q) => q && q !== original)
      )
    ].slice(0, 2)
    return {
      ...base,
      queries,
      terms: result.terms,
      diagnostics: { status: 'rewritten', query: result.query, terms: result.terms }
    }
  } catch {
    signal?.throwIfAborted()
    return {
      ...base,
      diagnostics: { status: 'fallback', reason: '改写不可用或未通过原文一致性检查，已使用原问题' }
    }
  }
}
