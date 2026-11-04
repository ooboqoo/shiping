import { ipcMain } from 'electron'
import {
  normalizeExternalKnowledge,
  type ExternalKnowledgeTestResult
} from '../shared/external-knowledge'
import { retrieveExternal } from './external-knowledge'

/**
 * The settings page's 「测试」: one retrieval with the draft settings, results
 * shown there only (the settings page is kept off a shared screen). Kept apart
 * from external-knowledge.ts so tests load that without ipcMain.
 */
ipcMain.handle(
  'external-knowledge:test',
  async (_event, draft: unknown, query: string): Promise<ExternalKnowledgeTestResult> => {
    const started = Date.now()
    try {
      const records = await retrieveExternal(normalizeExternalKnowledge(draft), String(query))
      return { ok: true, elapsedMs: Date.now() - started, records }
    } catch (error) {
      return {
        ok: false,
        elapsedMs: Date.now() - started,
        records: [],
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }
)
