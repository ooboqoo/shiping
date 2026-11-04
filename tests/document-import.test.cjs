const test = require('node:test'),
  assert = require('node:assert/strict')
const JSZip = require('jszip'),
  load = require('./load-source.cjs')
async function zip(files) {
  const z = new JSZip()
  for (const [n, v] of Object.entries(files)) z.file(n, v)
  return z.generateAsync({ type: 'nodebuffer' })
}
const office = () => load('src/main/document-office.ts')
test('XLSX preserves sheet names, row/cell coordinates and cached values without evaluating formulas', async () => {
  const b = await zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="课程" r:id="r1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>代号</t></si><si><t xml:space="preserve">青松731</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="3"><c r="A3"><f>1+2</f><v>3</v></c><c r="B3"><f>NOW()</f></c></row></sheetData></worksheet>'
  })
  const text = await office().readOffice(b, 'xlsx', async () => {
    throw Error('not image')
  })
  assert.match(text, /课程/)
  assert.match(text, /B1.*青松731/)
  assert.match(text, /A3.*3/)
  assert.match(text, /B3.*无缓存/)
  assert.doesNotMatch(text, /NOW/)
})
test('PPTX follows presentation order and reads notes and local embedded images', async () => {
  const b = await zip({
    'ppt/presentation.xml':
      '<p:presentation><p:sldIdLst><p:sldId r:id="b"/><p:sldId r:id="a"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels':
      '<Relationships><Relationship Id="a" Target="slides/slide1.xml"/><Relationship Id="b" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>最后</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide2.xml':
      '<p:sld><a:p><a:r><a:t>起点</a:t></a:r></a:p><a:blip r:embed="im"/></p:sld>',
    'ppt/slides/_rels/slide2.xml.rels':
      '<Relationships><Relationship Id="im" Type="image" Target="../media/image1.png"/><Relationship Id="n" Type="notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
    'ppt/notesSlides/notesSlide1.xml':
      '<p:notes><a:p><a:r><a:t>备注内容</a:t></a:r></a:p></p:notes>',
    'ppt/media/image1.png': Buffer.from('image')
  })
  const text = await office().readOffice(b, 'pptx', async (data) => {
    assert.equal(data.toString(), 'image')
    return '图中事实731'
  })
  assert.ok(text.indexOf('起点') < text.indexOf('最后'))
  assert.match(text, /备注内容/)
  assert.match(text, /图中事实731/)
})
test('Office rejects corrupt archives, DTD and oversized expanded data', async () => {
  await assert.rejects(
    office().readOffice(Buffer.from('bad'), 'xlsx', async () => ''),
    /ZIP|压缩|文档/
  )
  const b = await zip({ 'xl/workbook.xml': '<!DOCTYPE x [<!ENTITY a "bad">]><workbook/>' })
  await assert.rejects(
    office().readOffice(b, 'xlsx', async () => ''),
    /DTD|实体/
  )
  const large = await zip({ 'xl/workbook.xml': 'x'.repeat(6 * 1024 * 1024) })
  await assert.rejects(
    office().readOffice(large, 'xlsx', async () => ''),
    /大小|上限/
  )
})
test('new file formats are accepted consistently, old binary Office remains unsupported', () => {
  const { KNOWLEDGE_EXTENSIONS: e } = load('src/shared/knowledge.ts')
  for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'xlsx', 'pptx']) assert.ok(e.includes(ext), ext)
  assert.ok(!e.includes('xls'))
  assert.ok(!e.includes('ppt'))
})
