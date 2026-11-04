const test = require('node:test'),
  assert = require('node:assert/strict'),
  load = require('./load-source.cjs')
const { chunkDocument, embeddingText } = load('src/main/rag/chunks.ts')
test('heading paths are carried into embeddings without crossing sibling sections', () => {
  const text = '# 课程\n\n## MCP\n\n爬爬老师：\nhttps://example.org/mcp\n\n## Redis\n\n缓存知识。'
  const cs = chunkDocument('d', text)
  assert.ok(cs.some((c) => c.section === '课程 > MCP'))
  assert.ok(cs.some((c) => c.section === '课程 > Redis'))
  for (const c of cs) {
    assert.equal(c.text, text.slice(c.start, c.end))
    assert.ok(!(c.text.includes('爬爬') && c.text.includes('缓存知识')))
  }
  const c = cs.find((c) => c.text.includes('爬爬'))
  assert.ok(c.text.includes('https://example.org/mcp'))
  assert.ok(embeddingText(c).includes('课程 > MCP'))
})
test('fenced code headings do not become document sections; modest tables stay intact', () => {
  const table = '| 参数 | 说明 |\n| --- | --- |\n| top_k | 返回条数 |'
  const code = '```python\n# fake heading\nprint("hello")\n```'
  const cs = chunkDocument('d', '# API\n\n' + table + '\n\n' + code + '\n\n# 下一节\n\n正文')
  assert.ok(cs.some((c) => c.text.includes(table)))
  assert.ok(cs.some((c) => c.text.includes(code)))
  assert.ok(cs.every((c) => !c.section?.includes('fake')))
})
test('long text is covered and split safely without fixed overlap requirement', () => {
  const text = '# 说明\n\n' + '项目介绍和设计细节。'.repeat(400)
  const cs = chunkDocument('d', text)
  assert.ok(cs.length > 2)
  let covered = 0
  for (const c of cs) {
    assert.ok(c.text.length <= 1200)
    assert.ok(c.start <= covered)
    assert.equal(c.text, text.slice(c.start, c.end))
    covered = Math.max(covered, c.end)
  }
  assert.equal(covered, text.length)
})
test('Markdown URL remains intact at a nominal window boundary', () => {
  const url = 'https://example.org/' + 'a'.repeat(100)
  const text = '# 资料\n\n' + '背景描述。'.repeat(105) + '爬爬老师课程：[完整链接](' + url + ')。'
  const cs = chunkDocument('d', text)
  assert.ok(cs.some((c) => c.text.includes('[完整链接](' + url + ')')))
})
test('numbered chapters supply paths; repeated headings have distinct offset IDs', () => {
  const cs = chunkDocument(
    'd',
    '6.6 MCP的参考资料\n\n内容一\n\n6.7 Agent的记忆功能\n\n内容二\n\n6.7 Agent的记忆功能\n\n内容三'
  )
  assert.ok(cs.some((c) => c.section?.includes('6.6 MCP的参考资料')))
  assert.equal(new Set(cs.map((c) => c.id)).size, cs.length)
})
test('chunk IDs and fingerprint are versioned for structural embeddings', () => {
  const c = chunkDocument('d', '正文')[0]
  assert.ok(c.id.includes('structure-v2'))
  assert.ok(c.id.endsWith(':0:2'))
})
test('a fence-looking line with a language suffix does not close an outer code block', () => {
  const code = '```text\n```python\n# not a section\n```'
  const cs = chunkDocument('d', '# 文档\n\n' + code + '\n\n# 正文\n\n结束')
  assert.ok(cs.some((c) => c.text.includes(code)))
  assert.ok(cs.every((c) => !c.section?.includes('not a section')))
})
test('overlapping URL and inline-code protections always terminate', () => {
  const path = require('node:path'),
    cp = require('node:child_process')
  const text = '`https://example.org/' + 'a'.repeat(650) + '`suffix ' + 'x'.repeat(1000)
  const script = `const core=require(${JSON.stringify(path.join(__dirname, 'load-source.cjs'))})('src/main/rag/chunks.ts');const cs=core.chunkDocument('d',${JSON.stringify(text)});if(!cs.length||cs.some(c=>c.text.length>1200))process.exit(2)`
  const p = cp.spawnSync(process.execPath, ['-e', script], { timeout: 2000, encoding: 'utf8' })
  assert.equal(p.status, 0, p.error?.message || p.stderr)
})
test('an indivisible oversized URL reports an actionable error', () => {
  assert.throws(() => chunkDocument('d', 'https://example.org/' + 'a'.repeat(1400)), /1200/)
})
test('four-space pseudo fences do not split a code block', () => {
  const code = '```text\n' + 'a'.repeat(350) + '\n    ```\n' + 'b'.repeat(500) + '\n```\n'
  assert.ok(chunkDocument('d', code).some((c) => c.text.includes(code)))
})
test('balanced parentheses inside Markdown URLs remain indivisible', () => {
  const link = '[维基](https://example.org/wiki/Test_(abc)/' + 'a'.repeat(700) + ')'
  assert.ok(chunkDocument('d', link + 'x'.repeat(900)).some((c) => c.text.includes(link)))
})
test('technical heading names retain meaningful trailing hashes', () => {
  assert.equal(chunkDocument('d', '# C#\n\n语言说明')[0].section, 'C#')
})
