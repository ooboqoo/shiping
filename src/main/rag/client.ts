import { OLLAMA_URL, CHROMA_URL, EMBED_MODEL, COLLECTION, CHUNK_VERSION } from '../../shared/rag'
import type { RagChunk, RagHit } from '../../shared/rag'
import { validateVector } from './chunks'
const BASE = '/api/v2/tenants/default_tenant/databases/default_database/collections'
export async function request<T>(
  url: string,
  body?: unknown,
  signal?: AbortSignal,
  method?: string
): Promise<T> {
  signal?.throwIfAborted()
  const timeout = AbortSignal.timeout(30000)
  const res = await fetch(url, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  })
  if (!res.ok) throw new Error(`本地检索服务 HTTP ${res.status}，请检查服务和索引`)
  return (await res.json()) as T
}
export async function embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const r = await request<{ embeddings: number[][] }>(
    `${OLLAMA_URL}/api/embed`,
    { model: EMBED_MODEL, input: texts, truncate: false, keep_alive: '5m' },
    signal
  )
  if (!Array.isArray(r.embeddings) || r.embeddings.length !== texts.length)
    throw new Error('本地模型返回的向量数量不匹配')
  r.embeddings.forEach(validateVector)
  const dim = r.embeddings[0]?.length
  if (r.embeddings.some((v) => v.length !== dim)) throw new Error('向量维度不一致')
  return r.embeddings
}
export async function fingerprint(signal?: AbortSignal): Promise<string> {
  const r = await request<{ models: { name: string; digest: string }[] }>(
    `${OLLAMA_URL}/api/tags`,
    undefined,
    signal
  )
  const model = r.models.find((m) => m.name === EMBED_MODEL || m.name === `${EMBED_MODEL}:latest`)
  if (!model) throw new Error('尚未安装 BGE-M3，请先下载本地模型')
  const v = await embed(['向量索引兼容性检查'], signal)
  return `${EMBED_MODEL}:${model.digest}:${v[0].length}:${CHUNK_VERSION}`
}
async function collection(signal?: AbortSignal): Promise<string> {
  const r = await request<{ id: string }>(
    CHROMA_URL + BASE,
    { name: COLLECTION, get_or_create: true, configuration: { hnsw: { space: 'cosine' } } },
    signal
  )
  return `${CHROMA_URL}${BASE}/${r.id}`
}
export async function upsert(chunks: RagChunk[], vectors: number[][]): Promise<void> {
  if (!chunks.length) return
  const path = await collection()
  await request(path + '/upsert', {
    ids: chunks.map((c) => c.id),
    embeddings: vectors,
    documents: chunks.map((c) => c.text),
    metadatas: chunks.map((c) => ({
      docId: c.docId,
      section: c.section ?? '',
      revision: c.revision,
      start: c.start,
      end: c.end
    }))
  })
}
export async function searchVectors(
  query: number[],
  ids: string[],
  signal?: AbortSignal
): Promise<RagHit[]> {
  if (!ids.length) return []
  const existing = await request<{ id: string }>(
    CHROMA_URL + BASE + '/' + COLLECTION,
    undefined,
    signal
  )
  const path = `${CHROMA_URL}${BASE}/${existing.id}`
  const r = await request<{
    ids: string[][]
    documents: string[][]
    metadatas: { docId: string; revision: string; start: number; end: number; section?: string }[][]
    distances: number[][]
  }>(
    path + '/query',
    {
      query_embeddings: [query],
      ids,
      n_results: Math.min(24, ids.length),
      include: ['documents', 'metadatas', 'distances']
    },
    signal
  )
  if (!r.ids[0]?.length) throw new Error('向量索引为空或已丢失，请点击建立 / 更新索引重新生成')
  return r.ids[0].map((id, i) => ({
    id,
    ...r.metadatas[0][i],
    text: r.documents[0][i],
    score: 1 - r.distances[0][i],
    name: ''
  }))
}
export async function remove(ids: string[]): Promise<void> {
  if (ids.length) await request((await collection()) + '/delete', { ids })
}
export async function clearProjectIndex(): Promise<void> {
  await request(CHROMA_URL + BASE + '/' + COLLECTION, undefined, undefined, 'DELETE')
}
export async function checkServices(): Promise<string> {
  await request(CHROMA_URL + '/api/v2/heartbeat')
  return fingerprint()
}
