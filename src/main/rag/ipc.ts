import { getRemoteLibrary } from '../knowledge'
import { createModelSettingsHandler } from '../library-v4/model-settings'
import { ipcMain } from 'electron'
import { searchRag, getRagStatus, rebuild, clear } from './service'
import { checkServices } from './client'
function modeOf(mode: unknown): 'conversation' | 'screenshot' {
  if (mode !== 'conversation' && mode !== 'screenshot') throw new Error('无效模式')
  return mode
}
ipcMain.handle('rag:status', () => getRagStatus())
ipcMain.handle('rag:check', async () => {
  const remote = getRemoteLibrary()
  if (!remote) return checkServices()
  await remote.call('runtimeStatus', [])
  const config = await remote.call<{ embedding: { configured?: boolean } }>('providerStatus', [])
  if (config.embedding.configured === false)
    throw Error('请先在AI模型中配置向量模型，上传的资料将等待配置完成')
  return '内置知识库已就绪，向量模型已配置'
})
ipcMain.handle('rag:rebuild', () => rebuild())
ipcMain.handle('rag:clear', () => clear())
ipcMain.handle('rag:preview', async (_event, mode, query) => {
  if (typeof query !== 'string' || !query.trim() || query.length > 3000)
    throw new Error('请输入 1–3000 字的问题')
  return searchRag(query, modeOf(mode))
})

const models = createModelSettingsHandler(getRemoteLibrary)
ipcMain.handle('rag:models:status', () => models('status'))
ipcMain.handle('rag:models:save', (_event, kind, config) => models('save', kind, config))
ipcMain.handle('rag:models:list', (_event, kind, config) => models('models', kind, config))
ipcMain.handle('rag:models:test', (_event, kind, config) => models('test', kind, config))
ipcMain.handle('rag:models:rerank', (_event, enabled) =>
  models('rerank-enabled', undefined, enabled)
)
