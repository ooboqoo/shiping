const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  { spawn } = require('node:child_process')
const enabled = process.env.SHIPING_TEST_OCR === '1'
const root = path.resolve(__dirname, '..')
async function parse(data, ext, assets = path.join(root, 'resources/ocr'), detailed = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shiping-real-test-')),
    file = path.join(dir, 'input.' + ext)
  try {
    await fs.writeFile(file, data)
    return await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.join(root, 'out/main/document-worker.cjs'), file, ext, ...(detailed?['analysis']:[])],
        { env: { ...process.env, SHIPING_OCR_DATA: assets }, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let output = ''
      child.stdout.on('data', (c) => (output += c))
      child.stderr.on('data', () => {})
      const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
      child.on('error', reject)
      child.on('close', (code) => {
        clearTimeout(timer)
        try {
          const result = JSON.parse(output)
          if (code || result.error) reject(Error(result.error || 'worker failed'))
          else resolve(detailed?result.analysis:result.text)
        } catch (e) {
          reject(e)
        }
      })
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}
function picture() {
  const { createCanvas } = require('@napi-rs/canvas'),
    c = createCanvas(1500, 300),
    ctx = c.getContext('2d')
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.fillStyle = 'black'
  ctx.font = '58px "Hiragino Sans GB"'
  ctx.fillText('本地知识库测试：青松 731', 40, 110)
  ctx.font = '52px Arial'
  ctx.fillText('Shiping local OCR code 8642', 40, 210)
  return c
}
function pdfWithImage(jpeg,native='') {
 const command='q 750 0 0 150 0 0 cm /Im0 Do Q'+(native?'\nBT /F1 10 Tf 20 15 Td ('+native+') Tj ET':'')
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 750 150] /Resources << /Font << /F1 8 0 R >> /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'
    ),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 1500 /Height 300 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
      ),
      jpeg,
      Buffer.from('\nendstream')
    ]),
    Buffer.from(`<< /Length ${Buffer.byteLength(command)} >>\nstream\n${command}\nendstream`),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 750 150] /Resources << /Font << /F1 8 0 R >> >> /Contents 7 0 R >>'
    ),
    Buffer.from(
      '<< /Length 52 >>\nstream\nBT /F1 24 Tf 30 70 Td (Embedded code 9753) Tj ET\nendstream'
    ),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  ]
  let parts = [Buffer.from('%PDF-1.4\n')],
    offsets = [0],
    size = parts[0].length
  objects.forEach((o, i) => {
    offsets.push(size)
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')])
    parts.push(b)
    size += b.length
  })
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
        .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF`
    )
  )
  return Buffer.concat(parts)
}
test(
  'offline real image OCR reads Chinese and English; missing assets fails clearly',
  { skip: !enabled },
  async () => {
    const b = picture().toBuffer('image/png'),
      text = await parse(b, 'png')
    assert.match(text, /731/)
    assert.match(text, /8642/)
    assert.match(text, /知识库/)
    await assert.rejects(parse(b, 'png', '/nonexistent/shiping-ocr-assets'), /语言资源未安装/)
  }
)
test('real mixed PDF OCR preserves image and embedded text pages', { skip: !enabled }, async () => {
  const text = await parse(pdfWithImage(picture().toBuffer('image/jpeg')), 'pdf')
  assert.match(text, /8642/)
  assert.match(text, /9753/)
  assert.ok(text.indexOf('8642') < text.indexOf('9753'))
})
test('real PPTX image OCR and notes are both parsed offline', { skip: !enabled }, async () => {
  const zip = new (require('jszip'))()
  const entries = {
    'ppt/presentation.xml':
      '<p:presentation><p:sldIdLst><p:sldId r:id="s"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels':
      '<Relationships><Relationship Id="s" Target="slides/slide1.xml"/></Relationships>',
    'ppt/slides/slide1.xml':
      '<p:sld><a:p><a:r><a:t>Slide code 5551</a:t></a:r></a:p><a:blip r:embed="im"/></p:sld>',
    'ppt/slides/_rels/slide1.xml.rels':
      '<Relationships><Relationship Id="im" Type="image" Target="../media/test.png"/></Relationships>',
    'ppt/media/test.png': picture().toBuffer('image/png')
  }
  for (const [n, v] of Object.entries(entries)) zip.file(n, v)
  const text = await parse(await zip.generateAsync({ type: 'nodebuffer' }), 'pptx')
  assert.match(text, /5551/)
  assert.match(text, /8642/)
})

test('structured PDF analysis OCRs a scan even when it has a small text watermark',{skip:!enabled},async()=>{
 const report=await parse(pdfWithImage(picture().toBuffer('image/jpeg'),'Page 1'),'pdf',path.join(root,'resources/ocr'),true)
 assert.equal(report.totalPages,2);assert.equal(report.pages[0].type,'scan');assert.match(report.cleaned,/8642/);assert.match(report.cleaned,/9753/);assert.ok(report.complete);assert.ok(report.sources.length);assert.ok(report.pages[0].elements.length>=2);assert.ok(report.pages[0].elements.some(e=>typeof e.confidence==='number'));assert.ok(report.pages[0].rawText)
})
test('structured mixed page preserves native text and OCRs embedded image text',{skip:!enabled},async()=>{
 const native='Original native paragraph fact 5559 '+ 'complete document text '.repeat(8)
 const report=await parse(pdfWithImage(picture().toBuffer('image/jpeg'),native),'pdf',path.join(root,'resources/ocr'),true)
 assert.equal(report.pages[0].type,'mixed');assert.match(report.cleaned,/5559/);assert.match(report.cleaned,/8642/)
})
