import { createHash } from 'node:crypto'
import { structureSpans } from '../rag/structure'
import type { ProcessingResult } from '../../shared/document-processing'
export const MARKDOWN_VERSION = 'markdown-v1'
export const SPLIT_VERSION = 'markdown-structure-v1'
export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export function canonicalMarkdown(text: string): string {
  const normalized = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  if (!normalized.trim() || normalized.length > 2_000_000)
    throw Error('Markdown正文为空或超过200万字符')
  return normalized.replace(/\n*$/, '') + '\n'
}
export function reportMarkdown(report: ProcessingResult, ext: string): ProcessingResult {
  const edits: { start: number; end: number; text: string }[] = []
  // Generated locators belong to provenance, not the semantic heading tree.
  for (const match of report.cleaned.matchAll(/^# 第 \d+ 页(?:（已排除）)?\n/gm))
    edits.push({ start: match.index!, end: match.index! + match[0].length, text: '' })
  if (ext === 'pdf')
    for (const source of report.sources || []) {
      const element = report.pages
        .find((p) => p.number === source.page)
        ?.elements.find((e) => e.id === source.elementId)
      if (
        element?.type === 'heading' &&
        report.cleaned.slice(source.start, source.end).trim() === element.text.trim() &&
        !/^\s*#/.test(report.cleaned.slice(source.start, source.end))
      )
        edits.push({ start: source.start, end: source.start, text: '# ' })
    }
  edits.sort((a, b) => a.start - b.start || a.end - b.end)
  let cursor = 0,
    output = ''
  for (const e of edits) {
    if (e.start < cursor) continue
    output += report.cleaned.slice(cursor, e.start) + e.text
    cursor = e.end
  }
  output += report.cleaned.slice(cursor)
  const map = (offset: number) =>
    offset +
    edits
      .filter((e) => e.end <= offset)
      .reduce((sum, e) => sum + e.text.length - (e.end - e.start), 0)
  const cleaned = canonicalMarkdown(output)
  const sources =
    cleaned === output || cleaned === output + '\n'
      ? (report.sources || []).map((s) => ({ ...s, start: map(s.start), end: map(s.end) }))
      : []
  return { ...report, cleaned, sources, ruleVersion: report.ruleVersion + '+' + MARKDOWN_VERSION }
}
export interface MarkdownChunk {
  id: string
  docId: string
  revision: string
  vectorKey: string
  inputHash: string
  input: string
  text: string
  section: string
  start: number
  end: number
  syntheticPrefix?: string
  syntheticSuffix?: string
}
export function markdownChunks(docId: string, text: string): MarkdownChunk[] {
  const result: MarkdownChunk[] = [],
    revision = digest(text),
    lines = [...text.matchAll(/[^\n]*\n|[^\n]+$/g)]
  let normalStart = 0,
    section: string[] = [],
    normalSection: string[] = []
  const add = (
    start: number,
    end: number,
    body: string,
    title: string,
    prefix = '',
    suffix = ''
  ) => {
    if (!body.trim()) return
    const input = title ? title + '\n' + body : body,
      inputHash = digest(input)
    result.push({
      id: `${docId}:${revision}:${start}:${end}:${result.length}`,
      docId,
      revision,
      vectorKey: `v4:${docId}:${inputHash}`,
      inputHash,
      input,
      text: body,
      section: title,
      start,
      end,
      ...(prefix ? { syntheticPrefix: prefix } : {}),
      ...(suffix ? { syntheticSuffix: suffix } : {})
    })
  }
  const normal = (end: number) => {
    if (end <= normalStart) return
    for (const span of structureSpans(text.slice(normalStart, end)))
      add(
        normalStart + span.start,
        normalStart + span.end,
        text.slice(normalStart + span.start, normalStart + span.end),
        span.section || normalSection.filter(Boolean).join(' > ')
      )
  }
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i][0].match(/^(#{1,6})\s+(.+?)\s*\n?$/)
    if (heading) {
      section.length = heading[1].length
      section[heading[1].length - 1] = heading[2]
    }
    const opener = lines[i][0].match(/^ {0,3}(`{3,}|~{3,})([^\n]*)/),
      table =
        lines[i][0].split('|').length >= 3 &&
        i + 1 < lines.length &&
        /^\s*\|?\s*:?-{3}/.test(lines[i + 1][0])
    if (!opener && !table) continue
    const begin = i
    let end = i + 1
    if (opener) {
      while (
        end < lines.length &&
        !new RegExp('^ {0,3}' + opener[1][0] + '{' + opener[1].length + ',}\\s*$').test(
          lines[end][0].trimEnd()
        )
      )
        end++
      if (end === lines.length) throw Error('代码围栏未闭合，请修正Markdown')
      end++
    } else while (end < lines.length && lines[end][0].split('|').length >= 3) end++
    const start = lines[begin].index!,
      finish = end < lines.length ? lines[end].index! : text.length
    if (finish - start <= 1200) {
      i = end - 1
      continue
    }
    normal(start)
    const prefix = opener ? lines[begin][0] : lines[begin][0] + lines[begin + 1][0],
      suffix = opener ? opener[1] + '\n' : '',
      first = begin + (opener ? 1 : 2),
      last = end - (opener ? 1 : 0)
    let body = '',
      bodyStart = first < lines.length ? lines[first].index! : finish,
      bodyEnd = bodyStart
    const flush = () => {
      if (body) {
        add(
          bodyStart,
          bodyEnd,
          prefix + body + suffix,
          section.filter(Boolean).join(' > '),
          prefix,
          suffix
        )
        body = ''
      }
    }
    for (let j = first; j < last; j++) {
      const row = lines[j][0]
      if (prefix.length + row.length + suffix.length > 1200)
        throw Error('代码单行或表格单行超过安全分片上限，请拆分该行')
      if (body && prefix.length + body.length + row.length + suffix.length > 600) flush()
      if (!body) bodyStart = lines[j].index!
      body += row
      bodyEnd = lines[j].index! + row.length
    }
    flush()
    normalStart = finish
    normalSection = [...section]
    i = end - 1
  }
  normal(text.length)
  return result
}
