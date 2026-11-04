import type { ModelMessage } from 'ai'
import type { AppMode } from '../shared/api-profile'
import {
  EXTERNAL_CONTEXT_CHARS,
  formatExternalKnowledge,
  normalizeExternalKnowledge,
  retrievalURL,
  type ExternalKnowledgeSettings,
  type ExternalRecord
} from '../shared/external-knowledge'
import { settings } from './settings'
import { apiFetch } from './api-fetch'

/**
 * 外部知识库: before a request, ask the user's retrieval service (RAGFlow, or
 * anything else speaking Dify's External Knowledge API) for the passages that
 * fit this round's question. The passages go in front of the round's user
 * message, never into the system prompt (whose stable prefix platforms cache)
 * or the conversation history (a follow-up searches again with its own question).
 *
 * The service only ever adds to an answer: one that is off, slow or broken
 * leaves the request to go without it, and the user is told once a minute.
 */

/** A long question is cut to its end, where the latest words are */
const MAX_QUERY_CHARS = 2000
/** Anything larger is not a list of passages for one question */
const MAX_RESPONSE_CHARS = 1024 * 1024
/** The same failure is reported at most this often */
const NOTICE_INTERVAL_MS = 60_000

/** Ask the service. Throws a message fit for the user, or the caller's own abort */
export async function retrieveExternal(
  config: ExternalKnowledgeSettings,
  query: string,
  signal?: AbortSignal
): Promise<ExternalRecord[]> {
  const url = retrievalURL(config.url)
  const timeout = AbortSignal.timeout(config.timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  // The session's fetch may sit in proxy resolution before the signal is
  // looked at, so the deadline is also raced, not only handed over
  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(combined.reason)
    if (combined.aborted) fail()
    else combined.addEventListener('abort', fail, { once: true })
  })
  aborted.catch(() => {})

  try {
    const response = await Promise.race([
      apiFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {})
        },
        body: JSON.stringify({
          knowledge_id: config.knowledgeId.trim(),
          query,
          retrieval_setting: { top_k: config.topK, score_threshold: config.scoreThreshold }
        }),
        signal: combined
      }),
      aborted
    ])
    const body = await Promise.race([response.text(), aborted])
    if (!response.ok) throw new Error(httpMessage(response.status, body))
    return parseRecords(body, config)
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error
    if (timeout.aborted) throw new Error(`${config.timeoutMs / 1000} 秒内没有响应`)
    const code = error instanceof Error ? error.message.match(/net::ERR_[A-Z_]+/)?.[0] : undefined
    if (code) throw new Error(`无法连接（${code}）`)
    throw error
  }
}

/**
 * `error_msg` is Dify's field, `message` RAGFlow's; a gateway in front may
 * answer in OpenAI's shape
 */
function httpMessage(status: number, body: string): string {
  let detail = ''
  try {
    const data = JSON.parse(body)
    detail = data?.error_msg ?? data?.error?.message ?? data?.message ?? ''
  } catch {
    // Not JSON: the status alone says enough
  }
  return `返回 HTTP ${status}${typeof detail === 'string' && detail ? `：${detail.slice(0, 200)}` : ''}`
}

/**
 * The service's records, kept to the settings: no more than `topK`, none below
 * the threshold (in case the service ignores it), all within the character
 * budget. Records without text are skipped; the service's order is kept.
 */
function parseRecords(body: string, config: ExternalKnowledgeSettings): ExternalRecord[] {
  if (body.length > MAX_RESPONSE_CHARS) throw new Error('返回内容过大')
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    throw new Error('返回的不是有效的 JSON')
  }
  const list = (data as { records?: unknown })?.records
  if (!Array.isArray(list)) throw new Error('返回内容缺少 records 数组')

  const records: ExternalRecord[] = []
  let room = EXTERNAL_CONTEXT_CHARS
  for (const item of list) {
    if (records.length >= config.topK || room <= 0) break
    const { content, score, title } = (item ?? {}) as Record<string, unknown>
    if (typeof content !== 'string' || !content.trim()) continue
    const value = typeof score === 'number' && Number.isFinite(score) ? score : undefined
    if (value !== undefined && value < config.scoreThreshold) continue
    const text = content.trim().slice(0, room)
    room -= text.length
    records.push({
      content: text,
      score: value,
      title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : undefined
    })
  }
  return records
}

let lastNotice = { message: '', at: 0 }

function notify(message: string) {
  const now = Date.now()
  if (message === lastNotice.message && now - lastNotice.at < NOTICE_INTERVAL_MS) return
  lastNotice = { message, at: now }
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('external-knowledge-error', message)
}

/**
 * This round's passages, ready to go in front of its user message. Empty when
 * the mode does not use the service, the round has no text to search with (a
 * bare screenshot) or the service failed, which the user is told about. Only
 * the caller's own abort is thrown.
 */
export async function getExternalReference(
  mode: AppMode,
  query: string | undefined,
  signal?: AbortSignal
): Promise<string> {
  const config = normalizeExternalKnowledge(settings.externalKnowledge)
  if (!config.modes.includes(mode) || !config.url.trim()) return ''
  const text = query?.trim().slice(-MAX_QUERY_CHARS)
  if (!text) return ''
  try {
    return formatExternalKnowledge(await retrieveExternal(config, text, signal))
  } catch (error) {
    if (signal?.aborted) throw error
    console.error('External knowledge retrieval failed:', error)
    const reason = error instanceof Error ? error.message : String(error)
    notify(`外部知识库：${reason}；本轮未带检索资料`)
    return ''
  }
}

/** `messages` with `reference` put in front of the last user message; the input is left as it was */
export function withReference(messages: ModelMessage[], reference: string): ModelMessage[] {
  if (!reference) return messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue
    const content =
      typeof message.content === 'string'
        ? `${reference}\n\n${message.content}`
        : [{ type: 'text' as const, text: reference }, ...message.content]
    const copy = [...messages]
    copy[i] = { ...message, content }
    return copy
  }
  return messages
}
