import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { Library } from '../library/repository'
export async function submitDocument(
  library: Library,
  root: string,
  project: string,
  file: { name: string; data: Buffer },
  docId?: string
) {
  const ext = extname(file.name).slice(1).toLowerCase()
  if (
    basename(file.name) !== file.name ||
    ![
      'pdf',
      'png',
      'jpg',
      'jpeg',
      'webp',
      'xlsx',
      'pptx',
      'docx',
      'md',
      'markdown',
      'txt'
    ].includes(ext) ||
    file.data.length > 30 * 1024 * 1024 ||
    !file.data.length
  )
    throw Error('文件格式、名称或大小无效')
  const hash = createHash('sha256').update(file.data).digest('hex'),
    dir = join(root, 'originals')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const inputPath = join(dir, hash + '.' + ext)
  try {
    await writeFile(inputPath, file.data, { flag: 'wx', mode: 0o600 })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    const saved = await readFile(inputPath)
    if (createHash('sha256').update(saved).digest('hex') !== hash) throw Error('原件校验失败')
  }
  if (!docId) {
    const existing = library.list(project).find((d) => d.sourceHash === hash)
    if (existing) {
      const cached = library
        .jobs(project)
        .find((j) => j.docId === existing.id && j.info.sourceHash === hash)
      if (cached) return cached
      docId = existing.id
    }
  }
  let doc = docId
    ? library.get(project, docId)
    : library.create(project, {
        name: basename(file.name, extname(file.name)).slice(0, 80) || '待处理资料',
        text: '资料正在本地解析，尚未复核。',
        modes: [],
        tags: [],
        pending: true,
        sourceHash: hash,
        source: file.name,
        sourcePath: inputPath,
        chars: 0,
        tokens: 0
      })
  if (doc.deletedAt) throw Error('不能处理回收站资料')
  const sourceFileId = library.registerSource(project, hash, file.name, inputPath, file.data.length)
  const info = {
    sourceFileId,
    sourceName: file.name,
    sourceHash: hash,
    inputPath,
    ext,
    expectedVersion: doc.version,
    ruleVersion: 'conservative-v1',
    ...(doc.pending ? { desiredModes: ['screenshot', 'conversation'] } : {})
  }
  const cached = library
    .jobs(project)
    .find(
      (j) =>
        j.docId === doc.id &&
        j.info.sourceHash === hash &&
        j.info.expectedVersion === doc.version &&
        ['queued', 'scheduled', 'running', 'review', 'ready', 'applied'].includes(j.status)
    )
  return cached || library.createJob(project, doc.id, info)
}
