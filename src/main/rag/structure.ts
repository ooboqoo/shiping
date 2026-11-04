/** Deterministic structure-aware spans; offsets always reference the unchanged source. */
export interface StructuredSpan {
  start: number
  end: number
  section: string
}
interface Region extends StructuredSpan {
  headingEnd: number
}
const TARGET = 600,
  MAX = 1200,
  OVERLAP = 100
function lines(text: string, start = 0, end = text.length) {
  const result: { start: number; end: number; text: string }[] = []
  const re = /[^\n]*\n|[^\n]+$/g
  for (const match of text.slice(start, end).matchAll(re))
    result.push({
      start: start + match.index!,
      end: start + match.index! + match[0].length,
      text: match[0]
    })
  return result
}
function regions(text: string): Region[] {
  const result: Region[] = [],
    titles: string[] = []
  let current: Region = { start: 0, end: text.length, section: '', headingEnd: 0 },
    fence = ''
  for (const line of lines(text)) {
    const f = line.text.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (f) {
      if (!fence) fence = f[1]
      else if (
        f[1][0] === fence[0] &&
        f[1].length >= fence.length &&
        new RegExp(`^\\s{0,3}${fence[0]}{${fence.length},}\\s*$`).test(line.text.trimEnd())
      )
        fence = ''
      continue
    }
    if (fence) continue
    const md = line.text.trimEnd().match(/^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/)
    const numbered = line.text.trim().match(/^(\d+(?:\.\d+){1,4})\s+(.{1,70})$/)
    if (!md && !numbered) continue
    if (numbered && /[。！？；]$/.test(numbered[2])) continue
    const depth = md ? md[1].length : numbered![1].split('.').length
    const title = (
      md ? md[2].replace(/[ \t]+#+[ \t]*$/, '') : `${numbered![1]} ${numbered![2]}`
    ).slice(0, 120)
    titles.length = depth - 1
    titles[depth - 1] = title
    let nextStart = current.start
    if (text.slice(current.headingEnd, line.start).trim()) {
      result.push({ ...current, end: line.start })
      nextStart = line.start
    }
    current = {
      start: nextStart,
      end: text.length,
      section: titles.filter(Boolean).join(' > '),
      headingEnd: line.end
    }
  }
  if (text.slice(current.start).trim()) result.push(current)
  return result
}
function protectedRanges(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  // Scan Markdown destinations with balanced parentheses rather than stopping at the first ')'.
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(/g)) {
    const start = match.index!,
      opening = start + match[0].length - 1
    let depth = 1
    for (let i = opening + 1; i < Math.min(text.length, start + MAX + 1); i++) {
      if (text[i] === '\\') {
        i++
        continue
      }
      if (text[i] === '\n') break
      if (text[i] === '(') depth++
      if (text[i] === ')' && --depth === 0) {
        ranges.push({ start, end: i + 1 })
        break
      }
    }
  }
  for (const m of text.matchAll(/`[^`\n]+`/g))
    ranges.push({ start: m.index!, end: m.index! + m[0].length })
  for (const m of text.matchAll(/https?:\/\/[^\s<>`[\]。，；！？、]+/g)) {
    const start = m.index!
    if (!ranges.some((r) => r.start <= start && start < r.end))
      ranges.push({ start, end: start + m[0].length })
  }
  const merged: typeof ranges = []
  for (const range of ranges.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1)
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}
export function structureSpans(text: string): StructuredSpan[] {
  const protectedSpans = protectedRanges(text),
    result: StructuredSpan[] = []
  for (const region of regions(text)) {
    const ls = lines(text, region.start, region.end),
      units: { start: number; end: number; atomic: boolean }[] = []
    let i = 0
    while (i < ls.length) {
      const begin = i,
        opener = ls[i].text.match(/^\s{0,3}(`{3,}|~{3,})/),
        table = ls[i].text.split('|').length >= 3
      let atomic = false
      if (opener) {
        atomic = true
        i++
        while (i < ls.length) {
          const t = ls[i++].text.trimEnd()
          if (new RegExp(`^ {0,3}${opener[1][0]}{${opener[1].length},}\\s*$`).test(t)) break
        }
      } else if (table) {
        atomic = true
        while (i < ls.length && ls[i].text.split('|').length >= 3) i++
      } else {
        i++
        while (
          i < ls.length &&
          ls[i - 1].text.trim() &&
          ls[i].text.trim() &&
          !/^\s{0,3}(`{3,}|~{3,})/.test(ls[i].text) &&
          ls[i].text.split('|').length < 3
        )
          i++
      }
      while (i < ls.length && !ls[i].text.trim()) i++
      units.push({ start: ls[begin].start, end: ls[i - 1].end, atomic })
    }
    const pieces: typeof units = []
    for (const unit of units) {
      if (unit.end - unit.start <= MAX) {
        pieces.push(unit)
        continue
      }
      let start = unit.start
      while (start < unit.end) {
        if (unit.end - start <= TARGET) {
          pieces.push({ start, end: unit.end, atomic: false })
          break
        }
        let end = Math.min(start + TARGET, unit.end)
        // Prefer sentence/line ends in the latter half of a normal window.
        const candidates = [...text.slice(start + 300, end).matchAll(/[。！？；.!?](?:[\s]|$)|\n/g)]
        if (candidates.length) {
          const last = candidates.at(-1)!
          end = start + 300 + last.index! + last[0].length
        }
        let changed = true
        while (changed) {
          changed = false
          for (const p of protectedSpans) {
            if (p.start < end && end < p.end) {
              if (p.start > start) {
                end = p.start
              } else if (p.end - start <= MAX) {
                end = p.end
              } else throw new Error('存在超过1200字符的链接或内联代码，请精简后重新导入')
              changed = true
              break
            }
          }
        }
        if (end <= start) throw new Error('资料无法安全分片，请检查超长链接')
        if (
          end < unit.end &&
          /[\uDC00-\uDFFF]/.test(text[end]) &&
          /[\uD800-\uDBFF]/.test(text[end - 1])
        )
          end--
        pieces.push({ start, end, atomic: false })
        start = end
      }
    }
    const groups: typeof units = []
    for (const p of pieces) {
      const last = groups.at(-1)
      if (last && p.end - last.start <= TARGET) {
        last.end = p.end
        last.atomic = last.atomic || p.atomic
      } else groups.push({ ...p })
    }
    for (let j = 0; j < groups.length; j++) {
      const group = groups[j]
      let start = group.start
      const prev = groups[j - 1]
      if (prev && !prev.atomic && !group.atomic) {
        const low = Math.max(prev.start, prev.end - OVERLAP)
        const tail = text.slice(low, prev.end),
          boundary = tail.search(/[。！？；.!?]\s*|\n/)
        start = boundary >= 0 ? low + boundary + 1 : low
        for (const p of protectedSpans) if (p.start < start && start < p.end) start = p.end
        if (group.end - start > MAX || start > group.start) start = group.start
      }
      if (text.slice(start, group.end).trim())
        result.push({ start, end: group.end, section: region.section })
    }
  }
  return result
}
