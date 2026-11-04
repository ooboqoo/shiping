import { resolve } from 'node:path'
import { createAdminServer } from '../../../library-web/server'
import { initializeLibrary } from './initialize'
async function start() {
  const root = process.env.RAG_ADMIN_ROOT
  const publicDir = process.env.SHIPING_LIBRARY_WEB
  if (!root || !publicDir) throw Error('内置资料库路径缺失')
  await initializeLibrary(resolve(root), process.env.SHIPING_LEGACY_DOCUMENTS || undefined)
  const server = createAdminServer({ root, publicDir })
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    clearInterval(parent)
    await (server as typeof server & { shutdown(): Promise<void> }).shutdown()
    process.exit(0)
  }
  const parentPid = Number(process.env.SHIPING_PARENT_PID)
  const parent = setInterval(() => {
    if (!parentPid) return
    try {
      process.kill(parentPid, 0)
    } catch {
      void stop()
    }
  }, 1000)
  parent.unref()
  process.once('SIGTERM', () => {
    void stop()
  })
  process.once('SIGINT', () => {
    void stop()
  })
  let fallbackPort = false
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && !fallbackPort) {
      fallbackPort = true
      server.listen(0, '127.0.0.1')
      return
    }
    console.error('内置资料库启动失败')
    process.exit(1)
  })
  server.listen(18080, '127.0.0.1')
}
void start().catch(() => {
  console.error('内置资料库初始化失败，请检查应用数据目录')
  process.exit(1)
})
