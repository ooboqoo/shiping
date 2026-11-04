import { selectedLibrary } from '../library-v4/selection'
import { buildGeneration, retrieveGeneration } from '../library/generations'
import { app } from 'electron'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import type { AppMode } from '../../shared/api-profile'
import { settings } from '../settings'
import {
  getKnowledgePrompt,
  getRagDocuments,
  onKnowledgeChanged,
  getLibrary,
  getRemoteLibrary
} from '../knowledge'
import { RagIndex } from './index'
import * as client from './client'
import { extractQuery } from './query'
import { formatContext } from './chunks'
let index: RagIndex | undefined
const statePath = () => join(app.getPath('userData'), 'rag', 'active-structure-v2.json')
export function getIndex(): RagIndex {
  if (!index)
    index = new RagIndex({
      fingerprint: client.fingerprint,
      embed: client.embed,
      upsert: client.upsert,
      query: client.searchVectors,
      remove: client.remove,
      load: () =>
        existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), 'utf8')) : undefined,
      save: async (data) => {
        const p = statePath()
        await mkdir(join(p, '..'), { recursive: true })
        await writeFile(p + '.tmp', JSON.stringify(data))
        await rename(p + '.tmp', p)
      }
    })
  index.setDocuments(getRagDocuments())
  return index
}
let timer: ReturnType<typeof setTimeout> | undefined
let clearing = false
let generationBuilding = false,
  generationAgain = false
let generationError = ''
let afterClear: boolean | undefined
export function getRagStatus() {
  const remote = getRemoteLibrary?.()
  if (remote) return remote.call('status', [selectedLibrary()])
  const gen = getLibrary?.()?.generation(selectedLibrary())
  if (gen)
    return {
      state: generationBuilding
        ? ('indexing' as const)
        : generationError
          ? ('error' as const)
          : ('ready' as const),
      message: generationError || (generationBuilding ? '正在构建候选索引' : '结构化索引就绪'),
      documents: getRagDocuments().filter((d) => d.modes.length).length,
      chunks: gen.chunks.length
    }
  const status = getIndex().getStatus()
  return clearing
    ? { ...status, state: 'indexing' as const, message: '正在清除索引，后续更新已排队' }
    : status
}
export function queueReconcile(force = false): void {
  if (getRemoteLibrary?.()) return
  const library = getLibrary?.()
  if (library?.generation(selectedLibrary())) {
    if (generationBuilding) {
      generationAgain = true
      return
    }
    generationBuilding = true
    generationError = ''
    void buildGeneration(library, selectedLibrary())
      .catch((e) => {
        generationError = String(e.message || e)
      })
      .finally(() => {
        generationBuilding = false
        if (generationAgain) {
          generationAgain = false
          queueReconcile(force)
        }
      })
    return
  }
  if (clearing) {
    afterClear = Boolean(afterClear || force)
    return
  }
  void getIndex()
    .reconcile(getRagDocuments(), force)
    .catch(() => {})
}
onKnowledgeChanged(() => {
  if (getRemoteLibrary?.()) return
  if (!index && !getLibrary?.()?.generation(selectedLibrary())) return
  index?.setDocuments(getRagDocuments())
  if (clearing && settings.ragConfig.mode === 'local') {
    afterClear = afterClear ?? false
    return
  }
  if (settings.ragConfig.mode === 'local' && !clearing) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      queueReconcile()
    }, 500)
  }
})
export async function rebuild(): Promise<void> {
  const remote = getRemoteLibrary?.()
  if (remote) {
    await remote.call('scheduleIndex', [selectedLibrary(), 'full'])
    return
  }
  const library = getLibrary?.()
  if (library?.generation(selectedLibrary())) {
    await buildGeneration(library, selectedLibrary())
    return
  }
  if (clearing) throw new Error('正在清除索引，请稍后重试')
  await getIndex().reconcile(getRagDocuments(), true)
}
export async function clear(): Promise<void> {
  if (getRemoteLibrary?.()) throw Error('请在本机管理网页清空资料库，索引历史仅在确认后清理')
  if (getLibrary?.()?.generation(selectedLibrary()))
    throw Error('结构化索引保留用于回退；请通过处理报告重建，暂不物理删除代际')
  if (clearing || getIndex().getStatus().state === 'indexing')
    throw new Error('请等待索引任务完成再清除')
  if (timer) {
    clearTimeout(timer)
    timer = undefined
  }
  clearing = true
  getIndex().invalidate()
  try {
    await client.clearProjectIndex()
    const p = statePath()
    await mkdir(join(p, '..'), { recursive: true })
    await writeFile(p + '.tmp', JSON.stringify({ fingerprint: '', revisions: {}, ids: [] }))
    await rename(p + '.tmp', p)
  } finally {
    clearing = false
    const pending = afterClear
    afterClear = undefined
    if (pending !== undefined) queueReconcile(pending)
  }
}
export async function getRagContext(
  mode: AppMode,
  messages: ModelMessage[],
  signal?: AbortSignal
): Promise<string> {
  const remote = getRemoteLibrary?.()
  if (remote) {
    if (settings.ragConfig.mode !== 'local')
      return remote.call('fullContext', [selectedLibrary(), mode], signal)
    const query = extractQuery(messages)
    if (!query) return '当前问题没有可用于文本检索的文字，本轮未附带知识库内容。'
    return (await remote.call('searchDetails', [selectedLibrary(), query, mode], signal)).context
  }
  if (settings.ragConfig.mode !== 'local') return getKnowledgePrompt(mode)
  if (clearing) throw new Error('正在清除资料索引，请稍后重试')
  const query = extractQuery(messages)
  if (!query) return '当前问题只有图片，没有可供本地文本检索的文字；本轮未附带资料库内容。'
  const hits = await searchRag(query, mode, signal)
  // Refresh authoritative document state after asynchronous retrieval as well.
  const live = getRagDocuments()
  return formatContext(
    hits.filter((h) =>
      live.some((d) => d.id === h.docId && d.revision === h.revision && d.modes.includes(mode))
    )
  )
}

export async function searchRag(query: string, mode: AppMode, signal?: AbortSignal) {
  const remote = getRemoteLibrary?.()
  if (remote) return remote.call('search', [selectedLibrary(), query, mode], signal)
  const library = getLibrary?.()
  if (library) {
    const hits = await retrieveGeneration(library, selectedLibrary(), query, mode, signal)
    if (hits !== undefined) return hits
  }
  return getIndex().retrieve(mode, query, signal)
}
