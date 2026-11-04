import { randomUUID } from 'node:crypto'
import { Library } from './repository'
import * as client from '../rag/client'
import { chunkDocument, embeddingText, rankHits, revisionOf, lexicalScore } from '../rag/chunks'
import type { RagHit } from '../../shared/rag'
const base =
  'http://127.0.0.1:18000/api/v2/tenants/default_tenant/databases/default_database/collections'
export async function buildGeneration(
  library: Library,
  project: string,
  jobId?: string,
  io = client
) {
  const docs = [...library.list(project), ...library.list(project, true)],
    job = jobId ? library.job(project, jobId) : undefined
  if (job && (!['ready', 'indexing'].includes(job.status) || !job.result?.complete))
    throw Error('请先完成结果复核')
  if (job && !job.result.cleaned.replace(/^#{1,3} .*$/gm, '').trim())
    throw Error('没有可用于索引的正文，请保留空白报告或补充资料')
  if (job && library.get(project, job.docId).version !== job.info.expectedVersion)
    throw Error('资料已修改，请重新处理')
  const manifest = docs.map((d) => ({ ...d })),
    fingerprint = await io.fingerprint(),
    chunks: any[] = []
  for (const d of docs.filter((d) => !d.deletedAt && (d.modes.length || job?.docId === d.id))) {
    const approved =
      job?.docId === d.id
        ? job
        : d.processingJob
          ? library.job(project, d.processingJob)
          : undefined
    const text = job?.docId === d.id ? job.result.cleaned : d.text,
      report = approved?.result?.cleaned === text ? approved.result : undefined
    for (const c of chunkDocument(d.id, text)) {
      const origins = report?.sources?.filter((s: any) => s.start < c.end && s.end > c.start) || []
      chunks.push({
        ...c,
        name: d.name,
        modes: job?.docId === d.id && job.info.desiredModes ? job.info.desiredModes : d.modes,
        sourceName: job?.docId === d.id ? job.info.sourceName : d.source || d.name,
        pages: approved?.info.ext === 'pdf' ? [...new Set(origins.map((s: any) => s.page))] : []
      })
    }
  }
  const collection =
    (project === 'shiping'
      ? 'shiping_knowledge_bgem3_v3_'
      : `rag_admin_${project.replaceAll('-', '')}_v3_`) + randomUUID().replaceAll('-', '')
  const id = library.createGeneration(project, collection, fingerprint, manifest, chunks)
  if (job) library.setJob(project, job.id, 'indexing')
  try {
    const remote = await io.request<any>(base, {
      name: collection,
      get_or_create: false,
      configuration: { hnsw: { space: 'cosine' } }
    })
    for (let i = 0; i < chunks.length; i += 16) {
      const batch = chunks.slice(i, i + 16),
        vectors = await io.embed(batch.map(embeddingText))
      await io.request(`${base}/${remote.id}/upsert`, {
        ids: batch.map((c) => c.id),
        documents: batch.map((c) => c.text),
        embeddings: vectors,
        metadatas: batch.map((c) => ({
          docId: c.docId,
          revision: c.revision,
          sourceName: c.sourceName,
          pages: c.pages.join(','),
          generation: id
        }))
      })
    }
    const count = await io.request<number>(`${base}/${remote.id}/count`)
    if (count !== chunks.length) throw Error('候选向量数量校验失败')
    const expected = new Set(chunks.map((c) => c.id)),
      seen = new Set<string>()
    for (let offset = 0; offset < chunks.length; offset += 500) {
      const batch = await io.request<{ ids: string[] }>(`${base}/${remote.id}/get`, {
        offset,
        limit: 500,
        include: []
      })
      if (!Array.isArray(batch.ids) || batch.ids.some((key) => !expected.has(key) || seen.has(key)))
        throw Error('候选分片编号校验失败')
      batch.ids.forEach((key) => seen.add(key))
    }
    if (seen.size !== expected.size) throw Error('候选分片编号不完整')
    if ((await io.fingerprint()) !== fingerprint) throw Error('构建期间模型指纹发生变化，请重试')
    library.activateGeneration(project, id, jobId)
    return library.generation(project)
  } catch (e) {
    library.failGeneration(project, id)
    if (job) library.setJob(project, job.id, 'ready', undefined, String((e as Error).message || e))
    throw e
  }
}
export async function retrieveGeneration(
  library: Library,
  project: string,
  query: string,
  mode: string,
  signal?: AbortSignal
): Promise<RagHit[] | undefined> {
  const generation = library.generation(project)
  if (!generation) return undefined
  if ((await client.fingerprint(signal)) !== generation.fingerprint)
    throw Error('向量模型已变化，请重建结构化索引')
  const live = () => library.list(project).filter((d) => d.modes.includes(mode)),
    docs = live(),
    byId = new Map(docs.map((d) => [d.id, d]))
  const chunks = generation.chunks.filter((c: any) => {
    const d = byId.get(c.docId)
    return d && revisionOf(d.text) === c.revision && c.modes.includes(mode)
  })
  if (!chunks.length) return []
  const remote = await client.request<any>(base + '/' + generation.collection, undefined, signal),
    vector = (await client.embed([query], signal))[0]
  const response = await client.request<any>(
    `${base}/${remote.id}/query`,
    {
      query_embeddings: [vector],
      ids: chunks.map((c: any) => c.id),
      n_results: Math.min(24, chunks.length),
      include: ['distances']
    },
    signal
  )
  const indexed = new Map(chunks.map((c: any) => [c.id, c])),
    semantic = response.ids[0].map((id: string, i: number) => ({
      ...(indexed.get(id) as any),
      score: 1 - response.distances[0][i]
    }))
  const lexical = chunks
    .filter((c: any) => lexicalScore(query, embeddingText(c)) > 0.05)
    .map((c: any) => ({ ...c, score: lexicalScore(query, embeddingText(c)) }))
  const fresh = new Map(live().map((d) => [d.id, d]))
  return rankHits(query, semantic, lexical).filter((h) => {
    const d = fresh.get(h.docId)
    return d && revisionOf(d.text) === h.revision
  })
}
