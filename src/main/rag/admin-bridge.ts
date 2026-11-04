import { app } from 'electron'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { knowledgeAdmin, getRagDocuments, refreshKnowledge, getRemoteLibrary } from '../knowledge'
import { queueReconcile, getRagStatus, searchRag } from './service'
import { createAdminHandler } from './admin-http'
export async function startAdminBridge(): Promise<void> {
  if (getRemoteLibrary?.()) return
  const token = randomBytes(32).toString('hex')
  const path = join(app.getPath('userData'), 'rag', 'admin-bridge.json')
  const methods: Record<string, (...args: unknown[]) => unknown> = Object.fromEntries(
    Object.entries(knowledgeAdmin).map(([name, fn]) => [
      name,
      (...args: unknown[]) => Reflect.apply(fn, undefined, args)
    ])
  )
  function schedule(force = false) {
    queueReconcile(force)
    return getRagStatus()
  }
  for (const name of ['create', 'update', 'trash', 'restore', 'importFile', 'importBackup']) {
    const original = methods[name]
    methods[name] = async (...args) => {
      const result = await original(...args)
      await schedule()
      return result
    }
  }
  methods.refresh = refreshKnowledge
  methods.status = getRagStatus
  methods.rebuild = () => schedule(true)
  methods.search = async (query: unknown, mode: unknown = 'conversation') => {
    if (
      typeof query !== 'string' ||
      !query.trim() ||
      query.length > 2000 ||
      (mode !== 'conversation' && mode !== 'screenshot')
    )
      throw new Error('请输入有效的问题和模式')
    const hits = await searchRag(query, mode),
      live = getRagDocuments()
    return hits.filter((h) =>
      live.some((d) => d.id === h.docId && d.revision === h.revision && d.modes.includes(mode))
    )
  }
  const server = createServer(createAdminHandler({ token, methods }))
  server.requestTimeout = 60_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as { port: number }).port
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(
    path + '.tmp',
    JSON.stringify({ url: `http://127.0.0.1:${port}`, token, pid: process.pid }),
    { mode: 0o600 }
  )
  await rename(path + '.tmp', path)
  app.once('before-quit', () => {
    server.close()
    void unlink(path).catch(() => {})
  })
}
