import type { AppMode } from './api-profile'
export interface RagConfig {
  mode: 'full' | 'local'
}
export interface RagChunk {
  id: string
  docId: string
  revision: string
  text: string
  section?: string
  start: number
  end: number
}
export interface RagHit extends RagChunk {
  name: string
  score: number
}
export interface RagDocument {
  id: string
  name: string
  text: string
  modes: AppMode[]
  revision: string
}
export interface RagStatus {
  state: 'idle' | 'indexing' | 'ready' | 'error'
  message: string
  documents: number
  chunks: number
}
export const OLLAMA_URL = 'http://127.0.0.1:11435'
export const CHROMA_URL = 'http://127.0.0.1:18000'
export const COLLECTION = 'shiping_knowledge_bgem3_v2'
export const CHUNK_VERSION = 'structure-v2'
export const EMBED_MODEL = 'bge-m3'
export function normalizeRagConfig(value: unknown): RagConfig {
  if (
    typeof value !== 'object' ||
    value === null ||
    !['full', 'local'].includes((value as RagConfig).mode)
  )
    throw new Error('无效的资料检索模式')
  return { mode: (value as RagConfig).mode }
}
