import type {
  PageResult,
  PageType,
  ProcessingResult,
  Change,
  SourceRange
} from '../../shared/document-processing'
export function classifyPage(f: {
  text: string
  imageCoverage: number
  images: number
  columns?: boolean
}): { type: PageType; reason: string } {
  const chars = f.text.replace(/\s/g, ''),
    bad = (chars.match(/[\ufffd\u0000-\u0008]/g) || []).length / Math.max(1, chars.length)
  if (bad > 0.1) return { type: 'abnormal', reason: '异常字符比例过高' }
  if (!chars.length && !f.images)
    return { type: 'blank', reason: '未发现文字或图片；需保留空白页记录' }
  if ((f.imageCoverage > 0.6 && chars.length < 100) || (!chars.length && f.images > 0))
    return { type: 'scan', reason: '主体由图片覆盖且原生文字不足' }
  if (f.columns) return { type: 'complex', reason: '疑似多栏，阅读顺序需核对' }
  if (f.images && f.imageCoverage > 0.03)
    return { type: 'mixed', reason: '原生文字与候选信息图片同时存在' }
  return { type: 'text', reason: '存在可读原生文字' }
}
export function cleanPages(pages: PageResult[], disabledRules: string[] = []): ProcessingResult {
  pages=pages.map(p=>({...p,issues:[...p.issues]}))
  const margin = new Map<string, Set<number>>()
  const key = (text: string) => text.trim().replace(/\d+/g, '#')
  for (const p of pages)
    for (const e of p.elements) {
      if (e.bbox && (e.bbox[3] < 0.12 || e.bbox[1] > 0.88)) {
        const k = key(e.text)
        if (k) {
          const set = margin.get(k) || new Set()
          set.add(p.number)
          margin.set(k, set)
        }
      }
    }
  const changes: Change[] = [],
    sources: SourceRange[] = []
  let raw = '',
    cleaned = ''
  for (const p of pages) {
    raw += `\n\n# 第 ${p.number} 页\n`
    cleaned += `\n\n# 第 ${p.number} 页${p.excluded ? '（已排除）' : ''}\n`
    if(p.rawText!==undefined)raw+=p.rawText+'\n'
    let previous: (typeof p.elements)[number] | undefined
    for (const e of p.elements) {
      if(p.rawText===undefined)raw += (e.rawText??e.text) + '\n'
      if (p.excluded) continue
      let next = e.text
      const change=(rule:string,after:string,reason:string)=>{if(next!==after){changes.push({id:`${p.number}:${e.id}:${rule}`,page:p.number,elementId:e.id,rule,before:next,after,reason,accepted:true});next=after}}
      if(!disabledRules.includes('controls') && e.type!=='code')change('controls',next.replace(/\r\n?/g,'\n').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFEFF\u200B\u2060]/g,''),'移除正文无意义控制字符，保留原始提取')
      if(e.type==='paragraph' && e.method==='ocr' && e.confidence!==undefined && e.confidence<50 && /^[\s。．.•●▪▫◦·‧…]+$/.test(next) && !disabledRules.includes('ocr-decoration'))change('ocr-decoration','','低置信度独立装饰/标点，不含正文数字或文字')
      if(next.trim().length>2 && e.type!=='code' && e.method==='ocr' && e.confidence!==undefined && e.confidence<45 && !p.issues.some(i=>i.code==='ocr-quality-review'))p.issues.push({code:'ocr-quality-review',severity:'warning',reason:'发现低置信度OCR行；已保留原文，请对照原页核对，不能以整页平均分替代逐行检查'})
      const edge = e.bbox && (e.bbox[3] < 0.12 || e.bbox[1] > 0.88),
        repeated =
          pages.length >= 3 &&
          (margin.get(key(e.text))?.size ?? 0) >= Math.max(3, Math.ceil(pages.length * 0.6))
      if (edge && repeated && e.type !== 'code' && !disabledRules.includes('repeated-margin')) {
        next = ''
        changes.push({
          id: `${p.number}:${e.id}:margin`,
          page: p.number,
          elementId: e.id,
          rule: 'repeated-margin',
          before: e.text,
          after: '',
          reason: '多页同边缘位置重复，候选页眉/页脚/页码',
          accepted: true
        })
      }
      // No blind paragraph concatenation: preserve code, numeric data and URLs verbatim.
      if (next) {
        const protectedLine = (line: typeof e) =>
          line.type !== 'paragraph' ||
          /https?:|www\.|[\t|`{}=<>]|^[ \t]*(?:[-*•]|\d+[.)、])|^[\d .,+-]+$/.test(line.text)
        if (
          previous?.bbox &&
          e.bbox &&
          !protectedLine(previous) &&
          !protectedLine(e) &&
          p.type !== 'complex' &&
          !disabledRules.includes('join-line') &&
          Math.abs(previous.bbox[0] - e.bbox[0]) < 0.015 &&
          e.bbox[1] >= previous.bbox[3] - 0.005 &&
          e.bbox[1] - previous.bbox[3] < 0.035 &&
          !/[。！？.!?:;：；]$/.test(previous.text.trim())
        ) {
          const separator =
            /[\u3400-\u9fff]$/.test(previous.text) && /^[\u3400-\u9fff]/.test(next) ? '' : ' '
          cleaned = cleaned.slice(0, -1) + separator
          if (sources.length) sources[sources.length - 1].end = cleaned.length
          changes.push({
            id: `${p.number}:${e.id}:join`,
            page: p.number,
            elementId: e.id,
            rule: 'join-line',
            before: previous.text + '\n' + next,
            after: previous.text + separator + next,
            reason: '相邻对齐续行，候选段落合并',
            accepted: true
          })
        }
        const start = cleaned.length
        cleaned += next + '\n'
        sources.push({ start, end: cleaned.length, page: p.number, elementId: e.id, bbox: e.bbox })
        previous = {...e,text:next}
      } else {
        previous = undefined
      }
    }
  }
  const complete = pages.every((p) => p.status !== 'failed' || p.excluded)
  const issues = pages.flatMap((p) => p.issues)
  return {
    schema: 1,
    disabledRules,
    ruleVersion: 'conservative-v2-lines',
    totalPages: pages.length,
    pages,
    raw,
    cleaned,
    changes,
    sources,
    issues,
    complete
  }
}
