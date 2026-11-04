import { randomUUID } from 'node:crypto'
import { Catalog } from './catalog'
import {
  canonicalMarkdown,
  markdownChunks,
  digest,
  MARKDOWN_VERSION,
  SPLIT_VERSION
} from './markdown'
import { frequencies, tokens } from './terms'
import * as client from './runtime'
import { validateVector } from '../rag/chunks'
export const COLLECTIONS =
  'http://127.0.0.1:18000/api/v2/tenants/default_tenant/databases/default_database/collections'
export interface IndexStats {
  kind: 'incremental' | 'full'
  generation: string
  chunks: number
  computed: number
  written: number
  reused: number
  removed: number
  reason?: string
}
export class IndexEngine {
  constructor(
    private catalog: Catalog,
    private io = client
  ) {}
  async build(
    project: string,
    kind: 'incremental' | 'full',
    signal?: AbortSignal,
    lease?: { id: string; owner: string }
  ): Promise<IndexStats> {
    signal?.throwIfAborted()
    const state = this.catalog.projectInfo(project),
      docs = [...this.catalog.list(project), ...this.catalog.list(project, true)],
      active = this.catalog.generation(project),
      format = MARKDOWN_VERSION + ':' + SPLIT_VERSION,
      fp = await this.io.fingerprint(signal),
      previousInfo = active && this.catalog.generationInfo(active.id)
    let reason: string | undefined
    if (active && (active.fingerprint !== fp || previousInfo?.format !== format)) {
      kind = 'full'
      reason = '模型或规则版本变化，执行全量重建'
    }
    const stats: IndexStats = {
        kind,
        generation: active?.id || '',
        chunks: 0,
        computed: 0,
        written: 0,
        reused: 0,
        removed: 0,
        ...(reason ? { reason } : {})
      },
      chunks: any[] = []
    for (const doc of docs.filter((d) => !d.deletedAt && !d.pending && d.modes.length)) {
      if (canonicalMarkdown(doc.text) !== doc.text)
        throw Error('资料尚未规范化为Markdown，请先完成转换')
      const task = doc.processingTask ? this.catalog.task(String(doc.processingTask)) : undefined
      const report = task
        ? { info: task.payload, result: task.result }
        : doc.processingJob
          ? this.catalog.job(project, String(doc.processingJob))
          : undefined
      const reusable =
        active && previousInfo?.format === format
          ? active.chunks.filter((c: any) => c.docId === doc.id && c.revision === digest(doc.text))
          : []
      for (const c of reusable.length ? reusable : markdownChunks(doc.id, doc.text))
        chunks.push({
          ...c,
          name: doc.name,
          modes: doc.modes,
          tokenCount: tokens(c.input).length,
          sourceName: doc.source || doc.name,
          pages:
            report?.info.ext === 'pdf' && report.result?.cleaned === doc.text
              ? [
                  ...new Set(
                    (report.result.sources || [])
                      .filter((s: any) => s.start < c.end && s.end > c.start)
                      .map((s: any) => s.page)
                  )
                ]
              : []
        })
    }
    stats.chunks = chunks.length
    const previousKeys = new Set<string>(active?.chunks.map((c: any) => c.vectorKey) || []),
      keys = new Set<string>(chunks.map((c) => c.vectorKey))
    stats.removed = [...previousKeys].filter((k) => !keys.has(k)).length
    const unique = [...new Map(chunks.map((c) => [c.vectorKey, c])).values()],
      verifiedKeys = new Set<string>()
    const sparseNeeded = unique
      .map((c) => ({ c, terms: frequencies(c.input) }))
      .filter(({ c, terms }) => !this.catalog.postingMatches(project, c.vectorKey, terms))
    let existingRemote: any
    if (kind === 'incremental' && active) {
      try {
        existingRemote = await this.io.request<any>(
          `${COLLECTIONS}/${active.collection}`,
          undefined,
          signal
        )
        for (let offset = 0; offset < unique.length; offset += 500) {
          const batch = unique.slice(offset, offset + 500),
            found = await this.io.request<any>(
              `${COLLECTIONS}/${existingRemote.id}/get`,
              { ids: batch.map((c) => c.vectorKey), include: ['metadatas'] },
              signal
            ),
            expected = new Map(batch.map((c) => [c.vectorKey, c.inputHash]))
          for (let i = 0; i < (found.ids?.length || 0); i++) {
            const key = found.ids[i]
            if (
              expected.has(key) &&
              found.metadatas?.[i]?.inputHash === expected.get(key) &&
              found.metadatas?.[i]?.fingerprint === fp
            )
              verifiedKeys.add(key)
          }
        }
      } catch (error) {
        if (!/HTTP\s*404/.test(String(error))) throw error
        kind = 'full'
        stats.kind = 'full'
        stats.reason = '活动集合丢失，转为全量重建'
        existingRemote = undefined
      }
    }
    if (
      kind === 'incremental' &&
      active &&
      verifiedKeys.size === unique.length &&
      previousInfo?.format === format &&
      docs.length === active.manifest.length &&
      docs.every((d) =>
        active.manifest.some((old: any) => old.id === d.id && old.version === d.version)
      )
    ) {
      if ((await this.io.fingerprint(signal)) !== fp) throw Error('构建期间模型发生变化')
      this.catalog.writePostings(
        project,
        sparseNeeded.flatMap(({ c, terms }) =>
          [...terms].map(([term, tf]) => ({ term, chunk: c.vectorKey, tf }))
        )
      )
      stats.reused = keys.size
      return stats
    }
    const collection =
      kind === 'incremental' && active && previousInfo?.format === format
        ? active.collection
        : `shiping_${project.replace(/[^a-z0-9]/gi, '')}_v4_${randomUUID().replaceAll('-', '')}`
    const id = this.catalog.createGeneration(project, collection, fp, docs, chunks)
    stats.generation = id
    try {
      let remote: any
      if (collection === active?.collection)
        remote =
          existingRemote ||
          (await this.io.request<any>(`${COLLECTIONS}/${collection}`, undefined, signal))
      else {
        this.catalog.ownCollection(collection, project, fp)
        remote = await this.io.request<any>(
          COLLECTIONS,
          { name: collection, get_or_create: false, configuration: { hnsw: { space: 'cosine' } } },
          signal
        )
      }
      const needed = unique.filter((c) => kind === 'full' || !verifiedKeys.has(c.vectorKey))
      stats.reused = unique.length - needed.length
      let expectedDim: number | undefined = Number(fp.split(':').at(-2)) || undefined
      for (let offset = 0; offset < needed.length; offset += 8) {
        signal?.throwIfAborted()
        const batch = needed.slice(offset, offset + 8),
          vectors: (number[] | undefined)[] = batch.map((c) =>
            kind === 'full' ? undefined : this.catalog.cachedVector(fp, c.inputHash)
          ),
          missing = batch.filter((_, i) => !vectors[i])
        const computed = missing.length
          ? await this.io.embed(
              missing.map((c) => c.input),
              signal
            )
          : []
        let cursor = 0
        stats.computed += computed.length
        for (let i = 0; i < batch.length; i++) {
          if (!vectors[i]) vectors[i] = computed[cursor++]
          const vector = vectors[i]!
          validateVector(vector)
          expectedDim ??= vector.length
          if (vector.length !== expectedDim) throw Error('向量维度不一致')
          this.catalog.cacheVector(fp, batch[i].inputHash, vector)
        }
        await this.io.request(
          `${COLLECTIONS}/${remote.id}/upsert`,
          {
            ids: batch.map((c) => c.vectorKey),
            documents: batch.map((c) => c.text),
            embeddings: vectors,
            metadatas: batch.map((c) => ({
              inputHash: c.inputHash,
              docId: c.docId,
              fingerprint: fp
            }))
          },
          signal
        )
        stats.written += batch.length
      }
      for (let offset = 0; offset < unique.length; offset += 500) {
        const batch = unique.slice(offset, offset + 500),
          result = await this.io.request<any>(
            `${COLLECTIONS}/${remote.id}/get`,
            { ids: batch.map((c) => c.vectorKey), include: ['metadatas'] },
            signal
          ),
          expected = new Map(batch.map((c) => [c.vectorKey, c.inputHash]))
        if (
          result.ids?.length !== batch.length ||
          new Set(result.ids).size !== batch.length ||
          result.ids.some(
            (key: string, i: number) =>
              !expected.has(key) ||
              result.metadatas?.[i]?.inputHash !== expected.get(key) ||
              result.metadatas?.[i]?.fingerprint !== fp
          )
        )
          throw Error('候选向量编号或内容哈希校验失败')
      }
      stats.reused = unique.length - stats.computed
      if ((await this.io.fingerprint(signal)) !== fp) throw Error('构建期间模型发生变化')
      this.catalog.writePostings(
        project,
        sparseNeeded.flatMap(({ c, terms }) =>
          [...terms].map(([term, tf]) => ({ term, chunk: c.vectorKey, tf }))
        )
      )
      this.catalog.recordGeneration(id, state.version, stats, format)
      signal?.throwIfAborted()
      this.catalog.publish(project, id, state.version, lease)
      return stats
    } catch (error) {
      this.catalog.failGeneration(project, id)
      throw error
    }
  }
}
