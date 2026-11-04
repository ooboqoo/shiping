import { decodeBase64Bounded } from '../src/main/library-v4/base64'
import { openActiveLibrary } from '../src/main/library/activation'
import type { Library } from '../src/main/library/repository'
import { mkdir, readFile, writeFile, rename, readdir, lstat, unlink } from 'node:fs/promises'
import { join, basename, extname, dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { normalizeText } from '../src/main/knowledge-parse'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}
export const MAX_FILE = 30 * 1024 * 1024
export const MAX_BODY = 45 * 1024 * 1024
export const MAX_TEXT = 2_000_000
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export function validId(id: unknown): string {
  if (typeof id !== 'string' || !ID.test(id)) throw new ApiError(400, '无效的资料或项目编号')
  return id
}
export function title(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80)
    throw new ApiError(400, '名称需要1至80个字符')
  return value.trim()
}
export function textValue(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError(400, '正文必须是文本')
  const text = normalizeText(value)
  if (!text || text.length > MAX_TEXT) throw new ApiError(400, '正文不能为空，且最多200万字符')
  return text
}
export function fileValue(name: unknown, data: Buffer): string {
  if (
    typeof name !== 'string' ||
    name !== basename(name) ||
    /[\\/\x00-\x1f]/.test(name) ||
    name.length > 180
  )
    throw new ApiError(400, '无效的上传文件名')
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
    ].includes(extname(name).toLowerCase())
  )
    throw new ApiError(400, '支持PDF、DOCX、文本、PNG/JPG/WebP、XLSX和PPTX文件')
  if (!data.length || data.length > MAX_FILE)
    throw new ApiError(400, '文件不能为空，且不能超过30MB')
  return name
}
export function decodeBase64(value: unknown): Buffer {
  try { return decodeBase64Bounded(value,MAX_FILE) }
  catch(e) { throw new ApiError(400,(e as Error).message) }
}
export type Mode = 'screenshot' | 'conversation'
export interface Document {
  id: string
  name: string
  text: string
  version: string
  modes: Mode[]
  tags: string[]
  createdAt: number
  updatedAt: number
  deletedAt?: number
  originalFile?: string
  source?: string
  sourceHash?: string
  sourceFileId?: string
  sourcePath?: string
  originalBytes?: number
}
interface Project {
  id: string
  name: string
  createdAt: number
  documents: Document[]
}
export interface Input {
  name: string
  text: string
  modes?: Mode[]
  tags?: string[]
  original?: { name: string; data: Buffer }
}
function fields(input: Partial<Input>) {
  const result: Partial<Document> = {}
  if (input.name !== undefined) result.name = title(input.name)
  if (input.text !== undefined) result.text = textValue(input.text)
  if (input.modes !== undefined) {
    if (
      !Array.isArray(input.modes) ||
      input.modes.some((m) => !['screenshot', 'conversation'].includes(m))
    )
      throw new ApiError(400, '无效的使用模式')
    result.modes = [...new Set(input.modes)]
  }
  if (input.tags !== undefined) {
    if (
      !Array.isArray(input.tags) ||
      input.tags.length > 10 ||
      input.tags.some((t) => typeof t !== 'string' || !t.trim() || t.length > 30)
    )
      throw new ApiError(400, '最多10个标签，每个不超过30字符')
    result.tags = [...new Set(input.tags.map((t) => t.trim()))]
  }
  return result
}
function publicDoc(doc: Document, includeText = true) {
  const { originalFile: _file, originalBytes: _bytes, sourcePath: _path, ...visible } = doc
  const result: Record<string, unknown> = {
    ...visible,
    chars: doc.text.length,
    hasOriginal: Boolean(doc.originalFile || doc.sourcePath)
  }
  if (!includeText) delete result.text
  return result as unknown as Document & {
    chars: number
    hasOriginal: boolean
  }
}
export async function atomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 })
    await rename(temp, path)
  } finally {
    await unlink(temp).catch(() => {})
  }
}
export class Store {
  private queues = new Map<string, Promise<unknown>>()
  private library: Library | undefined
  constructor(public root: string) {
    this.library = openActiveLibrary(join(root, '..'))
  }
  getLibrary() {
    return this.library
  }
  close() {
    this.library?.close()
  }
  path(id: string) {
    return join(this.root, 'projects', validId(id))
  }
  private async safe(path: string) {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new ApiError(400, '不能访问链接目录或链接文件')
  }
  private async read(id: string): Promise<Project> {
    const dir = this.path(id)
    if (this.library) {
      const project = this.library.projects().find((p: any) => p.id === id) as any
      if (!project) throw new ApiError(404, '找不到这个项目')
      return {
        id,
        name: project.name,
        createdAt: 0,
        documents: [...this.library.list(id), ...this.library.list(id, true)]
      } as Project
    }
    try {
      await this.safe(dir)
      await this.safe(join(dir, 'project.json'))
      const data = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
      if (data.id !== id || !Array.isArray(data.documents)) throw new Error('Invalid store')
      return data
    } catch (e) {
      if (e instanceof ApiError) throw e
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, '找不到这个项目')
      throw new ApiError(500, '项目记录损坏，请从备份恢复，原文件尚未改动')
    }
  }
  private async serial<T>(id: string, task: (p: Project) => Promise<T>) {
    validId(id)
    const job = (this.queues.get(id) ?? Promise.resolve()).then(async () => {
      const p = await this.read(id),
        baseline = p.documents.map((d) => ({ id: d.id, version: d.version })),
        result = await task(p)
      if (this.library) {
        try {
          this.library.replaceProject(
            id,
            p.documents.map((d) => ({ ...d })),
            baseline
          )
        } catch (e) {
          if (String(e).includes('冲突')) throw new ApiError(409, '资料已被修改，请刷新重试')
          throw e
        }
      } else await atomic(join(this.path(id), 'project.json'), p)
      return result
    })
    this.queues.set(
      id,
      job.catch(() => {})
    )
    return job
  }
  async projects() {
    if (this.library)
      return this.library
        .projects()
        .filter((p: any) => ID.test(p.id))
        .map((p: any) => ({
          id: p.id,
          name: p.name,
          kind: 'managed',
          documents: this.library!.list(p.id).length,
          collection: this.collection(p.id)
        }))
    await mkdir(join(this.root, 'projects'), { recursive: true })
    const entries = await readdir(join(this.root, 'projects'), {
      withFileTypes: true
    })
    const result: Record<string, unknown>[] = []
    for (const entry of entries.filter((e) => e.isDirectory() && ID.test(e.name))) {
      const p = await this.read(entry.name)
      result.push({
        id: p.id,
        name: p.name,
        kind: 'managed',
        documents: p.documents.filter((d) => !d.deletedAt).length,
        collection: this.collection(p.id)
      })
    }
    return result
  }
  collection(id: string) {
    return `rag_admin_${validId(id).replaceAll('-', '')}_v2`
  }
  async createProject(name: unknown) {
    const p: Project = {
      id: randomUUID(),
      name: title(name),
      createdAt: Date.now(),
      documents: []
    }
    await mkdir(join(this.path(p.id), 'originals'), { recursive: true })
    if (this.library) this.library.project(p.id, p.name)
    else await atomic(join(this.path(p.id), 'project.json'), p)
    return {
      id: p.id,
      name: p.name,
      kind: 'managed',
      documents: 0,
      collection: this.collection(p.id)
    }
  }
  async list(id: string, options: { trash?: boolean; q?: string; text?: boolean } = {}) {
    return (await this.read(id)).documents
      .filter((d) => Boolean(d.deletedAt) === Boolean(options.trash))
      .filter(
        (d) =>
          !options.q ||
          `${d.name}\n${d.text}\n${d.tags.join(' ')}`
            .toLowerCase()
            .includes(options.q.toLowerCase())
      )
      .map((d) => publicDoc(d, options.text ?? false))
  }
  async get(project: string, id: string) {
    const doc = (await this.read(project)).documents.find((d) => d.id === validId(id))
    if (!doc) throw new ApiError(404, '找不到这份资料')
    return publicDoc(doc)
  }
  private async make(project: string, input: Input): Promise<Document> {
    const clean = fields(input),
      id = randomUUID(),
      now = Date.now()
    if (!clean.name || !clean.text) throw new ApiError(400, '请填写名称和正文')
    const doc: Document = {
      id,
      name: clean.name,
      text: clean.text,
      modes: clean.modes ?? ['screenshot', 'conversation'],
      tags: clean.tags ?? [],
      version: randomUUID(),
      createdAt: now,
      updatedAt: now
    }
    if (input.original) {
      doc.source = fileValue(input.original.name, input.original.data)
      doc.originalFile = `${id}.bin`
      doc.originalBytes = input.original.data.length
      await this.safe(join(this.path(project), 'originals'))
      await writeFile(
        join(this.path(project), 'originals', doc.originalFile),
        input.original.data,
        { flag: 'wx', mode: 0o600 }
      )
    }
    return doc
  }
  async create(project: string, input: Input) {
    return this.serial(project, async (p) => {
      const doc = await this.make(project, input)
      p.documents.push(doc)
      return publicDoc(doc)
    })
  }
  private find(p: Project, id: string, version: unknown) {
    const doc = p.documents.find((d) => d.id === validId(id))
    if (!doc) throw new ApiError(404, '找不到这份资料')
    if (typeof version !== 'string' || version !== doc.version)
      throw new ApiError(409, '资料已在其他位置修改，请刷新后再编辑')
    return doc
  }
  async update(project: string, id: string, patch: Partial<Input> & { version: string }) {
    return this.serial(project, async (p) => {
      const doc = this.find(p, id, patch.version)
      if (doc.deletedAt) throw new ApiError(409, '请先从回收站恢复资料')
      Object.assign(doc, fields(patch), {
        version: randomUUID(),
        updatedAt: Date.now()
      })
      return publicDoc(doc)
    })
  }
  async trash(project: string, id: string, version: unknown) {
    return this.serial(project, async (p) => {
      const doc = this.find(p, id, version)
      doc.deletedAt = Date.now()
      doc.updatedAt = Date.now()
      doc.version = randomUUID()
      return publicDoc(doc)
    })
  }
  async restore(project: string, id: string, version: unknown) {
    return this.serial(project, async (p) => {
      const doc = this.find(p, id, version)
      delete doc.deletedAt
      doc.updatedAt = Date.now()
      doc.version = randomUUID()
      return publicDoc(doc)
    })
  }
  async original(project: string, id: string): Promise<{ name: string; data: Buffer }> {
    const doc = (await this.read(project)).documents.find((d) => d.id === validId(id))
    if (!doc) throw new ApiError(404, '找不到这份资料')
    if (doc.sourcePath) {
      const expected = resolve(this.root, '../library/originals')
      if (dirname(doc.sourcePath) !== expected) throw new ApiError(400, '原件路径无效')
      await this.safe(doc.sourcePath)
      return {
        name: doc.source || `${doc.name}.txt`,
        data: await readFile(doc.sourcePath)
      }
    }
    if (!doc.originalFile) return { name: `${doc.name}.txt`, data: Buffer.from(doc.text) }
    if (!/^[0-9a-f-]+\.bin$/.test(doc.originalFile)) throw new ApiError(400, '源文件记录无效')
    const dir = join(this.path(project), 'originals'),
      file = join(dir, doc.originalFile)
    try {
      await this.safe(dir)
      await this.safe(file)
      return { name: doc.source!, data: await readFile(file) }
    } catch (e) {
      if (e instanceof ApiError) throw e
      throw new ApiError(404, '原文件已丢失，正文仍保留')
    }
  }
  async backup(project: string) {
    const p = await this.read(project),
      documents: Record<string, unknown>[] = []
    for (const doc of p.documents) {
      const original =
        doc.originalFile || doc.sourcePath ? await this.original(project, doc.id) : undefined
      documents.push({
        ...publicDoc(doc),
        ...(original
          ? {
              original: {
                name: original.name,
                base64: original.data.toString('base64')
              }
            }
          : {})
      })
    }
    const backup = {
      format: 'local-rag-backup',
      version: 1,
      project: { name: p.name },
      documents
    }
    if (Buffer.byteLength(JSON.stringify(backup)) > MAX_BODY)
      throw new ApiError(413, '备份超过45MB，请使用停止服务后的完整备份方式')
    return backup
  }
  async importBackup(project: string, backup: any) {
    if (
      backup?.format !== 'local-rag-backup' ||
      backup.version !== 1 ||
      !Array.isArray(backup.documents) ||
      backup.documents.length > 2000
    )
      throw new ApiError(400, '不是有效的知识库备份')
    const inputs = backup.documents.map((d: any) => {
      if (!d || typeof d !== 'object') throw new ApiError(400, '备份资料损坏')
      const clean = fields({
        name: d.name,
        text: d.text,
        tags: d.tags,
        modes: d.modes
      })
      if (!clean.name || !clean.text) throw new ApiError(400, '备份缺少名称或正文')
      const original = d.original
        ? { name: d.original.name, data: decodeBase64(d.original.base64) }
        : undefined
      if (original) fileValue(original.name, original.data)
      return {
        ...clean,
        original,
        deletedAt: d.deletedAt ? Date.now() : undefined
      }
    })
    return this.serial(project, async (p) => {
      for (const input of inputs) {
        const doc = await this.make(project, input as Input)
        if (input.deletedAt) doc.deletedAt = input.deletedAt
        p.documents.push(doc)
      }
      return { added: inputs.length }
    })
  }
}
