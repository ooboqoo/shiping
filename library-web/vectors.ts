import { buildGeneration, retrieveGeneration } from '../src/main/library/generations'
import { existsSync, readFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { Store, atomic, ApiError } from './store'
import { RagIndex } from '../src/main/rag/index'
import { chunkDocument, revisionOf } from '../src/main/rag/chunks'
import * as client from '../src/main/rag/client'
import { CHROMA_URL, COLLECTION, type RagChunk, type RagHit } from '../src/shared/rag'
export const COLLECTIONS = `${CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database/collections`
export function vectorIO(store: Store, project: string) {
  const name = store.collection(project),
    state = join(store.path(project), 'active-structure-v2.json')
  if (!name.startsWith('rag_admin_') || name === COLLECTION)
    throw new ApiError(400, '此集合不能由网页直接写入')
  async function collection(write = false) {
    const c = await client.request<{ id: string }>(
      write ? COLLECTIONS : `${COLLECTIONS}/${name}`,
      write
        ? {
            name,
            get_or_create: true,
            configuration: { hnsw: { space: 'cosine' } }
          }
        : undefined
    )
    return `${COLLECTIONS}/${c.id}`
  }
  return {
    fingerprint: client.fingerprint,
    embed: client.embed,
    async upsert(chunks: RagChunk[], embeddings: number[][]) {
      await client.request((await collection(true)) + '/upsert', {
        ids: chunks.map((c) => c.id),
        documents: chunks.map((c) => c.text),
        embeddings,
        metadatas: chunks.map((c) => ({
          docId: c.docId,
          revision: c.revision,
          section: c.section ?? '',
          start: c.start,
          end: c.end
        }))
      })
    },
    async query(vector: number[], ids: string[], signal?: AbortSignal): Promise<RagHit[]> {
      const r = await client.request<any>(
        (await collection()) + '/query',
        {
          query_embeddings: [vector],
          ids,
          n_results: Math.min(24, ids.length),
          include: ['documents', 'metadatas', 'distances']
        },
        signal
      )
      if (!r.ids?.[0]?.length) throw new Error('向量集合为空，请重新建立索引')
      return r.ids[0].map((id: string, i: number) => ({
        id,
        ...r.metadatas[0][i],
        text: r.documents[0][i],
        score: 1 - r.distances[0][i],
        name: ''
      }))
    },
    async remove(ids: string[]) {
      if (ids.length) await client.request((await collection()) + '/delete', { ids })
    },
    async save(value: unknown) {
      await atomic(state, value)
    },
    load() {
      if (!existsSync(state)) return undefined
      if (lstatSync(state).isSymbolicLink()) throw new Error('索引记录不能是链接文件')
      return JSON.parse(readFileSync(state, 'utf8'))
    }
  }
}
type IO = ConstructorParameters<typeof RagIndex>[0]
export class Indexes {
  private building = new Map<string, Promise<unknown>>()
  private indexes = new Map<string, RagIndex>()
  constructor(
    private store: Store,
    private factory: (id: string) => IO = (id) => vectorIO(store, id)
  ) {}
  private async current(project: string) {
    const docs = await this.store.list(project, { text: true })
    let index = this.indexes.get(project)
    if (!index) {
      index = new RagIndex(this.factory(project))
      this.indexes.set(project, index)
    }
    index.setDocuments(
      docs.map((d) => ({
        id: d.id,
        name: d.name,
        text: d.text,
        modes: d.modes,
        revision: revisionOf(d.text)
      }))
    )
    return { index, docs }
  }
  async status(project: string) {
    const gen = this.store.getLibrary()?.generation(project)
    if (gen)
      return {
        state: this.building.has(project) ? 'indexing' : 'ready',
        message: '结构化索引',
        documents: (await this.store.list(project)).length,
        chunks: gen.chunks.length
      }
    return (await this.current(project)).index.getStatus()
  }
  async rebuild(project: string, force = false) {
    const library = this.store.getLibrary()
    if (library?.generation(project)) {
      const previous = this.building.get(project) || Promise.resolve()
      const job = previous.catch(() => {}).then(() => buildGeneration(library, project))
      this.building.set(project, job)
      void job
        .catch(() => {})
        .finally(() => {
          if (this.building.get(project) === job) this.building.delete(project)
        })
      return this.status(project)
    }
    const { index, docs } = await this.current(project)
    const job = index.reconcile(
      docs.map((d) => ({
        id: d.id,
        name: d.name,
        text: d.text,
        modes: d.modes,
        revision: revisionOf(d.text)
      })),
      force
    )
    void job.catch(() => {})
    return index.getStatus()
  }
  async search(project: string, query: unknown, mode: unknown = 'conversation') {
    if (typeof query !== 'string' || !query.trim() || query.length > 2000)
      throw new ApiError(400, '请输入1至2000字符的问题')
    if (mode !== 'screenshot' && mode !== 'conversation') throw new ApiError(400, '无效的检索模式')
    const library = this.store.getLibrary(),
      structured = library ? await retrieveGeneration(library, project, query, mode) : undefined
    const hits = structured ?? (await (await this.current(project)).index.retrieve(mode, query))
    const live = await this.store.list(project, { text: true })
    return hits.filter((h) =>
      live.some(
        (d) => d.id === h.docId && revisionOf(d.text) === h.revision && d.modes.includes(mode)
      )
    )
  }
  async chunks(project: string, id: string, offset = 0, limit = 50) {
    const doc = await this.store.get(project, id),
      chunks = chunkDocument(doc.id, doc.text)
    return {
      items: chunks.slice(offset, offset + limit),
      total: chunks.length,
      offset,
      limit,
      preview: true
    }
  }
}
