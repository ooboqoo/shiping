import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { validateVector } from '../rag/chunks'
import { OLLAMA_URL, EMBED_MODEL, CHUNK_VERSION } from '../../shared/rag'
import * as runtime from './runtime'
import type { ModelConfig } from '../../shared/library-models'
export type { ModelConfig, ModelProvider } from '../../shared/library-models'
export const isCloudProvider = (provider: string) =>
  ['siliconflow', 'aliyun', 'openai-compatible', 'rerank-compatible'].includes(provider)
export function normalizeModelConfig(
  value: ModelConfig,
  kind = 'embedding',
  requireKey = true
): ModelConfig {
  if (
    !value ||
    ![
      'ollama',
      'xinference',
      'siliconflow',
      'aliyun',
      'openai-compatible',
      'rerank-compatible'
    ].includes(value.provider)
  )
    throw Error('模型提供商无效')
  if (kind === 'rerank' && value.provider === 'openai-compatible')
    throw Error('该接入方式仅支持 Embedding，请选择通用 Rerank API')
  if (kind === 'embedding' && value.provider === 'rerank-compatible')
    throw Error('该接入方式仅支持 Rerank')
  if (kind === 'rerank' && value.provider === 'ollama')
    throw Error('Ollama 不支持 Rerank，请使用 Xinference')
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200)
    throw Error('请输入模型名称或 UID')
  if (
    value.apiKey !== undefined &&
    (typeof value.apiKey !== 'string' || value.apiKey.length > 8192 || /[\r\n]/.test(value.apiKey))
  )
    throw Error('API Key 无效')
  if (requireKey && isCloudProvider(value.provider) && !value.apiKey?.trim())
    throw Error('云端服务需要填写 API Key')
  const timeoutMs = value.timeoutMs ?? 30000
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000)
    throw Error('超时需在 100 到 60000 毫秒之间')
  let url: URL
  try {
    url = new URL(value.baseURL)
  } catch {
    throw Error('模型服务地址无效')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.href.length > 2048
  )
    throw Error('模型服务地址无效')
  if (
    isCloudProvider(value.provider) &&
    url.protocol !== 'https:' &&
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  )
    throw Error('云端模型地址必须使用 HTTPS')
  let baseURL = url.href.replace(/\/+$/, '')
  if (value.provider === 'xinference') baseURL = baseURL.replace(/\/v1$/, '')
  if (value.provider === 'aliyun')
    baseURL = baseURL.replace(/\/(?:compatible-mode\/v1|api\/v1)$/, '')
  else if (isCloudProvider(value.provider) && !url.pathname.replace(/\/+$/, '')) baseURL += '/v1'
  return {
    provider: value.provider,
    baseURL,
    model: value.model.trim(),
    apiKey: value.apiKey || '',
    timeoutMs
  }
}
export function modelEndpoint(config: ModelConfig, task: 'models' | 'embedding' | 'rerank') {
  if (config.provider === 'ollama') return task === 'models' ? '/api/tags' : '/api/embed'
  if (config.provider === 'xinference') return '/v1/' + (task === 'embedding' ? 'embeddings' : task)
  if (config.provider === 'aliyun')
    return task === 'rerank'
      ? '/api/v1/services/rerank/text-rerank/text-rerank'
      : '/compatible-mode/v1/' + (task === 'embedding' ? 'embeddings' : 'models')
  return '/' + (task === 'embedding' ? 'embeddings' : task)
}
export async function providerJSON<T = unknown>(
  config: ModelConfig,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<T> {
  signal?.throwIfAborted()
  const timeout = AbortSignal.timeout(config.timeoutMs ?? 30000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const response = await fetcher(config.baseURL + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: combined,
      redirect: 'error'
    })
    if (!response.ok) {
      const reason = [401, 403].includes(response.status)
        ? '请检查 API Key、模型权限和地域'
        : response.status === 429
          ? '请求受限，请检查余额、额度和调用频率后重试'
          : '请检查服务地址和模型配置'
      throw Error(`模型服务 HTTP ${response.status}，${reason}`)
    }
    return await response.json()
  } catch (e) {
    signal?.throwIfAborted()
    if (e instanceof Error && /^模型服务 HTTP \d+/.test(e.message)) throw e
    throw Error(combined.aborted ? '模型请求超时' : '模型服务连接失败或响应格式无效')
  }
}
export async function listProviderModels(
  value: ModelConfig,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  kind = 'embedding'
): Promise<{ id: string; digest?: string; type?: string; revision?: string; source?: 'preset' }[]> {
  const c = normalizeModelConfig({ ...value, model: value?.model || '__list__' }, kind)
  if (c.provider === 'aliyun')
    return (
      kind === 'rerank'
        ? ['qwen3-rerank', 'gte-rerank-v2']
        : ['text-embedding-v4', 'text-embedding-v3']
    ).map((id) => ({ id, type: kind, source: 'preset' as const }))
  const path =
    modelEndpoint(c, 'models') +
    (c.provider === 'siliconflow'
      ? '?sub_type=' + (kind === 'rerank' ? 'reranker' : 'embedding')
      : '')
  const data = await providerJSON<{
    models?: Record<string, unknown>[]
    data?: Record<string, unknown>[]
  }>(c, path, undefined, signal, fetcher)
  const rows = c.provider === 'ollama' ? data.models : data.data
  if (
    !Array.isArray(rows) ||
    rows.some((r) => typeof (c.provider === 'ollama' ? r?.name : r?.id) !== 'string')
  )
    throw Error('模型列表响应无效')
  return rows.map((r) => ({
    id: (c.provider === 'ollama' ? r.name : r.id) as string,
    ...(typeof r.digest === 'string' ? { digest: r.digest } : {}),
    ...(c.provider === 'siliconflow'
      ? { type: kind }
      : typeof r.model_type === 'string'
        ? { type: r.model_type }
        : {}),
    revision: JSON.stringify(
      [
        'model_revision',
        'model_name',
        'model_family',
        'model_format',
        'model_size_in_billions',
        'quantization'
      ].map((key) => r[key] ?? null)
    )
  }))
}
export async function embedModel(
  value: ModelConfig,
  texts: string[],
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<number[][]> {
  signal?.throwIfAborted()
  const c = normalizeModelConfig(value)
  if (!texts.length) return []
  const body = await providerJSON<{
    embeddings?: number[][]
    data?: { index: number; embedding: number[] }[]
  }>(
    c,
    modelEndpoint(c, 'embedding'),
    {
      model: c.model,
      input: texts,
      ...(c.provider === 'ollama'
        ? { truncate: false, keep_alive: '5m' }
        : isCloudProvider(c.provider)
          ? { encoding_format: 'float' }
          : {})
    },
    signal,
    fetcher
  )
  let vectors: number[][]
  if (c.provider === 'ollama') vectors = body.embeddings || []
  else {
    if (!Array.isArray(body.data) || body.data.length !== texts.length)
      throw Error('模型返回的向量数量不匹配')
    vectors = new Array(texts.length)
    const seen = new Set<number>()
    for (const row of body.data) {
      if (
        !row ||
        !Number.isInteger(row.index) ||
        row.index < 0 ||
        row.index >= texts.length ||
        seen.has(row.index)
      )
        throw Error('向量编号无效或重复')
      seen.add(row.index)
      vectors[row.index] = row.embedding
    }
  }
  if (!Array.isArray(vectors) || vectors.length !== texts.length)
    throw Error('模型返回的向量数量不匹配')
  vectors.forEach(validateVector)
  if (vectors.some((v) => v.length !== vectors[0].length)) throw Error('向量维度不一致')
  return vectors
}
const defaults = (legacy = false) =>
  legacy
    ? ({
        provider: 'ollama',
        baseURL: OLLAMA_URL,
        model: EMBED_MODEL,
        apiKey: '',
        timeoutMs: 30000
      } as ModelConfig)
    : ({
        provider: 'siliconflow',
        baseURL: '',
        model: '',
        apiKey: '',
        timeoutMs: 30000
      } as ModelConfig)
/** Per-library settings: keys remain on disk and never appear in public status. */
export class ModelProviders {
  private file: string
  private config: ModelConfig
  private legacyDefault: boolean
  private cloudDimension?: { identity: string; value: number }
  private cloudIdentity(c: ModelConfig) {
    return JSON.stringify([c.provider, c.baseURL, c.model])
  }
  constructor(
    root: string,
    private fetcher: typeof fetch = fetch
  ) {
    this.file = join(root, 'embedding-provider.json')
    const marker = join(root, 'v4-active.json')
    this.legacyDefault =
      existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).storage !== 'sqlite-vectors'
    this.config = existsSync(this.file)
      ? normalizeModelConfig(JSON.parse(readFileSync(this.file, 'utf8')))
      : defaults(this.legacyDefault)
    if (existsSync(this.file)) chmodSync(this.file, 0o600)
  }
  isConfigured() {
    return existsSync(this.file) || this.legacyDefault
  }
  status() {
    const { apiKey, ...safe } = this.config
    return { ...safe, hasApiKey: !!apiKey, configured: this.isConfigured() }
  }
  resolve(value: ModelConfig): ModelConfig {
    const c = normalizeModelConfig(value, 'embedding', false)
    if (
      value.apiKey === undefined &&
      c.provider === this.config.provider &&
      c.baseURL === this.config.baseURL
    )
      c.apiKey = this.config.apiKey
    return normalizeModelConfig(c)
  }
  configure(value: ModelConfig) {
    const c = this.resolve(value)
    writeFileSync(this.file + '.tmp', JSON.stringify(c), { mode: 0o600 })
    chmodSync(this.file + '.tmp', 0o600)
    renameSync(this.file + '.tmp', this.file)
    if (this.cloudIdentity(c) !== this.cloudIdentity(this.config)) this.cloudDimension = undefined
    this.config = c
    return this.status()
  }
  readonly io: typeof runtime = {
    request: runtime.request,
    embed: async (texts, signal) => {
      if (!this.isConfigured()) throw Error('请先在AI模型配置向量模型')
      const c = this.config
      const vectors = await embedModel(c, texts, signal, this.fetcher)
      if (c !== this.config) throw Error('调用期间模型配置发生变化，请重试')
      if (isCloudProvider(c.provider) && vectors.length) {
        const previous = this.cloudDimension
        this.cloudDimension = { identity: this.cloudIdentity(c), value: vectors[0].length }
        if (previous && previous.value !== vectors[0].length)
          throw Error('云端模型向量维度已变化，请重建索引')
      }
      return vectors
    },
    fingerprint: async (signal) => {
      if (!this.isConfigured()) throw Error('请先在AI模型配置向量模型')
      const c = this.config
      // Preserve installed default indexes; custom endpoints get a distinct identity.
      if (
        c.provider === 'ollama' &&
        c.baseURL === OLLAMA_URL &&
        c.model === EMBED_MODEL &&
        !c.apiKey
      ) {
        const fingerprint = await runtime.fingerprint(signal)
        if (c !== this.config) throw Error('调用期间模型配置发生变化，请重试')
        return fingerprint
      }
      if (isCloudProvider(c.provider)) {
        const identity = this.cloudIdentity(c)
        if (!this.cloudDimension || this.cloudDimension.identity !== identity) {
          const vectors = await embedModel(c, ['向量索引兼容性检查'], signal, this.fetcher)
          if (c !== this.config) throw Error('调用期间模型配置发生变化，请重试')
          this.cloudDimension = { identity, value: vectors[0].length }
        }
        const dimension = this.cloudDimension.value
        const hash = createHash('sha256').update(identity).digest('hex')
        return `${c.provider}:${hash}:${dimension}:${CHUNK_VERSION}`
      }
      const rows = await listProviderModels(c, signal, this.fetcher)
      const model = rows.find(
        (r) => r.id === c.model || (c.provider === 'ollama' && r.id === c.model + ':latest')
      )
      if (!model) throw Error('模型未安装或尚未启动，请检查模型名称 / UID')
      const vectors = await embedModel(c, ['向量索引兼容性检查'], signal, this.fetcher)
      if (c !== this.config) throw Error('调用期间模型配置发生变化，请重试')
      const identity = createHash('sha256')
        .update(
          JSON.stringify([
            c.provider,
            c.baseURL,
            c.model,
            model.digest || '',
            model.revision || '',
            vectors[0].length
          ])
        )
        .digest('hex')
      return `${c.provider}:${identity}:${vectors[0].length}:${CHUNK_VERSION}`
    }
  }
}
