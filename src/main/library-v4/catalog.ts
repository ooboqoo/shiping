import { planDocumentPurge, deleteDocumentRecords } from './document-purge'
import { randomUUID } from 'node:crypto'
import { Library } from '../library/repository'
import { ChatCatalog, CHAT_SCHEMA } from './chat-catalog'
export class Catalog extends Library {
  readonly chat: ChatCatalog
  constructor(path: string) {
    super(path)
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS v4_projects(id TEXT PRIMARY KEY,version TEXT NOT NULL,deleted_at INTEGER,FOREIGN KEY(id) REFERENCES projects(id));
      CREATE TABLE IF NOT EXISTS v4_project_names(id TEXT PRIMARY KEY,version TEXT NOT NULL,FOREIGN KEY(id) REFERENCES projects(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS v4_tasks(id TEXT PRIMARY KEY,project TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,owner TEXT,lease INTEGER NOT NULL DEFAULT 0,result TEXT,error TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,FOREIGN KEY(project) REFERENCES projects(id));
      CREATE TABLE IF NOT EXISTS v5_uploads(project TEXT NOT NULL,id TEXT NOT NULL,source_hash TEXT NOT NULL,source_name TEXT NOT NULL,doc_id TEXT NOT NULL,job_id TEXT NOT NULL,PRIMARY KEY(project,id),FOREIGN KEY(job_id) REFERENCES v4_tasks(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS v4_task_queue ON v4_tasks(status,created);
      CREATE TABLE IF NOT EXISTS v4_cleanup(project TEXT PRIMARY KEY,version TEXT NOT NULL,FOREIGN KEY(project) REFERENCES projects(id));
      CREATE TABLE IF NOT EXISTS v4_clear(id TEXT PRIMARY KEY,project TEXT NOT NULL,documents TEXT NOT NULL,restored INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS v4_vectors(fingerprint TEXT NOT NULL,input_hash TEXT NOT NULL,vector TEXT NOT NULL,PRIMARY KEY(fingerprint,input_hash));
      CREATE TABLE IF NOT EXISTS v4_collections(name TEXT PRIMARY KEY,project TEXT NOT NULL,fingerprint TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS v4_generation(id TEXT PRIMARY KEY,project_version TEXT NOT NULL,stats TEXT NOT NULL,format TEXT NOT NULL,FOREIGN KEY(id) REFERENCES index_generations(id));
      CREATE TABLE IF NOT EXISTS v4_postings(project TEXT NOT NULL,term TEXT NOT NULL,chunk TEXT NOT NULL,tf INTEGER NOT NULL,PRIMARY KEY(project,term,chunk),FOREIGN KEY(project) REFERENCES projects(id));
      CREATE INDEX IF NOT EXISTS v4_posting_chunk ON v4_postings(project,chunk);
      CREATE INDEX IF NOT EXISTS v4_posting_term ON v4_postings(project,term);
      ${CHAT_SCHEMA}
      INSERT OR IGNORE INTO schema_migrations VALUES(5,unixepoch()*1000);
      INSERT OR IGNORE INTO schema_migrations VALUES(6,unixepoch()*1000);PRAGMA user_version=6;COMMIT;`)
    this.chat = new ChatCatalog(
      this.db,
      (p) => this.projectInfo(p),
      (fn) => this.atomic(fn)
    )
  }
  documentPurgeTask(project: string, id?: string): any {
    return this.tasks(project).find(
      (j) =>
        j.kind === 'purge-document' &&
        ['queued', 'running', 'failed'].includes(j.status) &&
        (!id || j.payload.docId === id)
    )
  }
  update(project: string, id: string, version: string, fields: any) {
    if (this.documentPurgeTask(project, id)) throw Error('资料永久清理已开始，只能重试清理')
    return super.update(project, id, version, fields)
  }
  rollbackGeneration(project: string, id: string) {
    if (this.documentPurgeTask(project)) throw Error('资料永久清理中，不能回退索引')
    return super.rollbackGeneration(project, id)
  }
  documentPurgePlan(project: string, id: string, version: string) {
    return planDocumentPurge(this, this.db, project, id, version)
  }
  deleteDocumentRecords(
    project: string,
    id: string,
    version: string,
    removeFiles: (paths: string[]) => void
  ) {
    return this.atomic(() => {
      const plan = this.documentPurgePlan(project, id, version)
      removeFiles(plan.paths)
      deleteDocumentRecords(this.db, plan)
      return { deleted: true, docId: id, backupsRetained: true }
    })
  }
  requeueDocumentPurge(id: string) {
    this.db
      .prepare(
        "UPDATE v4_tasks SET status='queued',owner=NULL,lease=0,error=NULL,updated=? WHERE id=? AND kind='purge-document' AND status='failed'"
      )
      .run(Date.now(), id)
  }
  uploadRecord(project: string, id: string): any {
    return this.db.prepare('SELECT * FROM v5_uploads WHERE project=? AND id=?').get(project, id)
  }
  recordUpload(
    project: string,
    id: string,
    hash: string,
    name: string,
    docId: string,
    jobId: string
  ) {
    const old = this.uploadRecord(project, id)
    if (old && (old.source_hash !== hash || old.source_name !== name || old.doc_id !== docId))
      throw Error('提交编号已用于其他文件')
    this.db
      .prepare('INSERT OR IGNORE INTO v5_uploads VALUES(?,?,?,?,?,?)')
      .run(project, id, hash, name, docId, jobId)
  }
  withLease<T>(id: string, owner: string, fn: () => T): T {
    return this.transaction(() => {
      if (!this.owns(id, owner)) throw Error('任务租约已失效')
      return fn()
    })
  }
  atomic<T>(fn: () => T): T {
    return this.transaction(fn)
  }
  projectInfo(id: string, includeTrash = false): any {
    const project = this.projects().find((p: any) => p.id === id)
    if (!project) throw Error('知识库不存在')
    this.db.prepare('INSERT OR IGNORE INTO v4_projects VALUES(?,?,NULL)').run(id, randomUUID())
    const state = this.db.prepare('SELECT * FROM v4_projects WHERE id=?').get(id) as any
    if (state.deleted_at && !includeTrash) throw Error('知识库已删除')
    this.db.prepare('INSERT OR IGNORE INTO v4_project_names VALUES(?,?)').run(id, state.version)
    const nameState = this.db
      .prepare('SELECT version FROM v4_project_names WHERE id=?')
      .get(id) as any
    return {
      ...project,
      version: state.version,
      nameVersion: nameState.version,
      deletedAt: state.deleted_at || undefined
    }
  }
  projectList(trash = false) {
    return this.projects()
      .map((p: any) => this.projectInfo(p.id, true))
      .filter((p) => Boolean(p.deletedAt) === trash)
  }
  projectName(value: unknown, exceptId?: string): string {
    if (typeof value !== 'string') throw Error('知识库名称应为1至80字符')
    const name = value.trim()
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name))
      throw Error('知识库名称应为1至80字符，且不能包含控制字符')
    if (
      this.projectList().some(
        (p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase()
      )
    )
      throw Error('知识库名称已存在，请使用其他名称')
    return name
  }
  renameProject(id: string, value: unknown, version: string) {
    return this.transaction(() => {
      const info = this.projectInfo(id)
      if (this.db.prepare('SELECT project FROM v4_cleanup WHERE project=?').get(id))
        throw Error('永久清理已开始，只能重试清理')
      if (info.nameVersion !== version) throw Error('知识库版本冲突，请刷新后重试')
      const name = this.projectName(value, id)
      if (name !== info.name) {
        this.db.prepare('UPDATE projects SET name=? WHERE id=?').run(name, id)
        this.db.prepare('UPDATE v4_project_names SET version=? WHERE id=?').run(randomUUID(), id)
      }
      return this.projectInfo(id)
    })
  }
  setProjectState(id: string, version: string, deleted: boolean) {
    return this.transaction(() => {
      const info = this.projectInfo(id, true)
      if (this.documentPurgeTask(id)) throw Error('资料永久清理未完成，请先重试清理')
      if (this.db.prepare('SELECT project FROM v4_cleanup WHERE project=?').get(id))
        throw Error('永久清理已开始，只能重试清理')
      if (info.version !== version) throw Error('知识库版本冲突，请刷新')
      if (!deleted) this.projectName(info.name, id)
      if (deleted && id === 'shiping') throw Error('内置知识库请使用清空资料库')
      this.db
        .prepare('UPDATE v4_projects SET version=?,deleted_at=? WHERE id=?')
        .run(randomUUID(), deleted ? Date.now() : null, id)
      if (deleted)
        this.db
          .prepare(
            "UPDATE v4_tasks SET status='cancelled',lease=0,updated=? WHERE project=? AND status IN ('queued','running')"
          )
          .run(Date.now(), id)
      return this.projectInfo(id, true)
    })
  }
  clearProject(project: string, version: string) {
    return this.transaction(() => {
      if (this.projectInfo(project).version !== version) throw Error('知识库版本冲突')
      const docs = this.list(project),
        id = randomUUID(),
        now = Date.now(),
        saved: any[] = []
      for (const d of docs) {
        const token = randomUUID()
        this.db
          .prepare(
            'UPDATE documents SET deleted_at=?,version=?,updated_at=? WHERE project_id=? AND id=?'
          )
          .run(now, token, now, project, d.id)
        saved.push({ id: d.id, version: token })
      }
      this.db
        .prepare('INSERT INTO v4_clear VALUES(?,?,?,0)')
        .run(id, project, JSON.stringify(saved))
      this.db.prepare('UPDATE v4_projects SET version=? WHERE id=?').run(randomUUID(), project)
      this.db
        .prepare(
          "UPDATE v4_tasks SET status='cancelled',lease=0 WHERE project=? AND status IN ('queued','running')"
        )
        .run(project)
      return id
    })
  }
  clearHistory(project: string): any[] {
    return this.db
      .prepare('SELECT id,documents,restored FROM v4_clear WHERE project=? ORDER BY rowid DESC')
      .all(project)
      .map((r: any) => ({
        id: r.id,
        documents: JSON.parse(r.documents).length,
        restored: Boolean(r.restored)
      }))
  }
  restoreClear(project: string, id: string) {
    return this.transaction(() => {
      this.projectInfo(project)
      const batch = this.db
        .prepare('SELECT * FROM v4_clear WHERE id=? AND project=?')
        .get(id, project) as any
      if (!batch || batch.restored) throw Error('清空记录不存在或已恢复')
      for (const d of JSON.parse(batch.documents)) {
        if (this.documentPurgeTask(project, d.id)) throw Error('资料永久清理中，不能恢复')
        const live = this.get(project, d.id)
        if (live.deletedAt && live.version === d.version)
          this.db
            .prepare(
              'UPDATE documents SET deleted_at=NULL,version=?,updated_at=? WHERE project_id=? AND id=?'
            )
            .run(randomUUID(), Date.now(), project, d.id)
      }
      this.db.prepare('UPDATE v4_clear SET restored=1 WHERE id=?').run(id)
      this.db.prepare('UPDATE v4_projects SET version=? WHERE id=?').run(randomUUID(), project)
    })
  }
  activeDocuments(project: string, mode?: string): any[] {
    const info = this.projectInfo(project, true)
    if (info.deletedAt) return []
    const generation = this.generation(project)
    if (!generation) return []
    const current = new Map(this.list(project).map((d) => [d.id, d]))
    return generation.manifest
      .filter((d: any) => current.has(d.id) && !d.deletedAt && !d.pending)
      .map((d: any) => ({
        ...d,
        ...current.get(d.id),
        text: d.text,
        revisionId: d.revisionId,
        textHash: d.textHash,
        activeVersion: d.version
      }))
      .filter((d: any) => !mode || d.modes.includes(mode))
  }
  publish(
    project: string,
    id: string,
    projectVersion: string,
    lease?: { id: string; owner: string }
  ) {
    return this.transaction(() => {
      const state = this.projectInfo(project)
      if (this.documentPurgeTask(project)) throw Error('资料永久清理中，不能启用索引')
      if (state.version !== projectVersion) throw Error('知识库发生变化，拒绝启用')
      if (lease && !this.owns(lease.id, lease.owner)) throw Error('任务已中断或租约过期')
      const gen = this.generation(project, id)
      if (!gen || gen.status !== 'building') throw Error('候选状态无效')
      const current = [...this.list(project), ...this.list(project, true)],
        byId = new Map(gen.manifest.map((d: any) => [d.id, d.version]))
      if (
        current.length !== gen.manifest.length ||
        current.some((d) => byId.get(d.id) !== d.version)
      )
        throw Error('资料发生变化，拒绝启用')
      this.db.prepare("UPDATE index_generations SET status='ready' WHERE id=?").run(id)
      this.db
        .prepare(
          'INSERT INTO project_activation VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET generation_id=excluded.generation_id'
        )
        .run(project, id)
      return this.generation(project)
    })
  }
  generationInfo(id: string): any {
    const r = this.db.prepare('SELECT * FROM v4_generation WHERE id=?').get(id) as any
    return r ? { ...r, stats: JSON.parse(r.stats) } : undefined
  }
  recordGeneration(id: string, projectVersion: string, stats: any, format: string) {
    this.db
      .prepare('INSERT OR REPLACE INTO v4_generation VALUES(?,?,?,?)')
      .run(id, projectVersion, JSON.stringify(stats), format)
  }
  ownCollection(name: string, project: string, fingerprint: string) {
    this.db
      .prepare('INSERT INTO v4_collections VALUES(?,?,?,?)')
      .run(name, project, fingerprint, Date.now())
  }
  collections(project: string): any[] {
    return this.db.prepare('SELECT * FROM v4_collections WHERE project=?').all(project)
  }
  cachedVector(fingerprint: string, inputHash: string): number[] | undefined {
    const r = this.db
      .prepare('SELECT vector FROM v4_vectors WHERE fingerprint=? AND input_hash=?')
      .get(fingerprint, inputHash) as any
    return r ? JSON.parse(r.vector) : undefined
  }
  cacheVector(fingerprint: string, inputHash: string, vector: number[]) {
    this.db
      .prepare('INSERT OR REPLACE INTO v4_vectors VALUES(?,?,?)')
      .run(fingerprint, inputHash, JSON.stringify(vector))
  }
  postingMatches(project: string, chunk: string, expected: Map<string, number>): boolean {
    const rows = this.db
      .prepare('SELECT term,tf FROM v4_postings WHERE project=? AND chunk=?')
      .all(project, chunk) as { term: string; tf: number }[]
    return rows.length === expected.size && rows.every((r) => expected.get(r.term) === r.tf)
  }
  writePostings(generation: string, postings: { term: string; chunk: string; tf: number }[]) {
    this.transaction(() => {
      const insert = this.db.prepare('INSERT OR REPLACE INTO v4_postings VALUES(?,?,?,?)')
      for (const p of postings) insert.run(generation, p.term, p.chunk, p.tf)
    })
  }
  postings(generation: string, terms: string[]): any[] {
    const result: any[] = []
    const get = this.db.prepare('SELECT term,chunk,tf FROM v4_postings WHERE project=? AND term=?')
    for (const term of new Set(terms)) result.push(...get.all(generation, term))
    return result
  }
  enqueue(project: string, kind: string, payload: any): any {
    return this.transaction(() => {
      this.projectInfo(project)
      if (kind === 'index') {
        const queued = this.db
          .prepare(
            "SELECT id,payload FROM v4_tasks WHERE project=? AND kind='index' AND status='queued' ORDER BY created LIMIT 1"
          )
          .get(project) as any
        if (queued) {
          const old = JSON.parse(queued.payload)
          this.db.prepare('UPDATE v4_tasks SET payload=?,updated=? WHERE id=?').run(
            JSON.stringify({
              ...old,
              ...payload,
              kind: old.kind === 'full' || payload.kind === 'full' ? 'full' : 'incremental'
            }),
            Date.now(),
            queued.id
          )
          return this.task(queued.id)
        }
      }
      const id = randomUUID(),
        now = Date.now()
      this.db
        .prepare(
          "INSERT INTO v4_tasks(id,project,kind,status,payload,created,updated) VALUES(?,?,?,'queued',?,?,?)"
        )
        .run(id, project, kind, JSON.stringify(payload), now, now)
      return this.task(id)
    })
  }
  task(id: string): any {
    const r = this.db.prepare('SELECT * FROM v4_tasks WHERE id=?').get(id) as any
    if (!r) throw Error('任务不存在')
    return {
      ...r,
      payload: JSON.parse(r.payload),
      result: r.result ? JSON.parse(r.result) : undefined
    }
  }
  tasks(project?: string): any[] {
    return (
      project
        ? this.db
            .prepare('SELECT id FROM v4_tasks WHERE project=? ORDER BY created DESC')
            .all(project)
        : this.db.prepare('SELECT id FROM v4_tasks ORDER BY created DESC').all()
    ).map((r: any) => this.task(r.id))
  }
  claim(id: string, owner: string, now = Date.now(), ttl = 30000) {
    return this.transaction(() => {
      const task = this.task(id)
      this.projectInfo(task.project)
      if (
        task.kind === 'index' &&
        this.db
          .prepare(
            "SELECT id FROM v4_tasks WHERE project=? AND kind='index' AND id!=? AND status='running' AND lease>?"
          )
          .get(task.project, id, now)
      )
        return false
      return (
        this.db
          .prepare(
            "UPDATE v4_tasks SET status='running',owner=?,lease=?,updated=? WHERE id=? AND (status='queued' OR (status='running' AND lease<=?))"
          )
          .run(owner, now + ttl, now, id, now).changes === 1
      )
    })
  }
  owns(id: string, owner: string, now = Date.now()) {
    return Boolean(
      this.db
        .prepare("SELECT id FROM v4_tasks WHERE id=? AND owner=? AND status='running' AND lease>?")
        .get(id, owner, now)
    )
  }
  heartbeat(id: string, owner: string, now = Date.now(), ttl = 30000) {
    return (
      this.db
        .prepare(
          "UPDATE v4_tasks SET lease=?,updated=? WHERE id=? AND owner=? AND status='running' AND lease>?"
        )
        .run(now + ttl, now, id, owner, now).changes === 1
    )
  }
  taskProgress(id: string, owner: string, progress: unknown) {
    return (
      this.db
        .prepare(
          "UPDATE v4_tasks SET result=?,updated=? WHERE id=? AND owner=? AND status='running' AND lease>?"
        )
        .run(JSON.stringify({ progress }), Date.now(), id, owner, Date.now()).changes === 1
    )
  }
  finish(
    id: string,
    owner: string,
    status: string,
    result?: any,
    now = Date.now(),
    error?: string
  ) {
    return (
      this.db
        .prepare(
          "UPDATE v4_tasks SET status=?,result=?,error=?,lease=0,updated=? WHERE id=? AND owner=? AND status='running' AND lease>?"
        )
        .run(status, result ? JSON.stringify(result) : null, error ?? null, now, id, owner, now)
        .changes === 1
    )
  }
  cancelTask(id: string) {
    this.db
      .prepare(
        "UPDATE v4_tasks SET status='cancelled',lease=0,updated=? WHERE id=? AND status IN ('queued','running')"
      )
      .run(Date.now(), id)
  }
  beginPurge(project: string, version: string) {
    this.transaction(() => {
      if (this.purgePlan(project).version !== version) throw Error('知识库版本冲突')
      this.db.prepare('INSERT OR IGNORE INTO v4_cleanup VALUES(?,?)').run(project, version)
    })
  }
  purgePlan(project: string) {
    const state = this.projectInfo(project, true)
    if (!state.deletedAt || project === 'shiping') throw Error('请先将独立知识库移入回收站')
    const originals = this.db
      .prepare('SELECT path FROM source_files WHERE project_id=?')
      .all(project) as any[]
    return {
      ...state,
      documents: this.list(project).length + this.list(project, true).length,
      chatSessions: (
        this.db
          .prepare('SELECT count(*) AS n FROM chat_sessions WHERE project=?')
          .get(project) as any
      ).n,
      chatTurns: (
        this.db
          .prepare(
            'SELECT count(*) AS n FROM chat_turns WHERE session IN (SELECT id FROM chat_sessions WHERE project=?)'
          )
          .get(project) as any
      ).n,
      collections: this.collections(project),
      paths: originals
        .map((r) => r.path)
        .filter(
          (path) =>
            !this.db
              .prepare('SELECT id FROM source_files WHERE path=? AND project_id!=? LIMIT 1')
              .get(path, project)
        )
    }
  }
  purgeRecords(project: string, version: string) {
    return this.transaction(() => {
      if (this.purgePlan(project).version !== version) throw Error('知识库版本冲突')
      const candidates = this.generations(project).flatMap((g) =>
        this.generation(project, String(g.id))
          .chunks.map((c: any) => c.inputHash)
          .filter(Boolean)
      )
      this.db
        .prepare(
          'DELETE FROM revision_sources WHERE revision_id IN (SELECT id FROM document_revisions WHERE project_id=?)'
        )
        .run(project)
      for (const table of ['analysis_pages', 'processing_reviews'])
        this.db
          .prepare(
            `DELETE FROM ${table} WHERE job_id IN (SELECT id FROM processing_jobs WHERE project_id=?)`
          )
          .run(project)
      this.db.prepare('DELETE FROM processing_jobs WHERE project_id=?').run(project)
      this.db.prepare('DELETE FROM legacy_imports WHERE project_id=?').run(project)
      this.db.prepare('DELETE FROM project_activation WHERE project_id=?').run(project)
      this.db
        .prepare(
          'DELETE FROM v4_generation WHERE id IN (SELECT id FROM index_generations WHERE project_id=?)'
        )
        .run(project)
      this.db.prepare('DELETE FROM index_generations WHERE project_id=?').run(project)
      this.db.prepare('DELETE FROM document_revisions WHERE project_id=?').run(project)
      this.db.prepare('DELETE FROM documents WHERE project_id=?').run(project)
      this.db.prepare('DELETE FROM source_files WHERE project_id=?').run(project)
      for (const table of ['v4_tasks', 'v4_clear', 'v4_collections', 'v4_postings', 'v4_cleanup'])
        this.db.prepare(`DELETE FROM ${table} WHERE project=?`).run(project)
      this.db.prepare('DELETE FROM v4_projects WHERE id=?').run(project)
      this.db.prepare('DELETE FROM chat_sessions WHERE project=?').run(project)
      this.db.prepare('DELETE FROM projects WHERE id=?').run(project)
      const remaining = new Set<string>()
      for (const p of this.projects())
        for (const gen of this.generations(String(p.id)))
          for (const c of this.generation(String(p.id), String(gen.id)).chunks)
            if (c.inputHash) remaining.add(c.inputHash)
      for (const inputHash of new Set<string>(candidates))
        if (!remaining.has(inputHash))
          this.db.prepare('DELETE FROM v4_vectors WHERE input_hash=?').run(inputHash)
    })
  }
}
