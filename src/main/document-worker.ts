import type { OCRObservation, ParseProgress } from '../shared/document-processing'
import { ocrElements, sourceBox } from './document-processing/ocr-result'
import { wordMarkdown } from './library-v4/office-markdown'
import { analyzePdf } from './document-processing/pdf-analysis'
import { cleanPages } from './document-processing/quality'
import { createHash } from 'node:crypto'
/** Standalone bounded parser process. Never serves HTTP or invokes cloud OCR. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { readOffice } from './document-office'
import { extractPdfPages } from './document-pdf'
import { createWorker } from 'tesseract.js'
import { imageSize } from 'image-size'
import { createCanvas, loadImage } from '@napi-rs/canvas'
let worker: Awaited<ReturnType<typeof createWorker>> | undefined
const MAX_PIXELS = 20_000_000
const transformLog: any[] = []
const detailedMode = process.argv[4] === 'analysis'
let lastOCR: OCRObservation | undefined
let progressState:ParseProgress={stage:'checking',page:0,total:0},lastProgressAt=0
function emitProgress(value:ParseProgress,force=false){
  if(!detailedMode)return
  const changed=value.stage!==progressState.stage||value.page!==progressState.page||value.total!==progressState.total
  progressState=value
  if(force||changed||Date.now()-lastProgressAt>700){process.stderr.write(JSON.stringify({shipingProgress:true,...value})+'\n');lastProgressAt=Date.now()}
}
function rotatedCanvas(canvas:any,angle:number,scale=1){
  const w=angle===90||angle===270?canvas.height:canvas.width,h=angle===90||angle===270?canvas.width:canvas.height,
    output=createCanvas(Math.max(1,Math.round(w*scale)),Math.max(1,Math.round(h*scale))),ctx=output.getContext('2d')
  ctx.fillStyle='#fff';ctx.fillRect(0,0,output.width,output.height);ctx.translate(output.width/2,output.height/2);ctx.rotate(angle*Math.PI/180);ctx.scale(scale,scale);ctx.drawImage(canvas,-canvas.width/2,-canvas.height/2)
  return output
}
async function recognize(buffer:Buffer):Promise<string>{return (await recognizeObservation(buffer)).text.replace(/(?<=[\u3400-\u9fff])[ \t]+(?=[\u3400-\u9fff])/g,'')}
async function recognizeObservation(buffer:Buffer):Promise<OCRObservation>{
  const dimensions=imageSize(buffer)
  if(!dimensions.width||!dimensions.height||dimensions.width*dimensions.height>MAX_PIXELS||dimensions.width>16000||dimensions.height>16000)throw Error('图片像素超过上限（2000万像素），请缩小后重试')
  const image=await loadImage(buffer)
  if(image.width*image.height>MAX_PIXELS)throw Error('图片像素超过上限')
  const canvas=createCanvas(image.width,image.height),ctx=canvas.getContext('2d')
  ctx.fillStyle='#fff';ctx.fillRect(0,0,image.width,image.height);ctx.drawImage(image,0,0)
  if(!worker){
    const langPath=process.env.SHIPING_OCR_DATA
    if(!langPath||!['eng','chi_sim'].every(l=>existsSync(join(langPath,`${l}.traineddata.gz`))))throw Error('本地 OCR 语言资源未安装，请运行 npm run setup:ocr')
    worker=await createWorker(['chi_sim','eng'],1,{langPath,gzip:true,cacheMethod:'none',workerPath:require.resolve('tesseract.js/src/worker-script/node/index.js'),errorHandler:()=>{},logger:m=>{if(detailedMode&&m.status==='recognizing text')emitProgress({...progressState,stage:'ocr',fraction:m.progress})}})
  }
  let result=await worker.recognize(canvas.toBuffer('image/png'),{},{blocks:detailedMode}),rotation=0
  if(detailedMode && (result.data.confidence<65 || result.data.text.replace(/\s/g,'').length<3)){
    let best={angle:0,confidence:result.data.confidence}
    for(const angle of [90,180,270]){
      const sample=rotatedCanvas(canvas,angle,Math.min(1,1600/Math.max(canvas.width,canvas.height))),trial=await worker.recognize(sample.toBuffer('image/png'))
      if(trial.data.confidence>best.confidence+10&&trial.data.text.replace(/\s/g,'').length>2)best={angle,confidence:trial.data.confidence}
    }
    if(best.angle){rotation=best.angle;result=await worker.recognize(rotatedCanvas(canvas,rotation).toBuffer('image/png'),{},{blocks:true})}
  }
  const lines=(result.data.blocks||[]).flatMap(block=>block.paragraphs.flatMap(paragraph=>paragraph.lines)).map(line=>({text:line.text,confidence:line.confidence,bbox:sourceBox([line.bbox.x0,line.bbox.y0,line.bbox.x1,line.bbox.y1],rotation,canvas.width,canvas.height)}))
  lastOCR={raw:result.data.text,text:result.data.text,confidence:result.data.confidence,rotation,lines}
  if(detailedMode)transformLog.push({rotation,confidence:result.data.confidence,confidenceKind:'tesseract-engine',inputWidth:canvas.width,inputHeight:canvas.height,lineCount:lines.length,lowConfidenceLines:lines.filter(l=>l.confidence<45&&l.text.trim().length>2).length,note:'实际OCR置信度不是正确率；原始文字与行位置保留供核对'})
  return lastOCR
}
async function run() {
  const file = process.argv[2],
    ext = process.argv[3]
  emitProgress({stage:'checking',page:0,total:0},true)
  const buffer = await readFile(file)
  let text: string
  let analysis: any
  const detailed = process.argv[4] === 'analysis'
  let password: string | undefined
  if (detailed) {
    const input = readFileSync(0, 'utf8')
    if (input.length > 4096) throw Error('解析选项超限')
    if (input) {
      const options = JSON.parse(input)
      if (
        options.password !== undefined &&
        (typeof options.password !== 'string' || options.password.length > 256)
      )
        throw Error('密码格式无效')
      password = options.password
    }
  }
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) text = await recognize(buffer)
  else if (ext === 'xlsx' || ext === 'pptx')
    text = await readOffice(buffer, ext, recognize, detailed)
  else if (ext === 'docx') {
    text = detailed
      ? await wordMarkdown(buffer, recognize)
      : (await (await import('mammoth')).default.extractRawText({ buffer })).value
  } else if (['txt', 'md', 'markdown'].includes(ext)) {
    const { decodeText } = await import('./knowledge-parse')
    text = decodeText(buffer)
  } else {
    const { getDocumentProxy, createIsomorphicCanvasFactory, renderPageAsImage } = await import(
      'unpdf'
    )
    const canvasImport = () => import('@napi-rs/canvas')
    const CanvasFactory = await createIsomorphicCanvasFactory(canvasImport)
    const pdf: any = await getDocumentProxy(new Uint8Array(buffer), {
      CanvasFactory,
      password,
      isEvalSupported: false
    } as any)
    try {
      if (detailed) {
        const { extractImages, getResolvedPDFJS } = await import('unpdf')
        const { OPS } = await getResolvedPDFJS()
        analysis = await analyzePdf(pdf, {
          OPS,
          progress: p=>emitProgress(p,true),
          extractImages: (n) => extractImages(pdf, n),
          ocrPage: async (n) => {
            const page = await pdf.getPage(n),
              v = page.getViewport({ scale: 2 })
            if (v.width * v.height > MAX_PIXELS) throw Error('PDF页面像素超限')
            return recognizeObservation(
              Buffer.from(await renderPageAsImage(pdf, n, { canvasImport, scale: 2 }))
            )
          },
          ocrImage: async (image) => {
            if (image.width * image.height > MAX_PIXELS) throw Error('图片像素超限')
            const c = createCanvas(image.width, image.height),
              ctx = c.getContext('2d'),
              data = ctx.createImageData(image.width, image.height)
            for (let i = 0; i < image.width * image.height; i++) {
              const start = i * image.channels
              data.data[i * 4] = image.data[start]
              data.data[i * 4 + 1] = image.data[start + (image.channels === 1 ? 0 : 1)]
              data.data[i * 4 + 2] = image.data[start + (image.channels === 1 ? 0 : 2)]
              data.data[i * 4 + 3] = image.channels === 4 ? image.data[start + 3] : 255
            }
            ctx.putImageData(data, 0, 0)
            return recognizeObservation(c.toBuffer('image/png'))
          }
        })
        text = analysis.cleaned
      } else {
        text = await extractPdfPages(pdf, async (n) => {
          const page = await pdf.getPage(n),
            view = page.getViewport({ scale: 2 })
          if (view.width * view.height > MAX_PIXELS) throw Error('PDF 页面像素超过上限，请缩小页面')
          const png = await renderPageAsImage(pdf, n, { canvasImport, scale: 2 })
          return recognize(Buffer.from(png))
        })
      }
    } finally {
      await pdf.loadingTask.destroy()
    }
  }
  if (!text.replace(/^#{1,3} .*$/gm, '').trim())
    throw Error('没有提取到文字，请检查图片清晰度或文档内容')
  if (text.length > 2_000_000) throw Error('提取正文超过200万字符，请拆分文件')
  if (detailed && !analysis) {
    analysis = cleanPages([
      {
        number: 1,
        type: ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? 'scan' : 'text',
        method: ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? 'ocr' : 'native',
        status: 'complete',
        ...(lastOCR && ['png','jpg','jpeg','webp'].includes(ext)?{rawText:lastOCR.raw,ocrConfidence:lastOCR.confidence}:{}),
        elements: lastOCR && ['png','jpg','jpeg','webp'].includes(ext)?ocrElements(lastOCR,1):[{ id: 'document-text', type: 'paragraph', text }],
        issues: [
          {
            code: 'non-pdf-locator',
            severity: 'warning',
            reason: '非PDF资料以原文工作表/幻灯片/段落位置为准，不将编号当作PDF页码'
          }
        ]
      }
    ])
  }
  if (analysis) {
    if (/\[需复核：|公式无缓存值/.test(text)) {
      const issue = {
        code: 'office-layout-review',
        severity: 'warning' as const,
        reason: 'Office结构或公式缓存不完整，请对照原件核对'
      }
      analysis.pages[0].issues.push(issue)
      analysis.issues.push(issue)
    }
    if(['docx','pptx','xlsx'].includes(ext)&&transformLog.some(t=>t.lowConfidenceLines>0)){
      const issue={code:'ocr-quality-review',severity:'warning',reason:'内嵌图片存在低置信度OCR行，请对照原件核对'};analysis.pages[0].issues.push(issue);analysis.issues.push(issue)
    }
    analysis.imageTransforms = transformLog
    analysis.sourceHash = createHash('sha256').update(buffer).digest('hex')
  }
  emitProgress({stage:'completed',page:analysis?.totalPages||1,total:analysis?.totalPages||1},true)
  process.stdout.write(JSON.stringify({ text, ...(analysis ? { analysis } : {}) }))
}
run()
  .catch((error) => {
    process.stdout.write(
      JSON.stringify({
        error:
          error?.name === 'PasswordException'
            ? 'PDF 有密码保护或密码错误，请在任务重试时输入正确密码，或先解密后导入'
            : String(error?.message || error)
      })
    )
    process.exitCode = 1
  })
  .finally(async () => {
    await worker?.terminate()
  })
