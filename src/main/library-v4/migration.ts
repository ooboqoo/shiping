import { existsSync, readFileSync } from 'node:fs'
import { Library } from '../library/repository'
import { Catalog } from './catalog'
import { canonicalMarkdown, reportMarkdown, MARKDOWN_VERSION, digest } from './markdown'
import { IndexEngine } from './indexing'
import * as runtime from './runtime'
/** Candidate only. Caller owns stopped-writer verification and activation. */
export async function prepareV4(
  source: string,
  target: string,
  io = runtime,
  progress?: (message: string) => void
) {
  if (!existsSync(source) || existsSync(target)) throw Error('迁移源不存在或候选目标已存在')
  const original = new Library(source)
  try {
    await original.backup(target)
  } finally {
    original.close()
  }
  const catalog = new Catalog(target),
    engine = new IndexEngine(catalog, io),
    rows: any[] = []
  let active = 0,
    trash = 0,
    missingOriginals = 0
  try {
    for (const project of catalog.projects()) {
      const id = String(project.id)
      catalog.projectInfo(id)
      for (const doc of [...catalog.list(id), ...catalog.list(id, true)]) {
        const before = doc.version
        let text = canonicalMarkdown(doc.text),
          processingTask: string | undefined
        if (doc.processingJob) {
          const job = catalog.job(id, String(doc.processingJob))
          if (job.result?.cleaned === doc.text) {
            const report = reportMarkdown(job.result, job.info.ext || 'txt'),
              task = catalog.enqueue(id, 'migration', {
                docId: doc.id,
                ext: job.info.ext,
                sourceName: job.info.sourceName
              })
            const owner = 'migration-' + task.id
            catalog.claim(task.id, owner)
            catalog.finish(task.id, owner, 'done', report)
            text = report.cleaned
            processingTask = task.id
          }
        }
        const updated = catalog.update(id, doc.id, doc.version, {
          text,
          formatVersion: MARKDOWN_VERSION,
          ...(processingTask ? { processingTask } : {}),
          chars: text.length,
          tokens: Math.ceil(text.length * 0.8)
        })
        if (doc.sourceFileId) catalog.linkSource(updated.revisionId, String(doc.sourceFileId))
        if (doc.deletedAt) trash++
        else active++
        if (doc.sourcePath && !existsSync(doc.sourcePath)) missingOriginals++
        rows.push({
          project: id,
          id: doc.id,
          originalHash: digest(doc.text),
          markdownHash: digest(text),
          modes: doc.modes,
          deletedAt: doc.deletedAt || null
        })
        // Carry unfinished legacy work into the new task log; don't silently approve its result.
        const pending = catalog
          .jobs(id)
          .find(
            (j) =>
              j.docId === doc.id &&
              j.info.expectedVersion === before &&
              !['applied', 'cancelled'].includes(j.status)
          )
        if (pending && (!processingTask || pending.id !== doc.processingJob)) {
          const path = pending.info.inputPath || doc.sourcePath,
            bytes = path && existsSync(path) ? readFileSync(path) : undefined,
            task = catalog.enqueue(id, 'ingest', {
              docId: doc.id,
              expectedVersion: updated.version,
              sourceName: pending.info.sourceName || doc.source,
              sourcePath: path,
              sourceHash: pending.info.sourceHash,
              bytesHash: bytes ? digest(bytes.toString('base64')) : undefined,
              sourceFileId: pending.info.sourceFileId,
              ext: pending.info.ext,
              ruleVersion: MARKDOWN_VERSION,
              desiredModes: pending.info.desiredModes
            })
          const owner = 'migration-' + task.id
          catalog.claim(task.id, owner)
          catalog.finish(
            task.id,
            owner,
            pending.result ? 'needs_attention' : 'failed',
            pending.result ? reportMarkdown(pending.result, pending.info.ext) : undefined,
            Date.now(),
            '旧版未完成任务保留，请检查或重试'
          )
        }
      }
      progress?.('建立候选索引：' + project.name)
      await engine.build(id, 'full')
      progress?.('候选索引完成：' + project.name)
    }
    for (const row of rows) {
      const doc = catalog.get(row.project, row.id)
      if (
        digest(doc.text) !== row.markdownHash ||
        JSON.stringify(doc.modes) !== JSON.stringify(row.modes) ||
        (doc.deletedAt || null) !== row.deletedAt
      )
        throw Error('迁移核对失败')
    }
    const integrity = catalog.integrity()
    if (integrity.some((r: any) => r.integrity_check !== 'ok')) throw Error('SQLite完整性核对失败')
    return {
      schema: 5,
      documents: rows.length,
      active,
      trash,
      missingOriginals,
      projects: catalog.projects().length,
      integrity,
      rows
    }
  } finally {
    catalog.close()
  }
}
