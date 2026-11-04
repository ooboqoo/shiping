import {
  readFileSync,
  existsSync,
  readdirSync,
  lstatSync,
  copyFileSync,
  mkdirSync,
  chmodSync,
  writeFileSync
} from 'node:fs'
import { join, basename, dirname, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { Library, type Material } from './repository'
const digest = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
/** Builds only a candidate database. Never changes legacy data or activation pointers. */
export function migrateLegacy(root: string, target: string) {
  if (existsSync(target)) throw Error('候选库已存在，请使用新路径或单独核验，禁止覆盖')
  const snapshots = new Map<string, string>(),
    records: { project: string; name: string; doc: Material }[] = []
  const read = (file: string) => {
    if (lstatSync(file).isSymbolicLink()) throw Error('迁移源不能为符号链接')
    const b = readFileSync(file)
    snapshots.set(file, digest(b))
    return b.toString('utf8')
  }
  const desktop = join(root, 'data/shiping-trial/knowledge'),
    index = join(desktop, 'index.json')
  if (existsSync(index))
    for (const doc of JSON.parse(read(index))) {
      const file = doc.storageFile || `${doc.id}.txt`
      if (basename(file) !== file || !file.endsWith('.txt')) throw Error('资料正文路径无效')
      const text = read(join(desktop, file))
      records.push({
        project: 'shiping',
        name: 'Shiping资料库',
        doc: { ...doc, text, tags: doc.tags ?? [] }
      })
    }
  const projects = join(root, 'data/admin/projects')
  const projectNames = new Map<string, string>()
  if (existsSync(projects))
    for (const entry of readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = join(projects, entry.name, 'project.json')
      if (!existsSync(file)) continue
      const p = JSON.parse(read(file))
      if (p.id !== entry.name || !Array.isArray(p.documents)) throw Error('项目元数据无效')
      projectNames.set(p.id, p.name)
      for (const doc of p.documents) records.push({ project: p.id, name: p.name, doc })
    }
  const db = new Library(target)
  try {
    db.project('shiping', 'Shiping资料库')
    for (const [id, name] of projectNames) db.project(id, name)
    let originalsRetained = 0,
      originalsMissing = 0
    let active = 0,
      trash = 0,
      chars = 0
    for (const record of records) {
      db.project(record.project, record.name)
      const material = { ...record.doc }
      const original =
        record.project === 'shiping'
          ? material.sourcePath
          : material.originalFile &&
              basename(String(material.originalFile)) === material.originalFile
            ? join(
                root,
                'data/admin/projects',
                record.project,
                'originals',
                String(material.originalFile)
              )
            : undefined
      if (original) {
        if (
          typeof original === 'string' &&
          existsSync(original) &&
          lstatSync(original).isFile() &&
          !lstatSync(original).isSymbolicLink() &&
          lstatSync(original).size <= 30 * 1024 * 1024
        ) {
          const bytes = readFileSync(original),
            hash = digest(bytes),
            extension = extname(String(material.source || original)).toLowerCase()
          if (
            ![
              '.pdf',
              '.docx',
              '.md',
              '.markdown',
              '.txt',
              '.png',
              '.jpg',
              '.jpeg',
              '.webp',
              '.xlsx',
              '.pptx'
            ].includes(extension)
          )
            throw Error('原件记录格式无效')
          const dir = join(dirname(target), 'originals')
          mkdirSync(dir, { recursive: true, mode: 0o700 })
          const saved = join(dir, hash + extension)
          if (!existsSync(saved)) writeFileSync(saved, bytes, { flag: 'wx', mode: 0o600 })
          if (digest(readFileSync(saved)) !== hash) throw Error('原件快照校验失败')
          snapshots.set(original, hash)
          material.sourcePath = saved
          material.sourceHash = hash
          material.sourceFileId = db.registerSource(
            record.project,
            hash,
            String(material.source || basename(original)),
            saved,
            bytes.length
          )
          originalsRetained++
        } else {
          material.originalMissing = true
          originalsMissing++
        }
      }
      db.importLegacy(record.project, material)
      if (material.sourceFileId)
        db.linkSource(
          db.get(record.project, material.id!).revisionId,
          String(material.sourceFileId)
        )
      const actual = db.get(record.project, record.doc.id!)
      if (actual.textHash !== digest(record.doc.text)) throw Error('迁移正文校验失败')
      if (actual.deletedAt) trash++
      else active++
      chars += actual.text.length
    }
    for (const [file, hash] of snapshots)
      if (digest(readFileSync(file)) !== hash)
        throw Error('迁移期间源数据变化，候选库未启用，请重新创建候选')
    const report = {
      schema: 4,
      originalsRetained,
      originalsMissing,
      candidateOnly: true,
      activated: false,
      projects: db.projects().length,
      documents: records.length,
      active,
      trash,
      chars,
      sourceFiles: snapshots.size,
      integrity: db.integrity(),
      createdAt: new Date().toISOString()
    }
    writeFileSync(target + '.report.json', JSON.stringify(report, null, 2), { mode: 0o600 })
    return report
  } finally {
    db.close()
  }
}
export function snapshotLegacy(root: string, destination: string) {
  if (existsSync(destination)) throw Error('备份目标已存在')
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  const manifest: { path: string; hash: string; bytes: number }[] = []
  const scopes = ['data/shiping-trial/knowledge', 'data/admin/projects']
  const inventory = () => {
    const files: string[] = []
    const walk = (relative: string) => {
      const source = join(root, relative)
      const info = lstatSync(source)
      if (info.isSymbolicLink()) throw Error('备份源包含符号链接')
      if (info.isDirectory())
        for (const name of readdirSync(source).sort()) walk(join(relative, name))
      else if (info.isFile()) files.push(relative)
      else throw Error('备份源包含非常规文件')
    }
    for (const scope of scopes) if (existsSync(join(root, scope))) walk(scope)
    return files.sort()
  }
  const files = inventory()
  for (const relative of files) {
    const source = join(root, relative),
      before = readFileSync(source),
      target = join(destination, relative)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    copyFileSync(source, target)
    chmodSync(target, 0o600)
    if (digest(before) !== digest(readFileSync(target))) throw Error('备份期间数据变化，请重试')
    manifest.push({ path: relative, hash: digest(before), bytes: before.length })
  }
  if (JSON.stringify(files) !== JSON.stringify(inventory()))
    throw Error('备份期间目录发生变化，请重试')
  for (const entry of manifest)
    if (
      !existsSync(join(root, entry.path)) ||
      digest(readFileSync(join(root, entry.path))) !== entry.hash
    )
      throw Error('备份期间数据变化，请重试')
  const savedIndex = join(destination, 'data/shiping-trial/knowledge/index.json')
  if (existsSync(savedIndex))
    for (const doc of JSON.parse(readFileSync(savedIndex, 'utf8'))) {
      const file = doc.storageFile || doc.id + '.txt'
      if (basename(file) !== file || !existsSync(join(dirname(savedIndex), file)))
        throw Error('备份正文引用缺失或无效')
    }
  writeFileSync(
    join(destination, 'manifest.json'),
    JSON.stringify(
      { version: 1, scope: 'legacy materials and originals; Chroma not included', files: manifest },
      null,
      2
    ),
    { mode: 0o600 }
  )
  return { files: manifest.length, bytes: manifest.reduce((n, f) => n + f.bytes, 0) }
}
