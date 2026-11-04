import { DatabaseSync, backup } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
export interface Material {
  id?: string
  name: string
  text: string
  modes: string[]
  tags?: string[]
  updatedAt?: number
  deletedAt?: number
  [key: string]: unknown
}
const canonical = (v: any): string =>
  JSON.stringify(
    v === null || typeof v !== 'object'
      ? v
      : Array.isArray(v)
        ? v.map((x) => JSON.parse(canonical(x)))
        : Object.fromEntries(
            Object.keys(v)
              .filter((k) => v[k] !== undefined)
              .sort()
              .map((k) => [k, JSON.parse(canonical(v[k]))])
          )
  )
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
export class Library {
  protected db: DatabaseSync
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    try {
      const version = (this.db.prepare('PRAGMA user_version').get() as any).user_version
      if (version > 6) throw Error('数据库版本高于当前程序支持的版本')
      this.db.exec(
        'PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'
      )
      this.db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS documents(project_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,version TEXT NOT NULL,revision_id TEXT NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER,metadata TEXT NOT NULL,PRIMARY KEY(project_id,id),FOREIGN KEY(project_id) REFERENCES projects(id));
    CREATE TABLE IF NOT EXISTS document_revisions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,doc_id TEXT NOT NULL,parent_id TEXT,text TEXT NOT NULL,text_hash TEXT NOT NULL,created_at INTEGER NOT NULL,FOREIGN KEY(project_id,doc_id) REFERENCES documents(project_id,id));
    CREATE INDEX IF NOT EXISTS revision_document ON document_revisions(project_id,doc_id);
    CREATE TABLE IF NOT EXISTS legacy_imports(project_id TEXT NOT NULL,doc_id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(project_id,doc_id),FOREIGN KEY(project_id,doc_id) REFERENCES documents(project_id,id));
    CREATE TABLE IF NOT EXISTS processing_jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,doc_id TEXT NOT NULL,status TEXT NOT NULL,info TEXT NOT NULL,result TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,FOREIGN KEY(project_id,doc_id) REFERENCES documents(project_id,id));
    CREATE TABLE IF NOT EXISTS analysis_pages(job_id TEXT NOT NULL,page_number INTEGER NOT NULL,result TEXT NOT NULL,PRIMARY KEY(job_id,page_number),FOREIGN KEY(job_id) REFERENCES processing_jobs(id));
    CREATE TABLE IF NOT EXISTS index_generations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,collection TEXT NOT NULL,status TEXT NOT NULL,fingerprint TEXT NOT NULL,manifest TEXT NOT NULL,chunks TEXT NOT NULL,created_at INTEGER NOT NULL,FOREIGN KEY(project_id) REFERENCES projects(id));
    CREATE TABLE IF NOT EXISTS project_activation(project_id TEXT PRIMARY KEY,generation_id TEXT NOT NULL,FOREIGN KEY(project_id) REFERENCES projects(id),FOREIGN KEY(generation_id) REFERENCES index_generations(id));
    CREATE TABLE IF NOT EXISTS source_files(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,hash TEXT NOT NULL,name TEXT NOT NULL,path TEXT NOT NULL,bytes INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(project_id,hash),FOREIGN KEY(project_id) REFERENCES projects(id));
    CREATE TABLE IF NOT EXISTS revision_sources(revision_id TEXT PRIMARY KEY,file_id TEXT NOT NULL,FOREIGN KEY(revision_id) REFERENCES document_revisions(id),FOREIGN KEY(file_id) REFERENCES source_files(id));
    CREATE TABLE IF NOT EXISTS processing_reviews(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,version INTEGER NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL,FOREIGN KEY(job_id) REFERENCES processing_jobs(id));
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,created_at INTEGER NOT NULL);
    INSERT OR IGNORE INTO schema_migrations VALUES(1,unixepoch()*1000);
    INSERT OR IGNORE INTO schema_migrations VALUES(2,unixepoch()*1000);
    INSERT OR IGNORE INTO schema_migrations VALUES(3,unixepoch()*1000);
    INSERT OR IGNORE INTO schema_migrations VALUES(4,unixepoch()*1000);
    PRAGMA user_version=${Math.max(4, version)};COMMIT;`)
      chmodSync(path, 0o600)
    } catch (e) {
      this.db.close()
      throw e
    }
  }
  close() {
    this.db.close()
  }
  async backup(path: string) {
    await backup(this.db, path)
    chmodSync(path, 0o600)
  }
  project(id: string, name: string) {
    this.db
      .prepare('INSERT INTO projects VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name')
      .run(id, name)
  }
  projects() {
    return this.db.prepare('SELECT id,name FROM projects ORDER BY id').all()
  }
  private transactionDepth=0
  protected transaction<T>(fn: () => T): T {
    const depth=this.transactionDepth++,savepoint='nested_'+depth
    try {this.db.exec(depth?'SAVEPOINT '+savepoint:'BEGIN IMMEDIATE')}catch(e){this.transactionDepth--;throw e}
    try {
      const result = fn()
      this.db.exec(depth?'RELEASE SAVEPOINT '+savepoint:'COMMIT')
      return result
    } catch (e) {
      this.db.exec(depth?'ROLLBACK TO SAVEPOINT '+savepoint:'ROLLBACK')
      if(depth)this.db.exec('RELEASE SAVEPOINT '+savepoint)
      throw e
    }finally{this.transactionDepth--}
  }
  private validate(v: Material) {
    if (!v.name?.trim() || !v.text?.trim() || v.text.length > 2_000_000)
      throw Error('资料名称或正文无效')
    if (!Array.isArray(v.modes) || v.modes.some((m) => !['screenshot', 'conversation'].includes(m)))
      throw Error('使用模式无效')
    if (v.tags && (!Array.isArray(v.tags) || v.tags.some((t) => typeof t !== 'string')))
      throw Error('标签无效')
  }
  private insert(project: string, v: Material) {
    this.validate(v)
    const id = v.id || randomUUID(),
      revision = randomUUID(),
      version = typeof v.version === 'string' ? v.version : randomUUID(),
      time = v.updatedAt ?? Date.now()
    const { text, ...metadata } = v
    this.db
      .prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?)')
      .run(
        project,
        id,
        v.name,
        version,
        revision,
        time,
        v.deletedAt ?? null,
        JSON.stringify(metadata)
      )
    this.db
      .prepare('INSERT INTO document_revisions VALUES(?,?,?,?,?,?,?)')
      .run(revision, project, id, null, text, hash(text), time)
    return this.get(project, id)
  }
  create(project: string, v: Material) {
    return this.transaction(() => this.insert(project, v))
  }
  get(project: string, id: string): any {
    const row = this.db
      .prepare(
        'SELECT d.*,r.text,r.text_hash FROM documents d JOIN document_revisions r ON r.id=d.revision_id WHERE d.project_id=? AND d.id=?'
      )
      .get(project, id) as any
    if (!row) throw Error('资料不存在')
    return {
      ...JSON.parse(row.metadata),
      id: row.id,
      name: row.name,
      text: row.text,
      textHash: row.text_hash,
      revisionId: row.revision_id,
      version: row.version,
      updatedAt: row.updated_at,
      ...(row.deleted_at == null ? { deletedAt: undefined } : { deletedAt: row.deleted_at })
    }
  }
  list(project: string, trash = false) {
    return this.db
      .prepare(
        `SELECT id FROM documents WHERE project_id=? AND deleted_at IS ${trash ? 'NOT ' : ''}NULL ORDER BY updated_at,id`
      )
      .all(project)
      .map((r: any) => this.get(project, r.id))
  }
  revisions(project: string, id: string) {
    return this.db
      .prepare(
        'SELECT id,parent_id,text,text_hash,created_at FROM document_revisions WHERE project_id=? AND doc_id=? ORDER BY created_at,rowid'
      )
      .all(project, id)
  }
  update(project: string, id: string, expected: string, patch: Partial<Material>) {
    return this.transaction(() => {
      const old = this.get(project, id)
      if (old.version !== expected) throw Error('资料版本冲突，请刷新后重试')
      const next = { ...old, ...patch, id }
      this.validate(next)
      const rev =
        patch.text !== undefined && patch.text !== old.text ? randomUUID() : old.revisionId
      if (rev !== old.revisionId)
        this.db
          .prepare('INSERT INTO document_revisions VALUES(?,?,?,?,?,?,?)')
          .run(rev, project, id, old.revisionId, next.text, hash(next.text), Date.now())
      const { text, textHash, revisionId, version, ...meta } = next
      void text
      void textHash
      void revisionId
      void version
      this.db
        .prepare(
          'UPDATE documents SET name=?,version=?,revision_id=?,updated_at=?,deleted_at=?,metadata=? WHERE project_id=? AND id=?'
        )
        .run(
          next.name,
          randomUUID(),
          rev,
          Date.now(),
          next.deletedAt ?? null,
          JSON.stringify(meta),
          project,
          id
        )
      return this.get(project, id)
    })
  }
  trash(project: string, id: string, version: string) {
    return this.update(project, id, version, { deletedAt: Date.now() })
  }
  restore(project: string, id: string, version: string) {
    return this.update(project, id, version, { deletedAt: undefined })
  }
  importLegacy(project: string, v: Material) {
    return this.transaction(() => {
      const exists = this.db
        .prepare('SELECT id FROM documents WHERE project_id=? AND id=?')
        .get(project, v.id!)
      if (exists) {
        const ledger = this.db
          .prepare('SELECT fingerprint FROM legacy_imports WHERE project_id=? AND doc_id=?')
          .get(project, v.id!) as any
        if (!ledger || ledger.fingerprint !== hash(canonical(v)))
          throw Error('迁移冲突：已有资料与源记录不一致')
        return 'unchanged'
      }
      this.insert(project, v)
      this.db
        .prepare('INSERT INTO legacy_imports VALUES(?,?,?)')
        .run(project, v.id!, hash(canonical(v)))
      return 'imported'
    })
  }
  /** Atomic replacement of a read snapshot; never deletes omitted documents. */
  replaceProject(project: string, rows: Material[], expected: { id: string; version: string }[]) {
    return this.transaction(() => {
      const current = [...this.list(project), ...this.list(project, true)]
      const versions = new Map(expected.map((d) => [d.id, d.version]))
      if (
        current.length !== expected.length ||
        current.some((d) => versions.get(d.id) !== d.version)
      )
        throw Error('资料版本冲突，请刷新后重试')
      const ids = new Set(rows.map((d) => d.id))
      if (ids.size !== rows.length || current.some((d) => !ids.has(d.id)))
        throw Error('不能遗漏或重复资料，请使用软删除')
      const oldById = new Map(current.map((d) => [d.id, d]))
      const clean = (d: any) => {
        const { version, textHash, revisionId, ...rest } = d
        void version
        void textHash
        void revisionId
        return rest
      }
      for (const row of rows) {
        this.validate(row)
        const old = oldById.get(row.id)
        if (!old) {
          this.insert(project, row)
          continue
        }
        if (canonical(clean(row)) === canonical(clean(old))) continue
        const revision = row.text === old.text ? old.revisionId : randomUUID()
        if (revision !== old.revisionId)
          this.db
            .prepare('INSERT INTO document_revisions VALUES(?,?,?,?,?,?,?)')
            .run(revision, project, row.id!, old.revisionId, row.text, hash(row.text), Date.now())
        const { text, ...meta } = clean(row)
        void text
        const token =
          typeof row.version === 'string' && row.version !== old.version
            ? row.version
            : randomUUID()
        this.db
          .prepare(
            'UPDATE documents SET name=?,version=?,revision_id=?,updated_at=?,deleted_at=?,metadata=? WHERE project_id=? AND id=?'
          )
          .run(
            row.name,
            token,
            revision,
            row.updatedAt ?? Date.now(),
            row.deletedAt ?? null,
            JSON.stringify(meta),
            project,
            row.id!
          )
      }
    })
  }
  queuedJobs(): any[] {
    return this.db
      .prepare(
        "SELECT id,project_id FROM processing_jobs WHERE status='queued' ORDER BY created_at"
      )
      .all()
  }
  claimJob(project: string, id: string) {
    return (
      this.db
        .prepare(
          "UPDATE processing_jobs SET status='scheduled',updated_at=? WHERE project_id=? AND id=? AND status='queued'"
        )
        .run(Date.now(), project, id).changes === 1
    )
  }
  registerSource(project: string, hash: string, name: string, path: string, bytes: number): string {
    const previous = this.db
      .prepare('SELECT id FROM source_files WHERE project_id=? AND hash=?')
      .get(project, hash) as any
    if (previous) return previous.id
    const id = randomUUID()
    this.db
      .prepare('INSERT OR IGNORE INTO source_files VALUES(?,?,?,?,?,?,?)')
      .run(id, project, hash, name, path, bytes, Date.now())
    return (
      this.db
        .prepare('SELECT id FROM source_files WHERE project_id=? AND hash=?')
        .get(project, hash) as any
    ).id
  }
  linkSource(revision: string, file: string) {
    this.db.prepare('INSERT OR REPLACE INTO revision_sources VALUES(?,?)').run(revision, file)
  }
  reviewHistory(project: string, id: string) {
    this.job(project, id)
    return this.db
      .prepare(
        'SELECT id,version,result,created_at FROM processing_reviews WHERE job_id=? ORDER BY created_at,id'
      )
      .all(id)
      .map((r: any) => ({ ...r, result: JSON.parse(r.result) }))
  }
  createJob(project: string, doc: string, info: any) {
    this.get(project, doc)
    const id = randomUUID(),
      now = Date.now()
    this.db
      .prepare('INSERT INTO processing_jobs VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, project, doc, 'queued', JSON.stringify(info), null, null, now, now)
    return this.job(project, id)
  }
  job(project: string, id: string): any {
    const r = this.db
      .prepare('SELECT * FROM processing_jobs WHERE project_id=? AND id=?')
      .get(project, id) as any
    if (!r) throw Error('处理任务不存在')
    return {
      id: r.id,
      project: r.project_id,
      docId: r.doc_id,
      status: r.status,
      info: JSON.parse(r.info),
      result: r.result ? JSON.parse(r.result) : null,
      error: r.error,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }
  }
  jobs(project: string) {
    return this.db
      .prepare('SELECT id FROM processing_jobs WHERE project_id=? ORDER BY created_at DESC')
      .all(project)
      .map((r: any) => this.job(project, r.id))
  }
  setJob(project: string, id: string, status: string, result?: any, error?: string) {
    this.transaction(() => {
      const previous = this.job(project, id)
      this.db
        .prepare(
          'UPDATE processing_jobs SET status=?,result=COALESCE(?,result),error=?,updated_at=? WHERE project_id=? AND id=?'
        )
        .run(
          status,
          result ? JSON.stringify(result) : null,
          error ?? null,
          Math.max(Date.now(), previous.updatedAt + 1),
          project,
          id
        )
      if (result)
        this.db
          .prepare('INSERT INTO processing_reviews VALUES(?,?,?,?,?)')
          .run(randomUUID(), id, previous.updatedAt, JSON.stringify(result), Date.now())
      if (result?.pages)
        for (const page of result.pages)
          this.db
            .prepare(
              'INSERT INTO analysis_pages VALUES(?,?,?) ON CONFLICT(job_id,page_number) DO UPDATE SET result=excluded.result'
            )
            .run(id, page.number, JSON.stringify(page))
    })
    return this.job(project, id)
  }
  recoverJobs() {
    this.db
      .prepare(
        "UPDATE processing_jobs SET status='interrupted',error='服务重启导致任务中断，请重试',updated_at=? WHERE status IN ('scheduled','running','indexing')"
      )
      .run(Date.now())
  }
  generation(project: string, id?: string): any {
    const r = (
      id
        ? this.db
            .prepare('SELECT * FROM index_generations WHERE project_id=? AND id=?')
            .get(project, id)
        : this.db
            .prepare(
              'SELECT g.* FROM index_generations g JOIN project_activation a ON a.generation_id=g.id WHERE a.project_id=?'
            )
            .get(project)
    ) as any
    return r ? { ...r, manifest: JSON.parse(r.manifest), chunks: JSON.parse(r.chunks) } : undefined
  }
  createGeneration(
    project: string,
    collection: string,
    fingerprint: string,
    manifest: any[],
    chunks: any[]
  ) {
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO index_generations VALUES(?,?,?,?,?,?,?,?)')
      .run(
        id,
        project,
        collection,
        'building',
        fingerprint,
        JSON.stringify(manifest),
        JSON.stringify(chunks),
        Date.now()
      )
    return id
  }
  failGeneration(project: string, id: string) {
    this.db
      .prepare("UPDATE index_generations SET status='failed' WHERE project_id=? AND id=?")
      .run(project, id)
  }
  activateGeneration(project: string, id: string, jobId?: string) {
    return this.transaction(() => {
      const gen = this.generation(project, id)
      if (!gen || gen.status !== 'building') throw Error('候选索引状态无效')
      const current = [...this.list(project), ...this.list(project, true)],
        expected = new Map(gen.manifest.map((d: any) => [d.id, d.version]))
      if (
        current.length !== gen.manifest.length ||
        current.some((d) => expected.get(d.id) !== d.version)
      )
        throw Error('构建期间资料发生变化，候选索引不可启用')
      if (jobId) {
        const job = this.job(project, jobId),
          doc = this.get(project, job.docId)
        if (
          !['indexing', 'ready'].includes(job.status) ||
          doc.version !== job.info.expectedVersion ||
          doc.deletedAt
        )
          throw Error('复核版本已过期')
        const text = job.result.cleaned,
          revision = randomUUID(),
          { text: oldText, textHash, revisionId, version, ...meta } = doc
        void oldText
        void textHash
        void revisionId
        void version
        if (job.info.desiredModes) {
          meta.modes = job.info.desiredModes
          meta.pending = false
        }
        meta.sourceHash = job.info.sourceHash
        meta.source = job.info.sourceName
        meta.sourcePath = job.info.inputPath
        meta.processingJob = jobId
        meta.chars = text.length
        meta.tokens = Math.ceil(text.length * 0.8)
        this.db
          .prepare('INSERT INTO document_revisions VALUES(?,?,?,?,?,?,?)')
          .run(revision, project, doc.id, doc.revisionId, text, hash(text), Date.now())
        this.db
          .prepare(
            'UPDATE documents SET revision_id=?,version=?,updated_at=?,metadata=? WHERE project_id=? AND id=?'
          )
          .run(revision, randomUUID(), Date.now(), JSON.stringify(meta), project, doc.id)
        if (job.info.sourceFileId) this.linkSource(revision, job.info.sourceFileId)
        this.db
          .prepare(
            "UPDATE processing_jobs SET status='applied',updated_at=? WHERE project_id=? AND id=?"
          )
          .run(Date.now(), project, jobId)
      }
      this.db
        .prepare(
          "UPDATE index_generations SET status='ready',manifest=? WHERE project_id=? AND id=?"
        )
        .run(JSON.stringify([...this.list(project), ...this.list(project, true)]), project, id)
      this.db
        .prepare(
          'INSERT INTO project_activation VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET generation_id=excluded.generation_id'
        )
        .run(project, id)
      return this.generation(project)
    })
  }
  generations(project: string) {
    return this.db
      .prepare(
        'SELECT id,collection,status,created_at FROM index_generations WHERE project_id=? ORDER BY created_at DESC'
      )
      .all(project)
  }
  rollbackGeneration(project: string, id: string) {
    return this.transaction(() => {
      const target = this.generation(project, id)
      if (!target || target.status !== 'ready') throw Error('回退索引不存在或未就绪')
      const current = [...this.list(project), ...this.list(project, true)],
        saved = new Map(target.manifest.map((d: any) => [d.id, d]))
      if (
        current.length !== target.manifest.length ||
        current.some((d) => {
          const old: any = saved.get(d.id)
          return (
            !old ||
            Boolean(old.deletedAt) !== Boolean(d.deletedAt) ||
            canonical(old.modes) !== canonical(d.modes)
          )
        })
      )
        throw Error('资料数量、删除或启用状态已变化，不能自动回退，请重新复核')
      for (const d of current) {
        const old: any = saved.get(d.id)
        if (typeof old.text !== 'string') throw Error('旧代际缺少正文快照，不能回退')
        const revision = randomUUID(),
          { text, textHash, revisionId, version, ...meta } = old
        void textHash
        void revisionId
        void version
        this.db
          .prepare('INSERT INTO document_revisions VALUES(?,?,?,?,?,?,?)')
          .run(revision, project, d.id, d.revisionId, text, hash(text), Date.now())
        this.db
          .prepare(
            'UPDATE documents SET name=?,version=?,revision_id=?,updated_at=?,metadata=? WHERE project_id=? AND id=?'
          )
          .run(old.name, randomUUID(), revision, Date.now(), JSON.stringify(meta), project, d.id)
      }
      this.db
        .prepare(
          'INSERT INTO project_activation VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET generation_id=excluded.generation_id'
        )
        .run(project, id)
      return this.generation(project)
    })
  }
  integrity() {
    return this.db.prepare('PRAGMA integrity_check').all()
  }
}
