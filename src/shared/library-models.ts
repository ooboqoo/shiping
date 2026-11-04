/** Library model credentials are stored by the shared service, never localStorage. */
export type ModelProvider =
  | 'ollama'
  | 'xinference'
  | 'siliconflow'
  | 'aliyun'
  | 'openai-compatible'
  | 'rerank-compatible'
export type LibraryModelKind = 'embedding' | 'rerank'
export interface ModelConfig {
  provider: ModelProvider
  baseURL: string
  model: string
  apiKey?: string
  timeoutMs?: number
}
export interface LibraryModelDraft {
  provider: ModelProvider | 'local'
  baseURL?: string
  model?: string
  apiKey?: string
  timeoutMs?: number
}
export type LibraryModelPublic = Omit<LibraryModelDraft, 'apiKey'> & {
  hasApiKey: boolean
  configured?: boolean
  enabled?: boolean
}
export interface LibraryModelSettings {
  embedding: LibraryModelPublic
  rerank: LibraryModelPublic
}
export interface LibraryProviderModel {
  id: string
  type?: string
  source?: 'preset'
}
export interface LibraryModelTest {
  ok: boolean
  dimensions?: number
}
