import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/** Retain vectors and originals still referenced by any other document. */
export function planDocumentPurge(
  catalog: any,
  db: DatabaseSync,
  project: string,
  id: string,
  version: string
) {
  catalog.projectInfo(project)
  const doc = catalog.get(project, id)
  if (!doc.deletedAt) throw Error('请先将资料移入回收站')
  if (doc.version !== version) throw Error('资料版本已修改，请刷新')
  const generations = catalog
    .generations(project)
    .map((g: any) => catalog.generation(project, g.id))
  const grouped = new Map<string, { candidates: Set<string>; shared: Set<string> }>()
  const hashes = new Set<string>(),
    keys = new Set<string>()
  for (const gen of generations) {
    const group = grouped.get(gen.collection) || {
      candidates: new Set<string>(),
      shared: new Set<string>()
    }
    for (const c of gen.chunks) {
      if (c.docId === id) {
        group.candidates.add(c.vectorKey)
        keys.add(c.vectorKey)
        if (c.inputHash) hashes.add(c.inputHash)
      } else group.shared.add(c.vectorKey)
    }
    grouped.set(gen.collection, group)
  }
  const retainedHashes = new Set<string>(),
    retainedKeys = new Set<string>()
  for (const p of catalog.projects())
    for (const g of catalog.generations(p.id))
      for (const c of catalog.generation(p.id, g.id).chunks)
        if (p.id !== project || c.docId !== id) {
          if (c.inputHash) retainedHashes.add(c.inputHash)
          if (p.id === project) retainedKeys.add(c.vectorKey)
        }
  const tasks = catalog
    .tasks(project)
    .filter((j: any) => j.payload.docId === id && j.kind !== 'purge-document')
  const files = db
    .prepare(
      `SELECT DISTINCT f.* FROM source_files f WHERE f.project_id=? AND (
    f.id IN (SELECT rs.file_id FROM revision_sources rs JOIN document_revisions r ON r.id=rs.revision_id WHERE r.project_id=? AND r.doc_id=?) OR f.path=?)`
    )
    .all(project, project, id, doc.sourcePath || '') as any[]
  for (const task of tasks) {
    const file =
      task.payload.sourceFileId &&
      db
        .prepare('SELECT * FROM source_files WHERE id=? AND project_id=?')
        .get(task.payload.sourceFileId, project)
    if (file && !files.some((f) => f.id === (file as any).id)) files.push(file)
  }
  const allDocs = catalog.projects().flatMap((p: any) =>
    [...catalog.list(p.id), ...catalog.list(p.id, true)].map((d: any) => ({
      ...d,
      project: p.id
    }))
  )
  const otherTasks = catalog
    .tasks()
    .filter((j: any) => j.project !== project || j.payload.docId !== id)
  const removableFiles = files.filter(
    (f) =>
      !db
        .prepare(
          `SELECT 1 FROM revision_sources rs JOIN document_revisions r ON r.id=rs.revision_id WHERE rs.file_id=? AND (r.project_id!=? OR r.doc_id!=?) LIMIT 1`
        )
        .get(f.id, project, id) &&
      !allDocs.some(
        (d: any) => (d.project !== project || d.id !== id) && d.sourcePath === f.path
      ) &&
      !otherTasks.some(
        (j: any) => j.payload.sourceFileId === f.id || j.payload.sourcePath === f.path
      )
  )
  const paths = [...new Set(removableFiles.map((f) => f.path))].filter(
    (path) =>
      !(db.prepare('SELECT id FROM source_files WHERE path=?').all(path) as any[]).some(
        (f) => !removableFiles.some((r) => r.id === f.id)
      )
  )
  const turns = (
    db
      .prepare(
        `SELECT t.id,t.payload FROM chat_turns t JOIN chat_sessions s ON s.id=t.session WHERE s.project=?`
      )
      .all(project) as any[]
  )
    .filter((t) => (JSON.parse(t.payload).sources || []).some((s: any) => s.docId === id))
    .map((t) => t.id)
  return {
    project,
    id,
    version,
    generations,
    tasks,
    fileIds: removableFiles.map((f) => f.id),
    paths,
    turns,
    collections: [...grouped]
      .map(([name, g]) => ({ name, ids: [...g.candidates].filter((key) => !g.shared.has(key)) }))
      .filter((g) => g.ids.length),
    hashes: [...hashes].filter((h) => !retainedHashes.has(h)),
    keys: [...keys].filter((k) => !retainedKeys.has(k))
  }
}

export function deleteDocumentRecords(
  db: DatabaseSync,
  plan: ReturnType<typeof planDocumentPurge>
) {
  const { project, id } = plan
  for (const gen of plan.generations)
    db.prepare('UPDATE index_generations SET manifest=?,chunks=? WHERE id=?').run(
      JSON.stringify(gen.manifest.filter((d: any) => d.id !== id)),
      JSON.stringify(gen.chunks.filter((c: any) => c.docId !== id)),
      gen.id
    )
  for (const turn of plan.turns) db.prepare('DELETE FROM chat_turns WHERE id=?').run(turn)
  for (const key of plan.keys)
    db.prepare('DELETE FROM v4_postings WHERE project=? AND chunk=?').run(project, key)
  for (const hash of plan.hashes) db.prepare('DELETE FROM v4_vectors WHERE input_hash=?').run(hash)
  db.prepare(
    'DELETE FROM revision_sources WHERE revision_id IN (SELECT id FROM document_revisions WHERE project_id=? AND doc_id=?)'
  ).run(project, id)
  for (const table of ['analysis_pages', 'processing_reviews'])
    db.prepare(
      `DELETE FROM ${table} WHERE job_id IN (SELECT id FROM processing_jobs WHERE project_id=? AND doc_id=?)`
    ).run(project, id)
  db.prepare('DELETE FROM processing_jobs WHERE project_id=? AND doc_id=?').run(project, id)
  db.prepare('DELETE FROM legacy_imports WHERE project_id=? AND doc_id=?').run(project, id)
  for (const task of plan.tasks) db.prepare('DELETE FROM v4_tasks WHERE id=?').run(task.id)
  db.prepare('DELETE FROM v5_uploads WHERE project=? AND doc_id=?').run(project, id)
  db.prepare('DELETE FROM document_revisions WHERE project_id=? AND doc_id=?').run(project, id)
  db.prepare('DELETE FROM documents WHERE project_id=? AND id=?').run(project, id)
  for (const file of plan.fileIds) db.prepare('DELETE FROM source_files WHERE id=?').run(file)
  for (const batch of db
    .prepare('SELECT id,documents FROM v4_clear WHERE project=?')
    .all(project) as any[])
    db.prepare('UPDATE v4_clear SET documents=? WHERE id=?').run(
      JSON.stringify(JSON.parse(batch.documents).filter((d: any) => d.id !== id)),
      batch.id
    )
  db.prepare('UPDATE v4_projects SET version=? WHERE id=?').run(randomUUID(), project)
}
