// A minimal 外部知识库 for 识屏: Dify's External Knowledge API over a folder of
// Markdown / TXT files, ranked by plain keyword overlap. No dependencies,
// Node 20+. Meant as a starting point and for trying the setting out; a real
// service would put embeddings and a reranker behind the same endpoint.
//
//   DOCS=./my-notes API_KEY=secret node server.mjs
//
// Then in 识屏: 设置 → 资料库 → 外部知识库, 接口地址 http://127.0.0.1:8000
import { createServer } from 'node:http'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

const DOCS = process.env.DOCS || '.'
const PORT = Number(process.env.PORT || 8000)
const API_KEY = process.env.API_KEY || ''
const CHUNK_CHARS = 600

/** Every .md / .txt under `dir`, cut at headings and into paragraphs of about CHUNK_CHARS */
function loadChunks(dir) {
  const chunks = []
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      if (name.startsWith('.') || name === 'node_modules') continue
      const full = join(path, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (['.md', '.markdown', '.txt'].includes(extname(name).toLowerCase())) {
        let current = ''
        const flush = () => {
          if (current.trim()) chunks.push({ title: relative(dir, full), content: current.trim() })
          current = ''
        }
        for (const paragraph of readFileSync(full, 'utf8').split(/\n\s*\n/)) {
          // A heading starts a new passage, so one topic never trails into the next
          if (/^#{1,6}\s/.test(paragraph) || current.length + paragraph.length > CHUNK_CHARS) {
            flush()
          }
          current += `${paragraph}\n\n`
        }
        flush()
      }
    }
  }
  walk(dir)
  return chunks
}

/** Latin words and Chinese character pairs: crude, but needs no tokenizer */
function terms(text) {
  const lower = text.toLowerCase()
  const words = lower.match(/[a-z0-9_]{2,}/g) ?? []
  const han = lower.match(/[一-鿿]+/g) ?? []
  const pairs = han.flatMap((run) =>
    run.length === 1 ? [run] : [...run].slice(1).map((c, i) => run[i] + c)
  )
  return new Set([...words, ...pairs])
}

const chunks = loadChunks(DOCS).map((chunk) => ({ ...chunk, terms: terms(chunk.content) }))
console.log(`已载入 ${chunks.length} 段资料（${DOCS}）`)

function search(query, topK, threshold) {
  const wanted = terms(query)
  if (wanted.size === 0) return []
  return chunks
    .map((chunk) => {
      let hits = 0
      for (const term of wanted) if (chunk.terms.has(term)) hits++
      return { chunk, score: hits / wanted.size }
    })
    .filter((r) => r.score > 0 && r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ chunk, score }) => ({
      content: chunk.content,
      score: Number(score.toFixed(3)),
      title: chunk.title,
      metadata: {}
    }))
}

const send = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.startsWith('/retrieval')) {
    return send(res, 404, { error_code: 404, error_msg: 'not found' })
  }
  if (API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) {
    return send(res, 403, { error_code: 1002, error_msg: 'authorization failed' })
  }
  let body = ''
  req.on('data', (part) => (body += part))
  req.on('end', () => {
    try {
      const { query, retrieval_setting: setting = {} } = JSON.parse(body)
      if (typeof query !== 'string') throw new Error('query is required')
      const records = search(query, setting.top_k ?? 5, setting.score_threshold ?? 0)
      send(res, 200, { records })
    } catch (error) {
      send(res, 400, { error_code: 400, error_msg: String(error.message || error) })
    }
  })
}).listen(PORT, '127.0.0.1', () => console.log(`http://127.0.0.1:${PORT}/retrieval`))
