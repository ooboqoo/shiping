import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Catalog } from './catalog'
import type * as runtime from './runtime'

const BASE = '/api/v2/tenants/default_tenant/databases/default_database/collections'
const PAGE_SIZE = 128
interface Collection {
  id: string
  name: string
  dimension: number | null
}
interface VectorRow {
  id: string
  vector: Uint8Array
  norm: number
  document: string | null
  metadata: string | null
}

interface VectorRequest {
  ids?: string[]
  embeddings?: unknown[]
  documents?: string[]
  metadatas?: unknown[]
  name?: string
  get_or_create?: boolean
  query_embeddings?: unknown[]
  n_results?: number
}
/** Embedded, exact cosine search. The collection URL is only an internal protocol; never fetched. */
export class EmbeddedVectorStore {
  private db: DatabaseSync
  private closed = false
  private migration = { restored: 0, missing: 0 }
  private coverageCache = new Map<string, { restored: number; missing: number }>()
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS collections(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,dimension INTEGER);
      CREATE TABLE IF NOT EXISTS vectors(collection TEXT NOT NULL,id TEXT NOT NULL,vector BLOB NOT NULL,norm REAL NOT NULL,document TEXT,metadata TEXT,PRIMARY KEY(collection,id),FOREIGN KEY(collection) REFERENCES collections(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS migrations(generation TEXT PRIMARY KEY);`)
    chmodSync(file, 0o600)
  }
  private check(signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (this.closed) throw Error('本地向量库已关闭')
  }
  private collection(key: string): Collection {
    const result = this.db.prepare('SELECT * FROM collections WHERE id=? OR name=?').get(key, key)
    if (!result) throw Error('本地向量库 HTTP 404：集合不存在，请重建索引')
    return result as unknown as Collection
  }
  private create(name: string, getOrCreate = false): Collection {
    if (typeof name !== 'string' || !name.length) throw Error('本地向量集合名称无效')
    const found = this.db.prepare('SELECT * FROM collections WHERE name=?').get(name)
    if (found) {
      if (!getOrCreate) throw Error('本地向量集合已存在')
      return found as unknown as Collection
    }
    const id = randomUUID()
    this.db.prepare('INSERT INTO collections VALUES(?,?,NULL)').run(id, name)
    return this.collection(id)
  }
  private vector(value: unknown, dimension?: number | null) {
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.some((v) => typeof v !== 'number' || !Number.isFinite(v))
    )
      throw Error('本地向量必须为有限数值')
    if (dimension != null && value.length !== dimension) throw Error('向量维度不一致')
    const data = Buffer.allocUnsafe(value.length * 4)
    let squared = 0
    for (let i = 0; i < value.length; i++) {
      const number = Math.fround(value[i])
      if (!Number.isFinite(number)) throw Error('本地向量超出Float32范围')
      data.writeFloatLE(number, i * 4)
      squared += number * number
    }
    if (!squared) throw Error('本地向量不能为零向量')
    return { data, norm: Math.sqrt(squared), dimension: value.length }
  }
  private upsert(collection: Collection, body: VectorRequest) {
    if (
      !Array.isArray(body.ids) ||
      !Array.isArray(body.embeddings) ||
      body.ids.length !== body.embeddings.length ||
      body.ids.some((id: unknown) => typeof id !== 'string' || !id) ||
      new Set(body.ids).size !== body.ids.length ||
      (body.documents && body.documents.length !== body.ids.length) ||
      (body.metadatas && body.metadatas.length !== body.ids.length)
    )
      throw Error('本地向量批次格式无效')
    const dimension =
      collection.dimension ??
      (Array.isArray(body.embeddings[0]) ? body.embeddings[0].length : undefined)
    const rows = body.embeddings.map((v: unknown, i: number) => ({
      ...this.vector(v, dimension),
      id: body.ids![i],
      document: body.documents?.[i] ?? null,
      metadata: body.metadatas?.[i] == null ? null : JSON.stringify(body.metadatas[i])
    }))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (rows.length)
        this.db
          .prepare('UPDATE collections SET dimension=? WHERE id=?')
          .run(dimension ?? rows[0].dimension, collection.id)
      const insert = this.db.prepare(
        'INSERT INTO vectors VALUES(?,?,?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET vector=excluded.vector,norm=excluded.norm,document=excluded.document,metadata=excluded.metadata'
      )
      for (const row of rows)
        insert.run(collection.id, row.id, row.data, row.norm, row.document, row.metadata)
      this.db.exec('COMMIT')
      this.coverageCache.clear()
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  readonly request: typeof runtime.request = async <T>(
    url: string,
    input?: unknown,
    signal?: AbortSignal,
    method?: string
  ): Promise<T> => {
    this.check(signal)
    const parsed = new URL(url)
    if (
      parsed.origin !== 'http://127.0.0.1:18000' ||
      !(parsed.pathname === BASE || parsed.pathname.startsWith(BASE + '/'))
    )
      throw Error('本地向量适配器拒绝未知地址')
    const parts = parsed.pathname
      .slice(BASE.length)
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent)
    const body = (input || {}) as VectorRequest
    let result: unknown
    if (!parts.length) {
      if (input === undefined)
        result = this.db.prepare('SELECT * FROM collections ORDER BY name').all()
      else result = this.create(body.name || '', body.get_or_create === true)
    } else {
      const collection = this.collection(parts[0])
      if (parts.length > 2) throw Error('本地向量操作无效')
      if (parts.length === 1) {
        if (method === 'DELETE') {
          this.db.prepare('DELETE FROM collections WHERE id=?').run(collection.id)
          this.coverageCache.clear()
          result = {}
        } else result = collection
      } else if (parts[1] === 'upsert') {
        this.upsert(collection, body)
        result = {}
      } else if (parts[1] === 'get') {
        const rows: VectorRow[] = []
        if (body.ids !== undefined) {
          if (!Array.isArray(body.ids)) throw Error('本地向量编号无效')
          const select = this.db.prepare('SELECT * FROM vectors WHERE collection=? AND id=?')
          for (const id of new Set<string>(body.ids)) {
            const row = select.get(collection.id, id)
            if (row) rows.push(row as unknown as VectorRow)
          }
        } else
          rows.push(
            ...(this.db
              .prepare('SELECT * FROM vectors WHERE collection=? ORDER BY id')
              .all(collection.id) as unknown as VectorRow[])
          )
        result = {
          ids: rows.map((r) => r.id),
          documents: rows.map((r) => r.document),
          metadatas: rows.map((r) => (r.metadata ? JSON.parse(r.metadata) : null))
        }
      } else if (parts[1] === 'delete') {
        if (!Array.isArray(body.ids)) throw Error('本地向量删除必须指定编号')
        const remove = this.db.prepare('DELETE FROM vectors WHERE collection=? AND id=?')
        this.db.exec('BEGIN IMMEDIATE')
        try {
          for (const id of body.ids) remove.run(collection.id, id)
          this.db.exec('COMMIT')
        } catch (error) {
          this.db.exec('ROLLBACK')
          throw error
        }
        this.coverageCache.clear()
        result = {}
      } else if (parts[1] === 'query') result = await this.query(collection, body, signal)
      else throw Error('本地向量操作无效')
    }
    this.check(signal)
    return result as T
  }
  private async query(collection: Collection, body: VectorRequest, signal?: AbortSignal) {
    if (
      !Array.isArray(body.query_embeddings) ||
      typeof body.n_results !== 'number' ||
      !Number.isInteger(body.n_results) ||
      body.n_results < 0 ||
      (body.ids !== undefined && !Array.isArray(body.ids))
    )
      throw Error('本地向量查询格式无效')
    const queries = body.query_embeddings.map((v: unknown) => this.vector(v, collection.dimension))
    const allowed = body.ids === undefined ? undefined : new Set<string>(body.ids)
    const k = Math.min(body.n_results, allowed?.size ?? body.n_results)
    const best: { id: string; distance: number }[][] = queries.map(() => [])
    let cursor = ''
    const page = this.db.prepare(
      'SELECT id,vector,norm FROM vectors WHERE collection=? AND id>? ORDER BY id LIMIT ?'
    )
    if (k)
      for (;;) {
        this.check(signal)
        const rows = page.all(collection.id, cursor, PAGE_SIZE) as unknown as VectorRow[]
        if (!rows.length) break
        for (const row of rows) {
          cursor = row.id
          if (allowed && !allowed.has(row.id)) continue
          const vector = Buffer.from(
            row.vector.buffer,
            row.vector.byteOffset,
            row.vector.byteLength
          )
          if (vector.length !== queries[0]?.data.length) throw Error('本地向量维度损坏，请重建索引')
          for (let q = 0; q < queries.length; q++) {
            let dot = 0
            for (let i = 0; i < vector.length; i += 4)
              dot += vector.readFloatLE(i) * queries[q].data.readFloatLE(i)
            const distance = 1 - Math.max(-1, Math.min(1, dot / (row.norm * queries[q].norm)))
            const hits = best[q]
            if (hits.length >= k && distance >= hits[hits.length - 1].distance) continue
            let position = hits.findIndex((hit) => hit.distance > distance)
            if (position === -1) position = hits.length
            hits.splice(position, 0, { id: row.id, distance })
            if (hits.length > k) hits.pop()
          }
        }
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    this.check(signal)
    return {
      ids: best.map((row) => row.map((hit) => hit.id)),
      distances: best.map((row) => row.map((hit) => hit.distance))
    }
  }
  /** One import per generation; missing/corrupt cache entries remain missing for repair. No model calls. */
  migrate(catalog: Catalog) {
    this.check()
    for (const project of catalog.projects())
      for (const info of catalog.generations(String(project.id))) {
        const id = String(info.id)
        if (this.db.prepare('SELECT 1 FROM migrations WHERE generation=?').get(id)) continue
        const generation = catalog.generation(String(project.id), id)
        if (!generation) continue
        let collection = this.create(generation.collection, true)
        const seen = new Set<string>()
        const fingerprintDimension = Number(generation.fingerprint.split(':').at(-2))
        const expectedDimension =
          Number.isInteger(fingerprintDimension) && fingerprintDimension > 0
            ? fingerprintDimension
            : collection.dimension
        let batch: { id: string; vector: number[]; text: string; metadata: object }[] = []
        const flush = () => {
          if (!batch.length) return
          this.upsert(collection, {
            ids: batch.map((r) => r.id),
            embeddings: batch.map((r) => r.vector),
            documents: batch.map((r) => r.text),
            metadatas: batch.map((r) => r.metadata)
          })
          collection = this.collection(collection.id)
          batch = []
        }
        for (const chunk of generation.chunks) {
          if (!chunk.vectorKey || !chunk.inputHash || seen.has(chunk.vectorKey)) continue
          seen.add(chunk.vectorKey)
          let vector: number[] | undefined
          try {
            vector = catalog.cachedVector(generation.fingerprint, chunk.inputHash)
            if (!vector) continue
            this.vector(
              vector,
              expectedDimension ?? collection.dimension ?? batch[0]?.vector.length
            )
          } catch {
            continue
          } // A corrupt cache entry stays missing; storage errors below must propagate.
          batch.push({
            id: chunk.vectorKey,
            vector,
            text: chunk.text || '',
            metadata: {
              inputHash: chunk.inputHash,
              docId: chunk.docId,
              fingerprint: generation.fingerprint
            }
          })
          if (batch.length >= PAGE_SIZE) flush()
        }
        flush()
        this.db.prepare('INSERT OR IGNORE INTO migrations VALUES(?)').run(id)
      }
    this.summarizeMigration(catalog)
  }
  migrationStatus() {
    return { ...this.migration }
  }
  coverage(generation: {
    id: string
    collection: string
    fingerprint: string
    chunks: { id?: string; vectorKey?: string; inputHash?: string }[]
  }) {
    this.check()
    const cached = this.coverageCache.get(generation.id)
    if (cached) return cached
    const result = { restored: 0, missing: 0 }
    const seen = new Set<string>()
    for (const [index, chunk] of generation.chunks.entries()) {
      const key = chunk?.vectorKey || chunk?.id || `legacy-${index}`
      if (seen.has(key)) continue
      seen.add(key)
      if (
        this.matches(
          generation.collection,
          chunk?.vectorKey,
          chunk?.inputHash,
          generation.fingerprint
        )
      )
        result.restored++
      else result.missing++
    }
    this.coverageCache.set(generation.id, result)
    return result
  }
  private matches(collection: unknown, id: unknown, inputHash: unknown, fingerprint: unknown) {
    if (
      typeof collection !== 'string' ||
      typeof id !== 'string' ||
      !id ||
      typeof inputHash !== 'string' ||
      !inputHash ||
      typeof fingerprint !== 'string'
    )
      return false
    const row = this.db
      .prepare(
        'SELECT v.metadata FROM vectors v JOIN collections c ON c.id=v.collection WHERE c.name=? AND v.id=?'
      )
      .get(collection, id)
    if (!row || typeof row.metadata !== 'string') return false
    try {
      const metadata = JSON.parse(row.metadata)
      return metadata.inputHash === inputHash && metadata.fingerprint === fingerprint
    } catch {
      return false
    }
  }
  private summarizeMigration(catalog: Catalog) {
    this.migration = { restored: 0, missing: 0 }
    const seen = new Set<string>()
    for (const project of catalog.projects())
      for (const info of catalog.generations(String(project.id))) {
        const generation = catalog.generation(String(project.id), String(info.id))
        if (!generation) continue
        for (const [index, chunk] of generation.chunks.entries()) {
          const key = JSON.stringify([
            generation.collection,
            chunk?.vectorKey || chunk?.id || `legacy-${index}`
          ])
          if (seen.has(key)) continue
          seen.add(key)
          if (
            this.matches(
              generation.collection,
              chunk?.vectorKey,
              chunk?.inputHash,
              generation.fingerprint
            )
          )
            this.migration.restored++
          else this.migration.missing++
        }
      }
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}
