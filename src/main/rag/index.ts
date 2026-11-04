import type { AppMode } from '../../shared/api-profile'
import type { RagChunk, RagDocument, RagHit, RagStatus } from '../../shared/rag'
import { chunkDocument, embeddingText, lexicalScore, rankHits } from './chunks'
interface Saved {
  fingerprint: string
  revisions: Record<string, string>
  ids: string[]
  garbage?: string[]
}
interface IO {
  fingerprint(signal?: AbortSignal): Promise<string>
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>
  upsert(chunks: RagChunk[], vectors: number[][]): Promise<void>
  query(vector: number[], ids: string[], signal?: AbortSignal): Promise<RagHit[]>
  remove(ids: string[]): Promise<void>
  save(value: Saved): Promise<void>
  load(): Saved | undefined
}
export class RagIndex {
  private docs: RagDocument[] = []
  private saved: Saved | undefined
  private serial: Promise<void> = Promise.resolve()
  private pending = 0
  private status: RagStatus = { state: 'idle', message: '尚未建立索引', documents: 0, chunks: 0 }
  constructor(private io: IO) {
    try {
      const loaded = io.load()
      if (
        loaded &&
        (typeof loaded.fingerprint !== 'string' || !loaded.revisions || !Array.isArray(loaded.ids))
      )
        throw new Error('索引状态损坏')
      this.saved = loaded
      if (loaded)
        this.status = {
          state: 'ready',
          message: '已载入本地索引',
          documents: Object.keys(loaded.revisions).length,
          chunks: loaded.ids.length
        }
    } catch {
      this.status = {
        state: 'error',
        message: '索引状态损坏，请重新建立索引',
        documents: 0,
        chunks: 0
      }
    }
  }
  setDocuments(docs: RagDocument[]): void {
    this.docs = structuredClone(docs)
    if (this.saved && this.docs.some((d) => this.saved!.revisions[d.id] !== d.revision))
      this.status = { ...this.status, state: 'error', message: '资料已变化，请建立 / 更新索引' }
  }
  getStatus(): RagStatus {
    return this.pending
      ? { ...this.status, state: 'indexing', message: '正在建立本地索引' }
      : { ...this.status }
  }
  invalidate(): void {
    this.saved = undefined
    this.status = { state: 'idle', message: '索引已清除，请重新建立', documents: 0, chunks: 0 }
  }
  reconcile(docs: RagDocument[], force = false): Promise<void> {
    this.setDocuments(docs)
    this.pending++
    const job = async () => {
      this.status = { ...this.status, state: 'indexing', message: '正在建立本地索引' }
      const written: string[] = []
      const previousIds = new Set(this.saved?.ids ?? [])
      try {
        const fp = await this.io.fingerprint(),
          before = this.saved
        const next: Saved = { fingerprint: fp, revisions: {}, ids: [] }
        const snapshot = structuredClone(this.docs)
        for (const doc of snapshot) {
          const cs = chunkDocument(doc.id, doc.text)
          if (force || before?.fingerprint !== fp || before.revisions[doc.id] !== doc.revision) {
            for (let i = 0; i < cs.length; i += 4) {
              const batch = cs.slice(i, i + 4)
              const vectors = await this.io.embed(batch.map(embeddingText))
              written.push(...batch.map((c) => c.id))
              await this.io.upsert(batch, vectors)
            }
          }
          // A concurrent edit/delete cannot be committed as current.
          const live = this.docs.find((d) => d.id === doc.id)
          if (live?.revision === doc.revision) {
            next.revisions[doc.id] = doc.revision
            next.ids.push(...cs.map((c) => c.id))
          }
        }
        const obsolete = [
          ...new Set([...(before?.ids ?? []), ...(before?.garbage ?? []), ...written])
        ].filter((id) => !next.ids.includes(id))
        next.garbage = obsolete
        await this.io.save(next)
        this.saved = next
        await this.io.remove(obsolete)
        if (obsolete.length) {
          const clean = { ...next, garbage: [] }
          await this.io.save(clean)
          this.saved = clean
        }
        const stale = this.docs.some((d) => next.revisions[d.id] !== d.revision)
        this.status = {
          state: stale ? 'error' : 'ready',
          message: stale ? '资料已变化，请重建索引' : '索引就绪',
          documents: Object.keys(next.revisions).length,
          chunks: next.ids.length
        }
      } catch (e) {
        const protectedIds = new Set([...previousIds, ...(this.saved?.ids ?? [])])
        await this.io.remove(written.filter((id) => !protectedIds.has(id))).catch(() => {})
        this.status = {
          ...this.status,
          state: 'error',
          message: e instanceof Error ? e.message : String(e)
        }
        throw e
      }
    }
    const current = this.serial.then(job).finally(() => {
      this.pending--
    })
    this.serial = current.catch(() => {})
    return current
  }
  async retrieve(mode: AppMode, query: string, signal?: AbortSignal): Promise<RagHit[]> {
    signal?.throwIfAborted()
    const eligible = this.docs.filter((d) => d.modes.includes(mode))
    if (!eligible.length) return []
    if (this.pending) throw new Error('资料索引正在更新，请稍后重试')
    const saved = this.saved
    if (!saved || eligible.some((d) => saved.revisions[d.id] !== d.revision))
      throw new Error('资料索引尚未就绪或已过期，请重建索引')
    if (saved.fingerprint !== (await this.io.fingerprint(signal)))
      throw new Error('本地模型已变化，请重建索引')
    const vector = (await this.io.embed([query], signal))[0]
    const chunks = eligible.flatMap((d) =>
      chunkDocument(d.id, d.text).map((c) => ({ ...c, name: d.name, score: 0 }))
    )
    const hits = await this.io.query(
      vector,
      chunks.map((c) => c.id),
      signal
    )
    signal?.throwIfAborted()
    const allowed = new Map(chunks.map((c) => [c.id, c]))
    const semantic = hits
      .filter((h) => allowed.has(h.id))
      .map((h) => ({ ...allowed.get(h.id)!, score: h.score }))
    const lexical = chunks
      .map((c) => ({ ...c, score: lexicalScore(query, embeddingText(c)) }))
      .sort((a, b) => b.score - a.score)
    // Re-check current revisions and permissions after all awaited work.
    return rankHits(query, semantic, lexical).filter((h) =>
      this.docs.some((d) => d.id === h.docId && d.revision === h.revision && d.modes.includes(mode))
    )
  }
}
