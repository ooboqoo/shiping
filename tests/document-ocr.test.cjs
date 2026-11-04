const test = require('node:test'),
  assert = require('node:assert/strict'),
  load = require('./load-source.cjs')
test('PDF fallback only recognizes pages with no useful embedded text, preserving order', async () => {
  const { extractPdfPages } = load('src/main/document-pdf.ts')
  let recognized = []
  const text = await extractPdfPages(
    {
      numPages: 3,
      getPage: async (n) => ({
        getTextContent: async () => ({ items: n === 2 ? [] : [{ str: '原文' + n }] })
      })
    },
    async (n) => {
      recognized.push(n)
      return '扫描事实731'
    }
  )
  assert.deepEqual(recognized, [2])
  assert.match(text, /第 2 页.*OCR/s)
  assert.ok(text.indexOf('原文1') < text.indexOf('扫描事实731'))
  assert.ok(text.indexOf('扫描事实731') < text.indexOf('原文3'))
})
test('PDF page limit is rejected before rendering', async () => {
  const { extractPdfPages } = load('src/main/document-pdf.ts')
  await assert.rejects(
    extractPdfPages({ numPages: 151 }, async () => ''),
    /150/
  )
})
