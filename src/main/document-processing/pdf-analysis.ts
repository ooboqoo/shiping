import { ocrElements } from './ocr-result'
import { orderElements } from './layout'
import type { PageResult, Element, OCRObservation, ParseProgress } from '../../shared/document-processing'
import { classifyPage, cleanPages } from './quality'
function multiply(m: number[], n: number[]) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ]
}
export async function analyzePdf(
  pdf: any,
  tools: {
    OPS: any
    extractImages: (n: number) => Promise<any[]>
    ocrPage: (n: number) => Promise<string | OCRObservation>
    ocrImage: (image: any) => Promise<string | OCRObservation>
    progress?: (progress:ParseProgress)=>void
  }
) {
  if (pdf.numPages > 150) throw Error('PDF超过150页，请拆分')
  const pages: PageResult[] = []
  for (let n = 1; n <= pdf.numPages; n++) {
    const result: PageResult = {
      number: n,
      type: 'abnormal',
      method: 'native',
      status: 'complete',
      elements: [],
      issues: []
    }
    pages.push(result)
    tools.progress?.({stage:'parsing',page:n,total:pdf.numPages})
    try {
      const page = await pdf.getPage(n),
        view = page.getViewport({ scale: 1 }),
        content = await page.getTextContent()
      result.width = view.width
      result.height = view.height
      result.rotation = page.rotate || 0
      const items = content.items.filter((i: any) => typeof i.str === 'string' && i.str.trim())
      const heights = items
        .map((i: any) => Math.abs(i.height || i.transform[3] || 10))
        .sort((a: number, b: number) => a - b)
      const median = heights[Math.floor(heights.length / 2)] || 10
      const elements: Element[] = items.map((i: any, index: number) => {
        const [x, y] = view.convertToViewportPoint(i.transform[4], i.transform[5]),
          h = Math.abs(i.height || i.transform[3] || 10),
          w = Math.abs(i.width || 1)
        return {
          id: `p${n}-t${index}`,
          text: i.str,
          type: /mono|courier/i.test(content.styles?.[i.fontName]?.fontFamily || '')
            ? 'code'
            : h > median * 1.4 && i.str.length < 100
              ? 'heading'
              : 'paragraph',
          bbox: [
            Math.max(0, x / view.width),
            Math.max(0, (y - h) / view.height),
            Math.min(1, (x + w) / view.width),
            Math.min(1, y / view.height)
          ],
          method: 'native'
        }
      })
      const operators = await page.getOperatorList(),
        boxes = new Map<string, number[]>()
      let matrix = [1, 0, 0, 1, 0, 0]
      const stack: number[][] = []
      for (let i = 0; i < operators.fnArray.length; i++) {
        const op = operators.fnArray[i],
          arg = operators.argsArray[i]
        if (op === tools.OPS.save) stack.push([...matrix])
        else if (op === tools.OPS.restore) matrix = stack.pop() || [1, 0, 0, 1, 0, 0]
        else if (op === tools.OPS.transform) matrix = multiply(matrix, arg)
        else if (op === tools.OPS.paintImageXObject) {
          const points = [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1]
          ].map(([x, y]) =>
            view.convertToViewportPoint(
              matrix[0] * x + matrix[2] * y + matrix[4],
              matrix[1] * x + matrix[3] * y + matrix[5]
            )
          )
          boxes.set(arg[0], [
            Math.max(0, Math.min(...points.map((p) => p[0])) / view.width),
            Math.max(0, Math.min(...points.map((p) => p[1])) / view.height),
            Math.min(1, Math.max(...points.map((p) => p[0])) / view.width),
            Math.min(1, Math.max(...points.map((p) => p[1])) / view.height)
          ])
        }
      }
      const coverage = Math.min(
          1,
          [...boxes.values()].reduce(
            (s, b) => s + Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]),
            0
          )
        ),
        text = elements.map((e) => e.text).join('\n')
      const left = elements.filter((e) => e.bbox![0] < 0.4),
        right = elements.filter((e) => e.bbox![0] > 0.5)
      const columns =
        left.length > 10 &&
        right.length > 10 &&
        left.some((l) => right.some((r) => Math.abs(l.bbox![1] - r.bbox![1]) < 0.015))
      const category = classifyPage({ text, imageCoverage: coverage, images: boxes.size, columns })
      result.type = category.type
      if (category.type === 'scan' || category.type === 'abnormal') {
        result.method = 'ocr'
        tools.progress?.({stage:'ocr',page:n,total:pdf.numPages})
        const observation = await tools.ocrPage(n), ocr=typeof observation==='string'?observation:observation.text
        result.elements = ocrElements(observation,n)
        result.rawText=typeof observation==='string'?observation:observation.raw
        if(typeof observation!=='string')result.ocrConfidence=observation.confidence
        if (!ocr.trim()) {
          result.status = 'failed'
          result.issues.push({
            code: 'empty-ocr',
            severity: 'error',
            reason: 'OCR未提取到正文，需要核对或重试'
          })
        }
        result.issues.push({
          code: 'ocr-review',
          severity: 'warning',
          reason: 'OCR文字、数字及方向需要对照原页核对；尚未自动校正扫描倾斜'
        })
      } else {
        result.elements = elements
        if (category.type === 'blank') result.status = 'blank'
        if (category.type === 'complex')
          result.issues.push({
            code: 'layout-review',
            severity: 'warning',
            reason: category.reason
          })
        if (boxes.size && category.type !== 'blank') {
          result.method = 'native+image-ocr'
          const images = await tools.extractImages(n)
          let done = 0
          for (const image of images) {
            const bbox = boxes.get(image.key),
              area = bbox ? Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]) : 1
            if (area < 0.01) continue
            if (done++ >= 6) {
              result.issues.push({
                code: 'image-limit',
                severity: 'warning',
                reason: '本页含超过6张候选信息图片，其余需人工复核'
              })
              break
            }
            try {
              const observation = await tools.ocrImage(image), ocr=typeof observation==='string'?observation:observation.text,
                normalized = ocr.replace(/\s/g, '')
              if (normalized.length > 2 && !text.replace(/\s/g, '').includes(normalized)){
                for(const element of ocrElements(observation,n))result.elements.push({...element,id:`p${n}-image-${done}-${element.id}`,type:'image-text',bbox:bbox&&element.bbox?[bbox[0]+element.bbox[0]*(bbox[2]-bbox[0]),bbox[1]+element.bbox[1]*(bbox[3]-bbox[1]),bbox[0]+element.bbox[2]*(bbox[2]-bbox[0]),bbox[1]+element.bbox[3]*(bbox[3]-bbox[1])]:bbox})
              }
            } catch {
              result.issues.push({
                code: 'image-ocr-failed',
                severity: 'warning',
                reason: '图片识别失败，原图仍在PDF中，请核对原页'
              })
            }
          }
          if (images.length < boxes.size)
            result.issues.push({
              code: 'image-unresolved',
              severity: 'warning',
              reason: '部分图片未能独立提取，请核对原页'
            })
        }
      }
      if (result.method === 'native+image-ocr' || columns) {
        result.elements = orderElements(result.elements, columns)
        if (columns)
          result.issues.push({
            code: 'column-order',
            severity: 'warning',
            reason: '已按坐标生成先左后右的双栏候选顺序；跨栏标题、表格和复杂图文仍须对照原件核对'
          })
      }
      page.cleanup?.()
    } catch (error) {
      result.status = 'failed'
      result.issues.push({
        code: 'page-failed',
        severity: 'error',
        reason: String((error as Error).message || error)
      })
    }
  }
  tools.progress?.({stage:'cleaning',page:pdf.numPages,total:pdf.numPages})
  return cleanPages(pages)
}
