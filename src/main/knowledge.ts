import { selectedLibrary, selectLibrary } from './library-v4/selection'
import { formatKnowledgePrompt } from '../shared/knowledge-context'
import { desktopLibrary } from './library-v4/desktop-runtime'
import { readFile } from 'node:fs/promises'
import { submitDocument } from './document-processing/submit'
import { openActiveLibrary } from './library/activation'
import { revisionOf } from './rag/chunks'
import type { RagDocument } from '../shared/rag'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { rename, unlink, writeFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { randomUUID } from 'crypto'
import { createKnowledgeAdmin, knowledgeVersion, checkKnowledgeVersion } from './knowledge-admin'
import { extractFileText, normalizeText } from './knowledge-parse'
import type { AppMode } from '../shared/api-profile'
import {
  estimateTokens,
  KNOWLEDGE_EXTENSIONS,
  type KnowledgeDoc,
  type KnowledgeImportResult,
  type KnowledgePatch
} from '../shared/knowledge'

/**
 * 资料库: reference material (resume, prepared Q&A, notes) put in front of a
 * mode's system prompt. It lives on disk under userData, not in the renderer's
 * persisted settings: a few documents would outgrow localStorage, and settings
 * are synced to main as a whole on every change. `index.json` holds the list,
 * `<id>.txt` each text; both are kept in memory once read, since every request
 * builds its prompt from them.
 */

const MAX_NAME_LENGTH = 80

let docs: KnowledgeDoc[] | null = null
const texts = new Map<string, string>()

function storeDir(): string {
  return join(app.getPath('userData'), 'knowledge')
}

const remoteLibrary = desktopLibrary
const library = remoteLibrary ? undefined : openActiveLibrary(join(app.getPath('userData'), '..'))
export function getRemoteLibrary() {
  return remoteLibrary
}
let mutating = false
let baseline: { id: string; version: string }[] = []
const indexPath = () => join(storeDir(), 'index.json')
const textPath = (id: string, file?: string) => {
  if (file && (basename(file) !== file || !file.endsWith('.txt'))) throw new Error('无效资料文件名')
  return join(storeDir(), file || `${id}.txt`)
}

/** The list and every text, read from disk on first use */
function load(): KnowledgeDoc[] {
  if (remoteLibrary) throw Error('资料已由统一后台管理，禁止本地回退写入')
  if (library) {
    if (mutating && docs) return docs
    const rows = [...library.list('shiping'), ...library.list('shiping', true)]
    baseline = rows.map((r) => ({ id: r.id, version: r.version }))
    texts.clear()
    docs = rows.map((row) => {
      const { text, textHash, revisionId, version, ...meta } = row
      void textHash
      void revisionId
      void version
      texts.set(row.id, text)
      return meta as KnowledgeDoc
    })
    return docs
  }
  if (docs) return docs
  docs = []
  try {
    if (existsSync(indexPath())) {
      const saved = JSON.parse(readFileSync(indexPath(), 'utf-8')) as KnowledgeDoc[]
      for (const doc of saved) {
        // A text lost outside the app takes its entry with it
        if (!existsSync(textPath(doc.id, doc.storageFile))) continue
        texts.set(doc.id, readFileSync(textPath(doc.id, doc.storageFile), 'utf-8'))
        docs.push(doc)
      }
    }
  } catch (error) {
    console.error('Failed to load knowledge base:', error)
  }
  return docs
}

/** Writes run one after another, so a slow one never lands after a newer one */
let writing: Promise<void> = Promise.resolve()

function persist(task: () => Promise<void>): Promise<void> {
  const current = writing.then(task)
  writing = current.catch(() => {})
  return current
}

/** Write through a temporary file, so a crash never leaves half a file behind */
async function writeAtomic(path: string, content: string) {
  const temp = `${path}.tmp`
  await writeFile(temp, content, 'utf-8')
  await rename(temp, path)
}

function saveIndex(): Promise<void> {
  if (library) {
    const rows = (docs ?? []).map((d) => ({ ...d, text: texts.get(d.id) ?? '' }))
    library.replaceProject('shiping', rows, baseline)
    baseline = [...library.list('shiping'), ...library.list('shiping', true)].map((d) => ({
      id: d.id,
      version: d.version
    }))
    return Promise.resolve()
  }
  const snapshot = JSON.stringify(load(), null, 2)
  return persist(async () => {
    mkdirSync(storeDir(), { recursive: true })
    await writeAtomic(indexPath(), snapshot)
  })
}

async function saveText(id: string, text: string): Promise<string> {
  if (library) return `${id}-sqlite.txt`
  const file = `${id}-${randomUUID()}.txt`
  await persist(async () => {
    mkdirSync(storeDir(), { recursive: true })
    await writeAtomic(textPath(id, file), text)
  })
  return file
}

function tidyName(name: string, fallback: string): string {
  return name.trim().slice(0, MAX_NAME_LENGTH) || fallback
}

function measure(text: string): Pick<KnowledgeDoc, 'chars' | 'tokens'> {
  return { chars: text.length, tokens: estimateTokens(text) }
}

async function addDoc(
  name: string,
  text: string,
  source?: { name: string; path: string },
  deferIndex = false
): Promise<KnowledgeDoc> {
  const doc: KnowledgeDoc = {
    id: randomUUID(),
    name: tidyName(name, `资料${load().length + 1}`),
    ...(source ? { source: source.name, sourcePath: source.path } : {}),
    ...measure(text),
    // Most material (a resume, prepared answers) helps in both modes
    modes: ['screenshot', 'conversation'],
    updatedAt: Date.now()
  }
  texts.set(doc.id, text)
  load().push(doc)
  notifyKnowledge()
  doc.storageFile = await saveText(doc.id, text)
  if (!deferIndex) await saveIndex()
  return doc
}

async function importFiles(paths: string[]): Promise<KnowledgeImportResult> {
  if (remoteLibrary) {
    const result: KnowledgeImportResult = { added: [], failed: [] }
    for (const file of paths) {
      try {
        const submission = randomUUID()
        const job = await remoteLibrary.upload(file, submission, () => {})
        result.added.push(await remoteLibrary.call('get', [selectedLibrary(), job.docId]))
      } catch (e) {
        result.failed.push({ name: basename(file), error: String((e as Error).message || e) })
      }
    }
    notifyKnowledge()
    return result
  }

  const result: KnowledgeImportResult = { added: [], failed: [] }
  for (const path of paths) {
    const fileName = basename(path)
    try {
      if (library) {
        const data = await readFile(path)
        const job = await submitDocument(
          library,
          join(app.getPath('userData'), '../library'),
          selectedLibrary(),
          { name: fileName, data }
        )
        load()
        result.added.push(desktopDoc(job.docId))
        notifyKnowledge()
        continue
      }
      const text = await extractFileText(path)
      const name = basename(fileName, extname(fileName))
      const added = await mutate(() => addDoc(name, text, { name: fileName, path }))
      result.added.push(desktopDoc(added.id))
    } catch (error) {
      result.failed.push({
        name: fileName,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return result
}

async function updateDoc(
  id: string,
  patch: KnowledgePatch,
  deferIndex = false
): Promise<KnowledgeDoc | null> {
  const doc = load().find((d) => d.id === id)
  if (!doc) return null
  if (patch.name !== undefined) doc.name = tidyName(patch.name, doc.name)
  if (patch.modes) doc.modes = patch.modes.filter((m) => m === 'screenshot' || m === 'conversation')
  if (patch.text !== undefined) {
    const text = normalizeText(patch.text)
    texts.set(id, text)
    Object.assign(doc, measure(text))
    doc.storageFile = await saveText(id, text)
  }
  notifyKnowledge()
  doc.updatedAt = Date.now()
  if (!deferIndex) await saveIndex()
  return { ...doc }
}

/** Read the file it came from again; keeps its name and modes */
async function reimportDoc(
  id: string,
  expected: string | undefined
): Promise<{ doc?: KnowledgeDoc; error?: string }> {
  if (remoteLibrary) {
    try {
      return await remoteLibrary.call('reparse', [selectedLibrary(), id, expected, true])
    } catch (e) {
      return { error: String((e as Error).message || e) }
    }
  }
  const doc = load().find((d) => d.id === id)
  if (!doc?.sourcePath) return { error: '这份资料不是从文件导入的' }
  try {
    if (library) {
      checkKnowledgeVersion(doc, texts.get(id) ?? '', expected)
      const data = await readFile(doc.sourcePath)
      const current = load().find((d) => d.id === id)
      if (!current) throw Error('资料已移除，请刷新')
      checkKnowledgeVersion(current, texts.get(id) ?? '', expected)
      await submitDocument(
        library,
        join(app.getPath('userData'), '../library'),
        selectedLibrary(),
        { name: basename(doc.sourcePath), data },
        id
      )
      notifyKnowledge()
      return { doc: desktopDoc(id) }
    }
    const text = await extractFileText(doc.sourcePath)
    await mutate(async () => {
      const current = load().find((d) => d.id === id)
      if (!current) throw new Error('资料已移除，请刷新')
      checkKnowledgeVersion(current, texts.get(id) ?? '', expected)
      await updateDoc(id, { text })
    })
    return { doc: desktopDoc(id) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function desktopDoc(id: string): KnowledgeDoc {
  const doc = load().find((d) => d.id === id)
  if (!doc) throw new Error('资料已移除，请刷新')
  return { ...doc, version: knowledgeVersion(doc, texts.get(id) ?? '') }
}

/**
 * The material a mode uses, as the opening of its system prompt. It goes before
 * the scene's prompt: a prefix that stays the same across requests (and across
 * scene switches) is what platforms cache, and the scene's format rules then
 * sit closer to the question.
 */
export function getKnowledgePrompt(mode: AppMode): string {
  const used = load().filter(
    (doc) => !doc.deletedAt && doc.modes.includes(mode) && texts.get(doc.id)
  )
  return formatKnowledgePrompt(
    used.map((doc) => ({ name: doc.name, text: texts.get(doc.id) || '' }))
  )
}

ipcMain.handle('knowledge:list', () =>
  remoteLibrary
    ? remoteLibrary.call('list', [selectedLibrary()])
    : load()
        .filter((doc) => !doc.deletedAt)
        .map((doc) => desktopDoc(doc.id))
)
ipcMain.handle('knowledge:get-document', async (_event, id: string) => {
  if (remoteLibrary) {
    const doc = await remoteLibrary.call('get', [selectedLibrary(), id])
    return { doc, text: doc.text }
  }
  const doc = desktopDoc(id)
  if (doc.deletedAt) throw new Error('资料已移入回收站，请刷新')
  return { doc, text: texts.get(id) ?? '' }
})

ipcMain.handle('knowledge:get-text', async (_event, id: string) => {
  if (remoteLibrary) return (await remoteLibrary.call('get', [selectedLibrary(), id])).text
  load()
  return texts.get(id) ?? ''
})

ipcMain.handle('knowledge:pick-files', async () => {
  const result = await dialog.showOpenDialog({
    title: '导入资料',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '文档、图片、Excel、PPT（本地OCR）', extensions: KNOWLEDGE_EXTENSIONS }]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return importFiles(result.filePaths)
})

ipcMain.handle('knowledge:import-files', (_event, paths: string[]) => importFiles(paths))

ipcMain.handle('knowledge:create', async (_event, name: string, text: string) => {
  if (remoteLibrary) {
    const doc = await remoteLibrary.call('create', [selectedLibrary(), { name, text }])
    notifyKnowledge()
    return doc
  }
  const doc = await mutate(() => addDoc(name, normalizeText(text)))
  return desktopDoc(doc.id)
})

ipcMain.handle('knowledge:update', async (_event, id: string, patch: KnowledgePatch) => {
  await knowledgeAdmin.update(id, patch)
  if (remoteLibrary) {
    notifyKnowledge()
    return remoteLibrary.call('get', [selectedLibrary(), id])
  }
  return desktopDoc(id)
})

ipcMain.handle('knowledge:reimport', (_event, id: string, version: string | undefined) =>
  reimportDoc(id, version)
)

ipcMain.handle('knowledge:remove', async (_event, id: string, version: string) => {
  await knowledgeAdmin.trash(id, version)
  if (remoteLibrary) notifyKnowledge()
})

const knowledgeListeners: (() => void)[] = []
export function onKnowledgeChanged(fn: () => void): void {
  knowledgeListeners.push(fn)
}
function notifyKnowledge(): void {
  for (const fn of knowledgeListeners) fn()
  if (global.mainWindow && !global.mainWindow.isDestroyed())
    global.mainWindow.webContents.send('knowledge:changed')
}
export function getRagDocuments(): RagDocument[] {
  return load()
    .filter((d) => !d.deletedAt)
    .map((d) => ({
      id: d.id,
      name: d.name,
      text: texts.get(d.id) ?? '',
      modes: [...d.modes],
      revision: revisionOf(texts.get(d.id) ?? '')
    }))
}

let mutations: Promise<unknown> = Promise.resolve()
function mutate<T>(task: () => Promise<T>): Promise<T> {
  const current = mutations.then(async () => {
    const before = structuredClone(load()),
      oldTexts = new Map(texts)
    mutating = true
    try {
      const value = await task()
      notifyKnowledge()
      for (const previous of library ? [] : before) {
        const current = load().find((d) => d.id === previous.id)
        if (current && current.storageFile !== previous.storageFile) {
          await persist(() => unlink(textPath(previous.id, previous.storageFile)).catch(() => {}))
        }
      }
      return value
    } catch (error) {
      docs = before
      texts.clear()
      for (const [id, text] of oldTexts) texts.set(id, text)
      notifyKnowledge()
      throw error
    } finally {
      mutating = false
    }
  })
  mutations = current.catch(() => {})
  return current
}

const legacyKnowledgeAdmin = createKnowledgeAdmin({
  load,
  texts,
  mutate,
  addDoc,
  updateDoc,
  saveIndex,
  storeDir
})

const remoteAdmin: any = Object.fromEntries(
  [
    'list',
    'get',
    'create',
    'update',
    'trash',
    'restore',
    'chunks',
    'original',
    'backup',
    'importBackup'
  ].map((method) => [
    method,
    (...args: unknown[]) => remoteLibrary!.call(method, [selectedLibrary(), ...args])
  ])
)
remoteAdmin.importFile = (file: any) => remoteLibrary!.call('upload', [selectedLibrary(), file])
export const knowledgeAdmin: typeof legacyKnowledgeAdmin = remoteLibrary
  ? remoteAdmin
  : legacyKnowledgeAdmin
export function getLibrary() {
  return library
}

export function refreshKnowledge() {
  if (!remoteLibrary) load()
  notifyKnowledge()
}

const activeUploads = new Map<string, AbortController>()
ipcMain.handle('knowledge:upload', async (event, path: string, submission: string, project = selectedLibrary()) => {
  if (!remoteLibrary || typeof path !== 'string' || !/^[a-f0-9-]{36}$/.test(submission))
    throw Error('上传请求无效')
  if (activeUploads.has(submission)) throw Error('该文件正在上传')
  const controller = new AbortController()
  activeUploads.set(submission, controller)
  try {
    const receipt = await remoteLibrary.upload(
      path,
      submission,
      (loaded, total) => {
        if (!event.sender.isDestroyed())
          event.sender.send('knowledge:upload-progress', { submission, loaded, total })
      },
      controller.signal,
      project
    )
    notifyKnowledge()
    return receipt
  } finally {
    activeUploads.delete(submission)
  }
})
ipcMain.handle('knowledge:cancel-upload', (_event, submission: string) =>
  activeUploads.get(submission)?.abort()
)
ipcMain.handle('knowledge:upload-state', async (_event, jobId: string, project = selectedLibrary()) => {
  if (!remoteLibrary || typeof jobId !== 'string') throw Error('任务无效')
  const [task, index] = await Promise.all([
    remoteLibrary.call('task', [project, jobId]),
    remoteLibrary.call('status', [project])
  ])
  const doc = await remoteLibrary.call('get', [project, task.payload.docId])
  return { task: { status: task.status, error: task.error }, index, document: { processingStatus: doc.processingStatus, indexReady: doc.indexReady } }
})
ipcMain.handle('knowledge:select-files', async (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender)
  if (!parent || parent.isDestroyed()) throw Error('窗口已关闭，请重新打开设置')
  const result = await dialog.showOpenDialog(parent, {
    title: '上传到默认知识库',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '文档与图片', extensions: KNOWLEDGE_EXTENSIONS }]
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('knowledge:libraries', async () => {
  if (!remoteLibrary) throw Error('知识库服务未就绪')
  const libraries = await remoteLibrary.call('projects', [])
  return { selected: selectedLibrary(), libraries }
})
ipcMain.handle('knowledge:select-library', async (_event, id: string) => {
  if (!remoteLibrary || typeof id !== 'string') throw Error('知识库无效')
  const libraries = await remoteLibrary.call('projects', [])
  if (!libraries.some((item: any) => item.id === id)) throw Error('知识库已删除，请刷新')
  selectLibrary(id)
  notifyKnowledge()
})
