import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync } from 'node:fs'
import { join, basename } from 'node:path'
import { Catalog } from './catalog'
import { canonicalMarkdown } from './markdown'
/** Idempotent bootstrap; a marker with a missing database is always an error. */
export async function initializeLibrary(root: string, legacyDocuments?: string) {
  const dir = join(root, 'data', 'library'),
    marker = join(dir, 'v4-active.json'),
    database = join(dir, 'shiping.sqlite')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (existsSync(marker)) {
    if (JSON.parse(readFileSync(marker, 'utf8')).version !== 1 || !existsSync(database))
      throw Error('资料库配置或数据库缺失，请恢复备份')
    return
  }
  const legacyMarker = join(dir, 'active.json')
  if (existsSync(legacyMarker)) {
    const legacy = JSON.parse(readFileSync(legacyMarker, 'utf8'))
    if (legacy.version !== 1 || legacy.database !== 'shiping.sqlite' || !existsSync(database))
      throw Error('旧资料数据库缺失或配置无效，请恢复备份')
  }
  const catalog = new Catalog(database)
  try {
    if (!catalog.projects().some((p) => p.id === 'shiping'))
      catalog.project('shiping', '我的资料库')
    if (legacyDocuments && existsSync(join(legacyDocuments, 'index.json'))) {
      const docs = JSON.parse(readFileSync(join(legacyDocuments, 'index.json'), 'utf8'))
      if (!Array.isArray(docs)) throw Error('旧资料索引格式无效，请恢复备份')
      catalog.atomic(() => {
        for (const doc of docs) {
          const file = doc.storageFile || `${doc.id}.txt`
          if (typeof file !== 'string' || basename(file) !== file || !file.endsWith('.txt'))
            throw Error('旧资料路径无效')
          const source = join(legacyDocuments, file)
          if (
            !existsSync(source) ||
            !lstatSync(source).isFile() ||
            lstatSync(source).isSymbolicLink()
          )
            throw Error('旧资料正文缺失或路径无效')
          if (
            !catalog.list('shiping', true).some((d) => d.id === doc.id) &&
            !catalog.list('shiping').some((d) => d.id === doc.id)
          ) {
            catalog.create('shiping', {
              ...doc,
              text: canonicalMarkdown(readFileSync(source, 'utf8')),
              formatVersion: 'markdown-v1'
            })
          }
        }
      })
    }
    for (const project of catalog.projects()) {
      if (catalog.list(String(project.id)).length && !catalog.generation(String(project.id)))
        catalog.enqueue(String(project.id), 'index', { kind: 'incremental' })
    }
    writeFileSync(marker + '.tmp', JSON.stringify({ version: 1, storage: 'sqlite-vectors' }), {
      mode: 0o600
    })
    renameSync(marker + '.tmp', marker)
  } finally {
    catalog.close()
  }
}
