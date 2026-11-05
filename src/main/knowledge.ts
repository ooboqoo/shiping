import { app, dialog, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { rename, unlink, writeFile } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import { randomUUID } from 'crypto'
import { extractFileText, normalizeText } from './knowledge-parse'
import { dialogStartDir } from './settings'
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

const MAX_NAME_LENGTH = 40

let docs: KnowledgeDoc[] | null = null
const texts = new Map<string, string>()

function storeDir(): string {
  return join(app.getPath('userData'), 'knowledge')
}

const indexPath = () => join(storeDir(), 'index.json')
const textPath = (id: string) => join(storeDir(), `${id}.txt`)

/** The list and every text, read from disk on first use */
function load(): KnowledgeDoc[] {
  if (docs) return docs
  docs = []
  try {
    if (existsSync(indexPath())) {
      const saved = JSON.parse(readFileSync(indexPath(), 'utf-8')) as KnowledgeDoc[]
      for (const doc of saved) {
        // A text lost outside the app takes its entry with it
        if (!existsSync(textPath(doc.id))) continue
        texts.set(doc.id, readFileSync(textPath(doc.id), 'utf-8'))
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
  writing = writing.then(task).catch((error) => {
    console.error('Failed to save knowledge base:', error)
  })
  return writing
}

/** Write through a temporary file, so a crash never leaves half a file behind */
async function writeAtomic(path: string, content: string) {
  const temp = `${path}.tmp`
  await writeFile(temp, content, 'utf-8')
  await rename(temp, path)
}

function saveIndex(): Promise<void> {
  const snapshot = JSON.stringify(load(), null, 2)
  return persist(async () => {
    mkdirSync(storeDir(), { recursive: true })
    await writeAtomic(indexPath(), snapshot)
  })
}

function saveText(id: string, text: string): Promise<void> {
  return persist(async () => {
    mkdirSync(storeDir(), { recursive: true })
    await writeAtomic(textPath(id), text)
  })
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
  source?: { name: string; path: string }
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
  await saveText(doc.id, text)
  await saveIndex()
  return doc
}

async function importFiles(paths: string[]): Promise<KnowledgeImportResult> {
  const result: KnowledgeImportResult = { added: [], failed: [] }
  for (const path of paths) {
    const fileName = basename(path)
    try {
      const text = await extractFileText(path)
      const name = basename(fileName, extname(fileName))
      result.added.push(await addDoc(name, text, { name: fileName, path }))
    } catch (error) {
      result.failed.push({
        name: fileName,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return result
}

async function updateDoc(id: string, patch: KnowledgePatch): Promise<KnowledgeDoc | null> {
  const doc = load().find((d) => d.id === id)
  if (!doc) return null
  if (patch.name !== undefined) doc.name = tidyName(patch.name, doc.name)
  if (patch.modes) doc.modes = patch.modes.filter((m) => m === 'screenshot' || m === 'conversation')
  if (patch.text !== undefined) {
    const text = normalizeText(patch.text)
    texts.set(id, text)
    Object.assign(doc, measure(text))
    await saveText(id, text)
  }
  doc.updatedAt = Date.now()
  await saveIndex()
  return { ...doc }
}

/** Read the file it came from again; keeps its name and modes */
async function reimportDoc(id: string): Promise<{ doc?: KnowledgeDoc; error?: string }> {
  const doc = load().find((d) => d.id === id)
  if (!doc?.sourcePath) return { error: '这份资料不是从文件导入的' }
  try {
    const text = await extractFileText(doc.sourcePath)
    return { doc: (await updateDoc(id, { text })) ?? undefined }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

async function removeDoc(id: string): Promise<void> {
  const list = load()
  const index = list.findIndex((d) => d.id === id)
  if (index < 0) return
  list.splice(index, 1)
  texts.delete(id)
  await saveIndex()
  await persist(() => unlink(textPath(id)).catch(() => {}))
}

/**
 * The material a mode uses, as the opening of its system prompt. It goes before
 * the scene's prompt: a prefix that stays the same across requests (and across
 * scene switches) is what platforms cache, and the scene's format rules then
 * sit closer to the question.
 */
export function getKnowledgePrompt(mode: AppMode): string {
  const used = load().filter((doc) => doc.modes.includes(mode) && texts.get(doc.id))
  if (used.length === 0) return ''

  const blocks = used.map(
    (doc) => `<资料 name="${doc.name.replaceAll('"', "'")}">\n${texts.get(doc.id)}\n</资料>`
  )
  return [
    '# 参考资料',
    '以下是用户本人提供的资料（如简历、准备好的问答、笔记、参考文档），每份放在一个 <资料> 标签里。作答时：',
    [
      '- 问题与资料相关时，优先依据资料作答；涉及用户本人的经历时，以第一人称结合资料里的项目、数据和说法；',
      '- 资料里有与问题对应的现成回答时，以它为准，保留其要点和说法；',
      '- 资料与问题无关时忽略它，也不要提及资料本身；',
      '- 分隔线之后的任务说明和输出格式要求优先于本节。'
    ].join('\n'),
    ...blocks,
    '---'
  ].join('\n\n')
}

ipcMain.handle('knowledge:list', () => load().map((doc) => ({ ...doc })))

ipcMain.handle('knowledge:get-text', (_event, id: string) => {
  load()
  return texts.get(id) ?? ''
})

/** Folder of the file-imported doc changed last, for the import dialog to open in */
function lastImportDir(): string | undefined {
  const [latest] = load()
    .filter((doc) => doc.sourcePath)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return dialogStartDir(latest?.sourcePath && dirname(latest.sourcePath))
}

ipcMain.handle('knowledge:pick-files', async () => {
  const result = await dialog.showOpenDialog({
    title: '导入资料',
    defaultPath: lastImportDir(),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF、Word、Markdown、TXT', extensions: KNOWLEDGE_EXTENSIONS }]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return importFiles(result.filePaths)
})

ipcMain.handle('knowledge:import-files', (_event, paths: string[]) => importFiles(paths))

ipcMain.handle('knowledge:create', async (_event, name: string, text: string) => {
  const doc = await addDoc(name, normalizeText(text))
  return { ...doc }
})

ipcMain.handle('knowledge:update', (_event, id: string, patch: KnowledgePatch) =>
  updateDoc(id, patch)
)

ipcMain.handle('knowledge:reimport', (_event, id: string) => reimportDoc(id))

ipcMain.handle('knowledge:remove', (_event, id: string) => removeDoc(id))
