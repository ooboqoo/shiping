/**
 * Asking the model to skip its thinking phase.
 *
 * The app shows a model's reasoning as it streams (see ai.ts), but the answer
 * itself still waits for it. Measured with a screenshot of an easy problem,
 * switching thinking off took DeepSeek V4.1 Flash and GLM-4.5V from 4–28s to
 * 1–2s before the first character of the answer; models that do not think by
 * default are unaffected.
 *
 * The OpenAI chat body has no standard field for this and every platform
 * spells it differently, so the fields are merged into the outgoing request
 * body by a fetch wrapper. The same goes for 「思考强度」 (reasoning effort),
 * which only some platforms read, each in its own spelling.
 */

import type { ReasoningEffort } from '../shared/api-profile'

/** Hosts whose own spelling applies to every model; mirrors renderer lib/providers.ts */
const OPENROUTER_HOSTS = ['openrouter.ai']
const OPENAI_HOSTS = ['api.openai.com']

/**
 * What a platform says when it refuses one of the fields below, whatever the
 * wording: OpenAI's `Unknown parameter: 'enable_thinking'`, SiliconFlow's
 * `does not support parameter \`enable_thinking\``, OpenRouter's `Reasoning is
 * mandatory for this endpoint`. SiliconFlow names `enable_thinking` even when
 * only `thinking` was sent, so the match covers every spelling rather than just
 * the ones sent.
 */
const THINKING_FIELD_ERROR = /thinking|reasoning|effort/i

/** The API Base URL's host; an empty URL means OpenAI itself (DEFAULT_API_BASE_URL) */
function hostOf(baseURL: string): string {
  const url = baseURL.trim()
  if (!url) return OPENAI_HOSTS[0]
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function onHosts(host: string, hosts: string[]): boolean {
  return hosts.some((h) => host === h || host.endsWith(`.${h}`))
}

/** The request-body fields that turn thinking off for this platform and model */
export function thinkingOffFields(baseURL: string, model: string): Record<string, unknown> {
  const host = hostOf(baseURL)
  // OpenRouter translates its own field for whichever model it routes to
  if (onHosts(host, OPENROUTER_HOSTS)) return { reasoning: { enabled: false } }
  // OpenAI rejects every field it does not know, so it gets only its own. A
  // proxy serving GPT models under their own names behaves the same
  if (onHosts(host, OPENAI_HOSTS) || /^(gpt-|o\d)/i.test(model)) {
    return { reasoning_effort: 'none' }
  }
  // DeepSeek, Zhipu and Doubao read `thinking`, Qwen reads `enable_thinking`,
  // and each ignores the other's, so both go along
  return { thinking: { type: 'disabled' }, enable_thinking: false }
}

/**
 * The request-body fields that ask for this reasoning effort. OpenRouter
 * translates its own `reasoning.effort` for whichever model it routes to;
 * everyone else gets the OpenAI spelling `reasoning_effort`, which OpenAI's
 * o-series / GPT-5, Gemini's and xAI's OpenAI-compatible endpoints, Doubao,
 * Groq, vLLM and Ollama read. A platform that does not know it mostly ignores
 * it; one that rejects it gets the request again without it (see below)
 */
export function reasoningEffortFields(
  baseURL: string,
  effort: Exclude<ReasoningEffort, ''>
): Record<string, unknown> {
  if (onHosts(hostOf(baseURL), OPENROUTER_HOSTS)) return { reasoning: { effort } }
  return { reasoning_effort: effort }
}

/** Fields + platform + model combinations that were refused; sent without them for the rest of the session */
const refused = new Set<string>()

/**
 * A fetch that merges `fieldsFor(model)` into each chat request body. A model
 * that refuses them — a thinking-only model, or a platform that rejects
 * unknown fields — gets the request again without them, so the setting can
 * slow a request down once but never make it fail. `onRefused` fires on that
 * first refusal only. `kind` keeps one setting's refusals apart from another's
 */
function createExtraFieldsFetch(
  kind: string,
  baseURL: string,
  fieldsFor: (model: string) => Record<string, unknown>,
  onRefused: (model: string) => void,
  transport: typeof fetch
): typeof fetch {
  return async (input, init) => {
    let body: unknown
    try {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    } catch {
      body = undefined
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return transport(input, init)

    const model = String((body as { model?: unknown }).model ?? '')
    const key = `${kind}
${baseURL.trim()}
${model}`
    if (refused.has(key)) return transport(input, init)

    const response = await transport(input, {
      ...init,
      body: JSON.stringify({ ...body, ...fieldsFor(model) })
    })
    if (response.status !== 400 && response.status !== 422) return response
    const detail = await response
      .clone()
      .text()
      .catch(() => '')
    if (!THINKING_FIELD_ERROR.test(detail)) return response

    refused.add(key)
    onRefused(model)
    return transport(input, init)
  }
}

/** 「关闭思考」: adds the thinking-off fields, see createExtraFieldsFetch() */
export function createThinkingOffFetch(
  baseURL: string,
  onRefused: (model: string) => void,
  transport: typeof fetch = fetch
): typeof fetch {
  return createExtraFieldsFetch(
    'thinking-off',
    baseURL,
    (model) => thinkingOffFields(baseURL, model),
    onRefused,
    transport
  )
}

/** 「思考强度」: adds the reasoning-effort fields, see createExtraFieldsFetch() */
export function createReasoningEffortFetch(
  baseURL: string,
  effort: Exclude<ReasoningEffort, ''>,
  onRefused: (model: string) => void,
  transport: typeof fetch = fetch
): typeof fetch {
  return createExtraFieldsFetch(
    `effort-${effort}`,
    baseURL,
    () => reasoningEffortFields(baseURL, effort),
    onRefused,
    transport
  )
}
