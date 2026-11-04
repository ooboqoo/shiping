import { existsSync, readFileSync } from 'node:fs'
import { writeFile, rename, unlink } from 'node:fs/promises'
import { LibraryService } from '../src/main/library-v4/service'
import { handleV4, rpcV4 } from './v4-api'
import { handleChat } from './chat-api'
import { ProcessingJobs } from '../src/main/document-processing/jobs'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve, extname, basename } from 'node:path'
import {
  Store,
  ApiError,
  decodeBase64,
  fileValue,
  MAX_BODY,
  MAX_TEXT,
  validId
} from './store'
import { Indexes, COLLECTIONS } from './vectors'
import { Bridge } from './bridge'
import { extractBufferText } from '../src/main/knowledge-parse'
import { request } from '../src/main/rag/client'
import {
  localHost,
  json,
  readJSON,
  errorResponse
} from '../src/main/rag/local-http'
import type { RagIndex } from '../src/main/rag/index'
type IO = ConstructorParameters<typeof RagIndex>[0]
interface Options {
  root: string
  libraryOptions?: ConstructorParameters<typeof LibraryService>[1]
  publicDir?: string
  bridgeFile?: string
  ioFactory?: (store: Store, id: string) => IO
}
function match(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
function attachment(
  res: ServerResponse,
  name: string,
  data: Buffer | string,
  type = 'application/octet-stream'
) {
  const safeName = encodeURIComponent(
    Buffer.from(name, 'utf8').toString('utf8')
  )
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${safeName}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  })
  res.end(data)
}
function pageNumber(value: string | null, fallback: number, max: number) {
  const n = value === null ? fallback : Number(value)
  if (!Number.isSafeInteger(n) || n < 0 || n > max)
    throw new ApiError(400, '分页参数无效')
  return n
}
export function createAdminServer(options: Options) {
  const marker = join(options.root, 'data/library/v4-active.json')
  if (
    existsSync(marker) &&
    (!existsSync(join(options.root, 'data/library/shiping.sqlite')) ||
      JSON.parse(readFileSync(marker, 'utf8')).version !== 1)
  )
    throw Error('新版资料库或配置缺失，请恢复备份，禁止创建空库')
  const v4 = existsSync(join(options.root, 'data/library/v4-active.json'))
    ? new LibraryService(
        join(options.root, 'data/library'),
        options.libraryOptions
      )
    : undefined
  if (v4 && !v4.catalog.projects().some((p: any) => p.id === 'shiping'))
    v4.catalog.project('shiping', '默认知识库')
  const processToken = randomBytes(32).toString('hex'),
    discovery = join(options.root, 'data/library/service.json')
  const store = new Store(join(options.root, 'data', 'admin'))
  const library = store.getLibrary(),
    processing =
      library && !v4
        ? new ProcessingJobs(
            library,
            join(options.root, 'data/library'),
            (project) => {
              if (project === 'shiping')
                void bridge.call('refresh', []).catch(() => {})
            }
          )
        : undefined
  const indexes = new Indexes(
    store,
    options.ioFactory ? (id) => options.ioFactory!(store, id) : undefined
  )
  const bridge = new Bridge(
    options.bridgeFile ??
      join(options.root, 'data', 'shiping-trial', 'rag', 'admin-bridge.json')
  )
  const session = randomBytes(32).toString('hex'),
    csrf = randomBytes(32).toString('hex')
  const publicDir = options.publicDir ?? join(options.root, 'web', 'public')
  async function object(req: IncomingMessage) {
    const value = await readJSON(req, MAX_BODY)
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new ApiError(400, '请求需要JSON对象')
    return value
  }
  function adapter(id: string) {
    if (id === 'shiping')
      return {
        list: (o: unknown) => bridge.call('list', [o]),
        get: (doc: string) => bridge.call('get', [doc]),
        create: (v: unknown) => bridge.call('create', [v]),
        update: (doc: string, v: unknown) => bridge.call('update', [doc, v]),
        trash: (doc: string, v: unknown) => bridge.call('trash', [doc, v]),
        restore: (doc: string, v: unknown) => bridge.call('restore', [doc, v]),
        importFile: (v: unknown) => bridge.call('importFile', [v]),
        chunks: (doc: string, o: number, l: number) =>
          bridge.call('chunks', [doc, o, l]),
        original: async (doc: string) => {
          const r = await bridge.call('original', [doc])
          return { name: r.name, data: Buffer.from(r.base64, 'base64') }
        },
        status: () => bridge.call('status'),
        rebuild: () => bridge.call('rebuild'),
        search: (q: unknown, mode: unknown) => bridge.call('search', [q, mode]),
        backup: () => bridge.call('backup'),
        importBackup: (v: unknown) => bridge.call('importBackup', [v])
      }
    validId(id)
    async function changed<T>(fn: () => Promise<T>) {
      const result = await fn()
      await indexes.rebuild(id)
      return result
    }
    return {
      list: (o: any) => store.list(id, o),
      get: (doc: string) => store.get(id, doc),
      create: (v: any) =>
        changed(() =>
          store.create(id, {
            name: v.name,
            text: v.text,
            modes: v.modes,
            tags: v.tags
          })
        ),
      update: (doc: string, v: any) => changed(() => store.update(id, doc, v)),
      trash: (doc: string, v: unknown) =>
        changed(() => store.trash(id, doc, v)),
      restore: (doc: string, v: unknown) =>
        changed(() => store.restore(id, doc, v)),
      async importFile(v: any) {
        const data = decodeBase64(v.base64),
          name = fileValue(v.name, data),
          text = await extractBufferText(data, extname(name), MAX_TEXT)
        return changed(() =>
          store.create(id, {
            name: basename(name, extname(name)).slice(0, 80),
            text,
            original: { name, data }
          })
        )
      },
      chunks: (doc: string, o: number, l: number) =>
        indexes.chunks(id, doc, o, l),
      original: (doc: string) => store.original(id, doc),
      status: () => indexes.status(id),
      rebuild: () => indexes.rebuild(id, true),
      search: (q: unknown, mode: unknown) => indexes.search(id, q, mode),
      backup: () => store.backup(id),
      importBackup: (v: any) => changed(() => store.importBackup(id, v))
    }
  }
  const server = createServer((req, res) => {
    void (async () => {
      localHost(req)
      const origin = `http://127.0.0.1:${req.socket.localPort}`
      if (
        (req.headers.origin && req.headers.origin !== origin) ||
        req.headers['sec-fetch-site'] === 'cross-site'
      )
        throw new ApiError(403, '不允许其他网站访问本机知识库')
      res.setHeader('X-Frame-Options', 'DENY')
      res.setHeader('Referrer-Policy', 'no-referrer')
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      )
      const url = new URL(req.url ?? '/', origin),
        pathname = url.pathname
      if (req.method === 'GET' && pathname === '/api/health') {
        if (v4) { json(res, 200, { admin: true, storage: { ready: true, type: 'sqlite-vectors' }, embedding: { configured: v4.providerStatus().embedding.configured }, shiping: { ready: true } }); return }
        const probe = async (u: string) => {
          try {
            const r = await fetch(u, { signal: AbortSignal.timeout(2000) })
            return r.ok ? await r.json() : null
          } catch {
            return null
          }
        }
        const [chroma, tags, desktop] = await Promise.all([
          probe('http://127.0.0.1:18000/api/v2/heartbeat'),
          probe('http://127.0.0.1:11435/api/tags'),
          v4
            ? Promise.resolve({ backend: true })
            : bridge.call('status', [], 2000).catch(() => null)
        ])
        json(res, 200, {
          admin: true,
          chroma: { ready: Boolean(chroma) },
          ollama: {
            ready: Boolean(tags),
            modelInstalled: Boolean(
              tags?.models?.some(
                (m: any) => m.name === 'bge-m3' || m.name === 'bge-m3:latest'
              )
            )
          },
          shiping: { ready: Boolean(desktop) }
        })
        return
      }
      if (req.method === 'GET' && pathname === '/api/session') {
        res.setHeader(
          'Set-Cookie',
          `rag_admin_session_${req.socket.localPort}=${session}; HttpOnly; SameSite=Strict; Path=/`
        )
        json(res, 200, { csrf, version: v4 ? 4 : 3 })
        return
      }
      if (!pathname.startsWith('/api/')) {
        if (
          req.method !== 'GET' ||
          ![
            '/',
            '/index.html',
            '/app.js',
            '/model-providers.js',
            '/ui-helpers.js',
            '/chat-ui.js',
            '/uploads-ui.js',
            '/document-purge-ui.js',
            '/style.css'
          ].includes(pathname)
        )
          throw new ApiError(404, '页面不存在')
        const file = pathname === '/' ? 'index.html' : pathname.slice(1)
        const content = await readFile(
          join(publicDir, v4 && file === 'app.js' ? 'app-v4.js' : file)
        )
        res.writeHead(200, {
          'Content-Type': file.endsWith('.js')
            ? 'text/javascript; charset=utf-8'
            : file.endsWith('.css')
              ? 'text/css; charset=utf-8'
              : 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store'
        })
        res.end(content)
        return
      }
      if (v4 && pathname === '/api/internal/rpc') {
        if (
          req.method !== 'POST' ||
          req.headers.origin ||
          !match(
            String(req.headers.authorization || ''),
            'Bearer ' + processToken
          )
        )
          throw new ApiError(401, '本机调用未授权')
        await rpcV4(v4, req, res)
        return
      }
      // Cookies are scoped by host/path, never by TCP port. Keep local services independent.
      const cookieName = `rag_admin_session_${req.socket.localPort}=`,
        cookies = (req.headers.cookie ?? '').split(';').map((s) => s.trim())
      const supplied =
        cookies
          .find((c) => c.startsWith(cookieName))
          ?.slice(cookieName.length) ?? ''
      if (!match(supplied, session)) {
        res.setHeader('X-Rag-Auth-Error', 'session')
        throw new ApiError(401, '页面会话已过期，请刷新网页')
      }
      if (!['GET', 'HEAD'].includes(req.method ?? '')) {
        if (req.headers.origin !== origin)
          throw new ApiError(403, '不允许其他网站访问本机知识库')
        if (!match(String(req.headers['x-rag-csrf'] ?? ''), csrf)) {
          res.setHeader('X-Rag-Auth-Error', 'csrf')
          throw new ApiError(403, '请求验证失败，请刷新网页')
        }
      }
      if (v4 && (await handleChat(v4, req, res, url))) return
      if (v4 && (await handleV4(v4, req, res, url))) return
      const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
      if (parts[1] === 'projects' && parts.length === 2) {
        if (req.method === 'GET') {
          let desktop: any[] | null = null
          try {
            desktop = await bridge.call('list', [], 2000)
          } catch {
            /* Desktop remains visible as offline. */
          }
          json(res, 200, [
            {
              id: 'shiping',
              name: 'Shiping资料库',
              kind: 'shiping',
              connected: desktop !== null,
              documents: desktop?.length ?? 0,
              collection: 'shiping_knowledge_bgem3_v2'
            },
            ...(await store.projects())
          ])
          return
        }
        if (req.method === 'POST') {
          json(res, 201, await store.createProject((await object(req)).name))
          return
        }
      }
      if (parts[1] === 'collections' && req.method === 'GET') {
        if (parts.length === 2) {
          try {
            json(res, 200, await request(COLLECTIONS + '?limit=1000'))
          } catch {
            throw new ApiError(503, '向量数据库未连接，请启动本地RAG服务')
          }
          return
        }
        if (parts.length === 4 && parts[3] === 'records') {
          const id = validId(parts[2]),
            offset = pageNumber(url.searchParams.get('offset'), 0, 10_000_000),
            limit = pageNumber(url.searchParams.get('limit'), 30, 100)
          const [r, total] = await Promise.all([
            request<any>(`${COLLECTIONS}/${id}/get`, {
              offset,
              limit: Math.max(1, limit),
              include: ['documents', 'metadatas']
            }),
            request<number>(`${COLLECTIONS}/${id}/count`)
          ])
          json(res, 200, {
            total,
            offset,
            limit,
            items: r.ids.map((id: string, i: number) => ({
              id,
              text: r.documents?.[i] ?? '',
              metadata: r.metadatas?.[i] ?? {}
            }))
          })
          return
        }
      }
      if (parts[1] !== 'projects' || !parts[2])
        throw new ApiError(404, '接口不存在')
      const a = adapter(parts[2]),
        doc = parts[4],
        action = parts[5]
      if (parts[3] === 'generations') {
        if (!library) throw new ApiError(409, '尚未启用SQLite')
        if (req.method === 'GET') {
          json(res, 200, {
            active: library.generation(parts[2])?.id,
            items: library.generations(parts[2])
          })
          return
        }
        if (req.method === 'POST' && parts[5] === 'rollback') {
          const body = await object(req)
          if (body.confirm !== true) throw new ApiError(400, '需要明确确认回退')
          const id = validId(parts[4]),
            target = library.generation(parts[2], id)
          if (!target) throw new ApiError(404, '代际不存在')
          const { fingerprint } = await import(
            '../src/main/rag/client'
          )
          if ((await fingerprint()) !== target.fingerprint)
            throw new ApiError(409, '模型指纹不一致，不能直接回退')
          const remote = await request<{ id: string }>(
            `${COLLECTIONS}/${target.collection}`
          )
          const count = await request<number>(
            `${COLLECTIONS}/${remote.id}/count`
          )
          if (count !== target.chunks.length)
            throw new ApiError(409, '目标索引丢失或不完整，请先重建')
          const { id: active } = library.rollbackGeneration(parts[2], id)
          json(res, 200, { active })
          return
        }
      }
      if (parts[3] === 'processing') {
        if (!processing) throw new ApiError(409, '结构化资料库尚未迁移启用')
        const project = parts[2],
          id = parts[4],
          operation = parts[5]
        if (parts.length === 4) {
          if (req.method === 'GET') {
            json(res, 200, processing.list(project))
            return
          }
          if (req.method === 'POST') {
            const body = await object(req)
            const docId =
              body.docId === undefined ? undefined : validId(body.docId)
            if (!docId && !body.base64)
              throw new ApiError(400, '请提供资料编号或文件')
            const file = body.base64
              ? {
                  name: fileValue(body.name, decodeBase64(body.base64)),
                  data: decodeBase64(body.base64)
                }
              : await a.original(docId!)
            json(res, 202, await processing.submit(project, docId, file))
            return
          }
        }
        validId(id)
        if (req.method === 'GET') {
          const job = processing.get(project, id)
          if (operation === 'original') {
            const file = await processing.original(project, id)
            attachment(res, file.name, file.data)
            return
          }
          if (operation === 'markdown') {
            if (!job.result) throw new ApiError(409, '尚无解析结果')
            attachment(
              res,
              'cleaned.md',
              job.result.cleaned,
              'text/markdown; charset=utf-8'
            )
            return
          }
          if (operation === 'json') {
            attachment(
              res,
              'processing-report.json',
              JSON.stringify(job, null, 2),
              'application/json; charset=utf-8'
            )
            return
          }
          json(res, 200, job)
          return
        }
        if (req.method === 'POST') {
          const body = await object(req)
          if (operation === 'review') {
            json(res, 200, processing.review(project, id, body))
            return
          }
          if (operation === 'cancel') {
            json(res, 200, processing.cancel(project, id))
            return
          }
          if (operation === 'retry') {
            if (
              body.password !== undefined &&
              typeof body.password !== 'string'
            )
              throw new ApiError(400, '密码格式无效')
            json(res, 202, processing.retry(project, id, body.password))
            return
          }
          if (operation === 'apply') {
            if (typeof body.version !== 'number')
              throw new ApiError(400, '报告版本无效')
            json(res, 202, processing.apply(project, id, body.version))
            return
          }
        }
        throw new ApiError(404, '处理接口不存在')
      }
      if (parts[3] === 'documents') {
        if (parts.length === 4 && req.method === 'GET') {
          const q = url.searchParams.get('q') ?? ''
          if (q.length > 2000) throw new ApiError(400, '搜索内容过长')
          json(
            res,
            200,
            await a.list({ trash: url.searchParams.get('trash') === '1', q })
          )
          return
        }
        if (parts.length === 4 && req.method === 'POST') {
          json(res, 201, await a.create(await object(req)))
          return
        }
        if (doc) validId(doc)
        if (parts.length === 5) {
          if (req.method === 'GET') {
            json(res, 200, await a.get(doc))
            return
          }
          if (req.method === 'PUT') {
            json(res, 200, await a.update(doc, await object(req)))
            return
          }
          if (req.method === 'DELETE') {
            json(res, 200, await a.trash(doc, (await object(req)).version))
            return
          }
        }
        if (parts.length === 6) {
          if (action === 'restore' && req.method === 'POST') {
            json(res, 200, await a.restore(doc, (await object(req)).version))
            return
          }
          if (action === 'chunks' && req.method === 'GET') {
            json(
              res,
              200,
              await a.chunks(
                doc,
                pageNumber(url.searchParams.get('offset'), 0, 10_000_000),
                Math.max(1, pageNumber(url.searchParams.get('limit'), 50, 200))
              )
            )
            return
          }
          if (action === 'original' && req.method === 'GET') {
            const file = await a.original(doc)
            attachment(res, file.name, file.data)
            return
          }
        }
      }
      if (parts.length === 4) {
        const operation = parts[3]
        if (req.method === 'GET' && operation === 'status') {
          json(res, 200, await a.status())
          return
        }
        if (req.method === 'GET' && operation === 'backup') {
          attachment(
            res,
            `rag-backup-${Date.now()}.json`,
            JSON.stringify(await a.backup(), null, 2),
            'application/json; charset=utf-8'
          )
          return
        }
        if (req.method === 'POST') {
          const body = await object(req)
          if (operation === 'import') {
            if (processing) {
              const data = decodeBase64(body.base64),
                name = fileValue(body.name, data)
              const job = await processing.submit(parts[2], undefined, {
                name,
                data
              })
              json(res, 202, {
                pending: true,
                jobId: job.id,
                docId: job.docId
              })
              return
            }
            json(res, 201, await a.importFile(body))
            return
          }
          if (operation === 'rebuild') {
            json(res, 202, await a.rebuild())
            return
          }
          if (operation === 'search') {
            json(
              res,
              200,
              await a.search(body.query, body.mode ?? 'conversation')
            )
            return
          }
          if (operation === 'restore') {
            json(res, 200, await a.importBackup(body))
            return
          }
        }
      }
      throw new ApiError(404, '接口不存在')
    })().catch((error) => errorResponse(res, error))
  })
  if (v4)
    server.on('listening', () => {
      const port = (server.address() as any).port
      void writeFile(
        discovery + '.tmp',
        JSON.stringify({
          url: `http://127.0.0.1:${port}`,
          token: processToken,
          pid: process.pid
        }),
        { mode: 0o600 }
      )
        .then(() => rename(discovery + '.tmp', discovery))
        .catch(() => console.error('本机服务连接配置写入失败'))
    })
  ;(server as any).shutdown = async () => {
    await v4?.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  server.on('close', () => {
    void v4?.close()
    if (v4) void unlink(discovery).catch(() => {})
    processing?.close()
    store.close()
  })
  server.requestTimeout = 60_000
  return server
}
if (require.main === module && process.env.SHIPING_LIBRARY_CHILD !== '1') {
  const root = process.env.RAG_ADMIN_ROOT ?? resolve(__dirname, '../..')
  const server = createAdminServer({ root })
  server.listen(18080, '127.0.0.1', () =>
    console.log('本地知识库管理：http://127.0.0.1:18080')
  )
  server.on('error', () => {
    console.error('知识库管理启动失败，端口可能已被占用')
    process.exitCode = 1
  })
  process.once('SIGTERM', () => {
    void (server as any).shutdown().then(() => process.exit(0))
  })
}
