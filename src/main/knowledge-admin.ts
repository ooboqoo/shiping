import { KNOWLEDGE_EXTENSIONS } from '../shared/knowledge'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { KnowledgeDoc, KnowledgePatch } from '../shared/knowledge'
import { extractBufferText, normalizeText } from './knowledge-parse'
import { chunkDocument } from './rag/chunks'
interface Access {
  load(): KnowledgeDoc[]
  texts: Map<string, string>
  storeDir(): string
  mutate<T>(task: () => Promise<T>): Promise<T>
  addDoc(
    name: string,
    text: string,
    source?: { name: string; path: string },
    deferIndex?: boolean
  ): Promise<KnowledgeDoc>
  updateDoc(id: string, patch: KnowledgePatch, deferIndex?: boolean): Promise<KnowledgeDoc | null>
  saveIndex(): Promise<void>
}
class AdminError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}
export function knowledgeVersion(doc: KnowledgeDoc, text: string): string {
  const metadata = { ...doc }
  delete metadata.version
  return createHash('sha256')
    .update(JSON.stringify(metadata) + '\0' + text)
    .digest('hex')
}
export function checkKnowledgeVersion(doc: KnowledgeDoc, text: string, expected: unknown): void {
  if (typeof expected !== 'string' || expected !== knowledgeVersion(doc, text))
    throw new AdminError(409, '资料已在其他位置修改，请刷新后再编辑')
}
const MAX_FILE = 30 * 1024 * 1024,
  MAX_BODY = 45 * 1024 * 1024
function objectValue(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new AdminError(400, '请求参数无效')
  return raw as Record<string, unknown>
}
function input(raw: unknown) {
  const value = objectValue(raw)
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.trim().length > 80
  )
    throw new AdminError(400, '请填写1至80字符的名称')
  if (typeof value.text !== 'string') throw new AdminError(400, '正文必须是文本')
  const text = normalizeText(value.text)
  if (!text || text.length > 2_000_000) throw new AdminError(400, '正文不能为空，且最多200万字符')
  const modes = value.modes ?? ['screenshot', 'conversation'],
    tags = value.tags ?? []
  if (!Array.isArray(modes) || modes.some((m) => !['screenshot', 'conversation'].includes(m)))
    throw new AdminError(400, '无效的使用模式')
  if (
    !Array.isArray(tags) ||
    tags.length > 10 ||
    tags.some((t) => typeof t !== 'string' || !t.trim() || t.length > 30)
  )
    throw new AdminError(400, '标签格式错误')
  return {
    name: value.name.trim(),
    text,
    modes: [...new Set(modes)] as KnowledgeDoc['modes'],
    tags: [...new Set(tags)] as string[]
  }
}
function upload(raw: unknown) {
  const value = objectValue(raw)
  if (
    !value ||
    typeof value.name !== 'string' ||
    value.name !== basename(value.name) ||
    /[\\/]/.test(value.name) ||
    [...value.name].some((c) => c.charCodeAt(0) < 32) ||
    value.name.length > 180 ||
    !KNOWLEDGE_EXTENSIONS.includes(extname(value.name).slice(1).toLowerCase())
  )
    throw new AdminError(400, '无效的文件名或不支持的资料格式')
  if (
    typeof value.base64 !== 'string' ||
    value.base64.length > Math.ceil(MAX_FILE / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)
  )
    throw new AdminError(400, '文件内容无效或超过30MB')
  const data = Buffer.from(value.base64, 'base64')
  if (!data.length || data.length > MAX_FILE)
    throw new AdminError(400, '文件不能为空，且不能超过30MB')
  return { name: value.name as string, data }
}
export function createKnowledgeAdmin(a: Access) {
  function find(id: string) {
    const doc = a.load().find((d) => d.id === id)
    if (!doc) throw new AdminError(404, '找不到这份资料')
    return doc
  }
  const version = (doc: KnowledgeDoc) => knowledgeVersion(doc, a.texts.get(doc.id) ?? '')
  function visible(doc: KnowledgeDoc, text = true) {
    const meta = structuredClone(doc)
    delete meta.sourcePath
    delete meta.storageFile
    return {
      ...meta,
      tags: meta.tags ?? [],
      version: version(doc),
      hasOriginal: Boolean(doc.sourcePath),
      ...(text ? { text: a.texts.get(doc.id) ?? '' } : {})
    }
  }
  function checked(id: string, expected: unknown) {
    const doc = find(id)
    checkKnowledgeVersion(doc, a.texts.get(doc.id) ?? '', expected)
    return doc
  }
  async function add(value: ReturnType<typeof input>, original?: ReturnType<typeof upload>) {
    let source: { name: string; path: string } | undefined
    if (original) {
      const dir = join(a.storeDir(), 'originals')
      await mkdir(dir, { recursive: true })
      source = {
        name: original.name,
        path: join(dir, `${randomUUID()}${extname(original.name).toLowerCase()}`)
      }
      await writeFile(source.path, original.data, { mode: 0o600, flag: 'wx' })
    }
    const doc = await a.addDoc(value.name, value.text, source, true)
    doc.modes = value.modes
    doc.tags = value.tags
    return doc
  }
  const admin = {
    async list(options: { trash?: boolean; q?: string } = {}) {
      return a
        .load()
        .filter((d) => Boolean(d.deletedAt) === Boolean(options.trash))
        .filter(
          (d) =>
            !options.q ||
            `${d.name}\n${a.texts.get(d.id)}\n${d.tags?.join(' ')}`
              .toLowerCase()
              .includes(options.q.toLowerCase())
        )
        .map((d) => visible(d, false))
    },
    async get(id: string) {
      return visible(find(id))
    },
    async create(value: unknown) {
      const valid = input(value)
      return a.mutate(async () => {
        const doc = await add(valid)
        await a.saveIndex()
        return visible(doc)
      })
    },
    async update(id: string, raw: unknown) {
      const patch = objectValue(raw)
      return a.mutate(async () => {
        const doc = checked(id, patch?.version)
        if (doc.deletedAt) throw new AdminError(409, '请先恢复资料')
        const clean = input({
          name: doc.name,
          text: a.texts.get(doc.id),
          modes: doc.modes,
          tags: doc.tags,
          ...patch
        })
        await a.updateDoc(id, clean, true)
        const changed = find(id)
        changed.tags = clean.tags
        await a.saveIndex()
        return visible(changed)
      })
    },
    async trash(id: string, expected: string) {
      return a.mutate(async () => {
        const doc = checked(id, expected)
        doc.deletedAt = Date.now()
        doc.updatedAt = Date.now()
        await a.saveIndex()
        return visible(doc)
      })
    },
    async restore(id: string, expected: string) {
      return a.mutate(async () => {
        const doc = checked(id, expected)
        delete doc.deletedAt
        doc.updatedAt = Date.now()
        await a.saveIndex()
        return visible(doc)
      })
    },
    async importFile(value: unknown) {
      const original = upload(value),
        text = await extractBufferText(original.data, extname(original.name), 2_000_000)
      const valid = input({
        name: basename(original.name, extname(original.name)).slice(0, 80),
        text
      })
      return a.mutate(async () => {
        const doc = await add(valid, original)
        await a.saveIndex()
        return visible(doc)
      })
    },
    async original(id: string) {
      const doc = find(id)
      if (doc.sourcePath) {
        const info = await stat(doc.sourcePath).catch(() => null)
        if (info?.isFile()) {
          if (info.size > MAX_FILE) throw new AdminError(413, '原文件超过30MB')
          return {
            name: doc.source ?? `${doc.name}.txt`,
            base64: (await readFile(doc.sourcePath)).toString('base64')
          }
        }
      }
      return {
        name: `${doc.name}.txt`,
        base64: Buffer.from(a.texts.get(id) ?? '').toString('base64')
      }
    },
    async chunks(id: string, offset = 0, limit = 50) {
      find(id)
      const chunks = chunkDocument(id, a.texts.get(id) ?? '')
      return {
        items: chunks.slice(offset, offset + limit),
        total: chunks.length,
        offset,
        limit,
        preview: true
      }
    },
    async backup() {
      const documents: Record<string, unknown>[] = []
      for (const doc of a.load()) {
        const original = doc.sourcePath ? await admin.original(doc.id) : undefined
        documents.push({ ...visible(doc), ...(original ? { original } : {}) })
      }
      const result = {
        format: 'local-rag-backup',
        version: 1,
        project: { name: 'Shiping资料库' },
        documents
      }
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_BODY)
        throw new AdminError(413, '备份超过45MB，请使用完整备份方式')
      return result
    },
    async importBackup(raw: unknown) {
      const backup = objectValue(raw)
      if (
        backup?.format !== 'local-rag-backup' ||
        backup.version !== 1 ||
        !Array.isArray(backup.documents) ||
        backup.documents.length > 2000
      )
        throw new AdminError(400, '无效的知识库备份')
      const entries = backup.documents.map((raw: unknown) => {
        const d = objectValue(raw)
        return {
          valid: input(d),
          original: d.original ? upload(d.original) : undefined,
          deleted: Boolean(d.deletedAt)
        }
      })
      return a.mutate(async () => {
        for (const entry of entries) {
          const doc = await add(entry.valid, entry.original)
          if (entry.deleted) doc.deletedAt = Date.now()
        }
        await a.saveIndex()
        return { added: entries.length }
      })
    }
  }
  return admin
}
