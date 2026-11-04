export interface ParseProgress {stage:'checking'|'parsing'|'ocr'|'cleaning'|'completed';page:number;total:number;fraction?:number}
export interface OCRObservation {raw:string;text:string;confidence?:number;rotation?:number;lines?:{text:string;confidence?:number;bbox?:number[]}[]}
export type PageType = 'text' | 'scan' | 'mixed' | 'complex' | 'abnormal' | 'blank'
export interface Element {
  id: string
  type: string
  text: string
  bbox?: number[]
  rawText?: string
  confidence?: number
  asset?: string
  method?: string
}
export interface Issue {
  code: string
  reason: string
  severity: 'warning' | 'error'
  reviewed?: boolean
}
export interface PageResult {
  number: number
  excluded?: boolean
  exclusionReason?: string
  type: PageType
  method: string
  status: 'complete' | 'failed' | 'blank'
  rawText?: string
  ocrConfidence?: number
  width?: number
  height?: number
  rotation?: number
  elements: Element[]
  issues: Issue[]
}
export interface Change {
  id: string
  page: number
  elementId: string
  rule: string
  before: string
  after: string
  reason: string
  accepted: boolean
}
export interface SourceRange {
  start: number
  end: number
  page: number
  elementId: string
  bbox?: number[]
}
export interface ProcessingResult {
  schema: 1
  disabledRules?: string[]
  ruleVersion: string
  sourceName?: string
  sourceHash?: string
  totalPages: number
  pages: PageResult[]
  raw: string
  cleaned: string
  changes: Change[]
  sources: SourceRange[]
  issues: Issue[]
  complete: boolean
}
