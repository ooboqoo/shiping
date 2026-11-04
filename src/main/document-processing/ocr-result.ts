import type { Element, OCRObservation } from '../../shared/document-processing'
/** Retain actual measured lines; missing confidence/geometry must not be fabricated. */
export function ocrElements(value: string | OCRObservation, page: number): Element[] {
  const lines = typeof value === 'string' ? [{text:value}] : value.lines?.length ? value.lines : [{text:value.text,confidence:value.confidence}]
  return lines.filter(line=>line.text.trim()).map((line,i)=>({
    id:`p${page}-ocr-${i+1}`,type:'paragraph',text:line.text,rawText:line.text,method:'ocr',
    ...(Number.isFinite(line.confidence)?{confidence:line.confidence}:{}),
    ...('bbox' in line && Array.isArray(line.bbox) && line.bbox.length===4 && line.bbox.every(n=>Number.isFinite(n)&&n>=0&&n<=1)?{bbox:line.bbox}: {})
  }))
}
/** Invert the measured OCR rotation into the original rendered page coordinate space. */
export function sourceBox(box:number[],angle:number,width:number,height:number):number[] {
  const [x0,y0,x1,y1]=box,
    points=[[x0,y0],[x1,y0],[x0,y1],[x1,y1]].map(([x,y])=>angle===90?[y,height-x]:angle===180?[width-x,height-y]:angle===270?[width-y,x]:[x,y])
  return [Math.min(...points.map(p=>p[0]))/width,Math.min(...points.map(p=>p[1]))/height,Math.max(...points.map(p=>p[0]))/width,Math.max(...points.map(p=>p[1]))/height].map(n=>Math.max(0,Math.min(1,n)))
}
