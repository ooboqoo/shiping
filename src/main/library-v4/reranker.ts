import {
  normalizeModelConfig,
  isCloudProvider,
  providerJSON,
  modelEndpoint,
  type ModelConfig,
  type ModelProvider
} from './model-providers'
/** Local-only cross encoder; a failed optional stage preserves the fusion result. */
export interface RerankConfig {
  enabled: boolean
  provider?: 'local' | ModelProvider
  baseURL?: string
  apiKey?: string
  url?: string
  model?: string
  timeoutMs?: number
}
export function validateRerankConfig(value: RerankConfig): RerankConfig {
  if (!value || typeof value.enabled !== 'boolean') throw Error('精排配置无效')
  if (value.provider && value.provider !== 'local') {
    const normalized = normalizeModelConfig(value as ModelConfig, 'rerank')
    return { ...normalized, enabled: value.enabled }
  }
  const config = {
    url: 'http://127.0.0.1:18200/rerank',
    model: 'BAAI/bge-reranker-v2-m3',
    timeoutMs: 30000,
    ...value
  }
  const u = new URL(config.url)
  if (
    u.protocol !== 'http:' ||
    u.hostname !== '127.0.0.1' ||
    u.pathname !== '/rerank' ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !Number.isFinite(config.timeoutMs) ||
    config.timeoutMs < 100 ||
    config.timeoutMs > 60000 ||
    config.model !== 'BAAI/bge-reranker-v2-m3'
  )
    throw Error('精排仅支持本机服务及已安装模型')
  return config
}
export async function rerankCandidates(
  query: string,
  hits: any[],
  value: RerankConfig,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<{ hits: any[]; diagnostics: any }> {
  signal?.throwIfAborted()
  const config = validateRerankConfig(value),
    started = Date.now()
  if (!config.enabled || !hits.length) return { hits, diagnostics: { status: 'disabled' } }
  try {
    if (hits.length > 20) throw Error('精排候选超过20条')
    const timeout = AbortSignal.timeout(config.timeoutMs!),
      combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const body =
      config.provider && config.provider !== 'local'
        ? await providerJSON(
            config as ModelConfig,
            modelEndpoint(config as ModelConfig, 'rerank'),
            {
              model: config.model,
              ...(config.provider === 'aliyun'
                ? {
                    input: { query, documents: hits.map((h) => h.input || h.text) },
                    parameters: { top_n: hits.length }
                  }
                : { query, documents: hits.map((h) => h.input || h.text), top_n: hits.length })
            },
            combined,
            fetcher
          )
        : await (async () => {
            const response = await fetcher(config.url!, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query, documents: hits.map((h) => h.input || h.text) }),
              signal: combined
            })
            if (!response.ok) throw Error('本地精排服务返回 ' + response.status)
            return response.json()
          })()
    if (config.provider === 'aliyun') body.results = body.output?.results
    if (
      ((!config.provider || config.provider === 'local') && body.model !== config.model) ||
      !Array.isArray(body.results) ||
      body.results.length !== hits.length
    )
      throw Error('精排响应与候选不匹配')
    const indices = new Set<number>()
    for (const row of body.results) {
      if (
        !Number.isInteger(row.index) ||
        row.index < 0 ||
        row.index >= hits.length ||
        indices.has(row.index) ||
        typeof row.relevance_score !== 'number' ||
        !Number.isFinite(row.relevance_score)
      )
        throw Error('精排分数或编号无效')
      indices.add(row.index)
    }
    signal?.throwIfAborted()
    const sorted = [...body.results].sort(
      (a, b) => b.relevance_score - a.relevance_score || a.index - b.index
    )
    return {
      hits: sorted.map((row) => ({ ...hits[row.index], rerankScore: row.relevance_score })),
      diagnostics: {
        status: 'applied',
        ms: Date.now() - started,
        model: config.model,
        ...(isCloudProvider(config.provider || '')
          ? {}
          : {
              device: body.device,
              modelHash: body.model_hash,
              fallback: body.fallback || null
            })
      }
    }
  } catch (e) {
    signal?.throwIfAborted()
    return {
      hits,
      diagnostics: {
        status: 'fallback',
        ms: Date.now() - started,
        model: config.model,
        error: e instanceof Error ? e.message : '本机精排不可用'
      }
    }
  }
}
