import type { AppMode } from './api-profile'

/**
 * 资料库: one piece of reference material the user brought (a resume, prepared
 * Q&A, notes). Main keeps the list and each text on disk, and puts the ones a
 * mode uses in front of that mode's system prompt.
 */
export interface KnowledgeDoc {
  id: string
  name: string
  /** File name it was imported from; absent for pasted text */
  source?: string
  /** Full path of that file, for 「重新导入」 */
  sourcePath?: string
  /** Atomic on-disk text revision; absent for legacy id.txt storage. */
  storageFile?: string
  chars: number
  /** Rough estimate, see `estimateTokens` */
  tokens: number
  /** Modes whose requests carry it; empty means it is kept but not sent */
  modes: AppMode[]
  updatedAt: number
  /** Local web management retains removed sources in its recycle bin. */
  deletedAt?: number
  tags?: string[]
  /** Optimistic edit token returned by main; never an authoritative disk field. */
  version?: string
}

export type KnowledgePatch = Partial<Pick<KnowledgeDoc, 'name' | 'modes'>> & {
  text?: string
  version?: string
}

export function mergeKnowledgeDocs(
  existing: KnowledgeDoc[],
  incoming: KnowledgeDoc[]
): KnowledgeDoc[] {
  return [...new Map([...existing, ...incoming].map((doc) => [doc.id, doc])).values()]
}

export interface KnowledgeImportResult {
  added: KnowledgeDoc[]
  failed: { name: string; error: string }[]
}

/**
 * Above this many characters for one mode the settings page warns: answers get
 * slower and dearer, and small models run out of context. It is not enforced.
 */
export const KNOWLEDGE_CHAR_LIMIT = 30000

/** File types the importer reads */
export const KNOWLEDGE_EXTENSIONS = [
  'pdf',
  'docx',
  'md',
  'markdown',
  'txt',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'xlsx',
  'pptx'
]

const CJK = /[\u3000-\u303f\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g

/**
 * Tokens `text` roughly costs: about 0.7 per Chinese character and one per 3.5
 * other characters, near what DeepSeek / Qwen / GPT tokenisers give
 */
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0
  return Math.ceil(cjk * 0.7 + (text.length - cjk) / 3.5)
}
