import { createWriteStream } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, unlink, open } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
interface Options {
  root: string
  entry: string
  publicDir: string
  executable?: string
  legacyDocuments?: string
  ocrDir?: string
  timeoutMs?: number
}
const alive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
/** One owned background per data root; no external Node installation is needed. */
export class ManagedLibrary {
  private child?: ChildProcess
  private pending?: Promise<string>
  private closed = false
  private owner = randomUUID()
  private timer?: ReturnType<typeof setTimeout>
  private restarts = 0
  private address = ''
  private lock: string
  private discovery: string
  constructor(private options: Options) {
    const dir = join(options.root, 'data', 'library')
    this.lock = join(dir, 'runtime.lock')
    this.discovery = join(dir, 'service.json')
  }
  ready(): Promise<string> {
    if (this.closed) return Promise.reject(Error('知识库服务已关闭'))
    if (this.child && this.address) return Promise.resolve(this.address)
    if (!this.pending)
      this.pending = this.start().finally(() => {
        this.pending = undefined
      })
    return this.pending
  }
  private async probe() {
    try {
      const config = JSON.parse(await readFile(this.discovery, 'utf8'))
      if (
        !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(config.url) ||
        !/^[a-f0-9]{64}$/.test(config.token)
      )
        return undefined
      const response = await fetch(config.url + '/api/internal/rpc', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'runtimeStatus', args: [] }),
        signal: AbortSignal.timeout(1000)
      })
      const status = await response.json()
      return response.ok && status.storage === 'sqlite-vectors' && status.version === 1
        ? (config.url as string)
        : undefined
    } catch {
      return undefined
    }
  }
  private async releaseLock(owner = this.owner) {
    try {
      if (JSON.parse(await readFile(this.lock, 'utf8')).owner === owner) await unlink(this.lock)
    } catch {
      /* A lock removed by its owner needs no further cleanup. */
    }
  }
  private async start(): Promise<string> {
    const existing = await this.probe()
    if (existing) return existing
    await mkdir(join(this.options.root, 'data', 'library'), { recursive: true, mode: 0o700 })
    try {
      const prior = JSON.parse(await readFile(this.discovery, 'utf8'))
      if (alive(prior.pid)) throw Error('旧版知识库服务仍在运行，请退出旧服务后重新打开Shiping')
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('旧版')) throw e
    }
    const owner = randomUUID()
    let owns = false
    for (let attempt = 0; attempt < 2 && !owns; attempt++) {
      try {
        const file = await open(this.lock, 'wx', 0o600)
        await file.writeFile(JSON.stringify({ pid: process.pid, owner }))
        await file.close()
        owns = true
        this.owner = owner
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        const lock = JSON.parse(await readFile(this.lock, 'utf8'))
        if (!alive(lock.pid)) {
          await unlink(this.lock)
          continue
        }
        const deadline = Date.now() + (this.options.timeoutMs || 20000)
        while (Date.now() < deadline && !this.closed) {
          const url = await this.probe()
          if (url) return url
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        throw Error('另一知识库进程正在启动，请稍后重试')
      }
    }
    if (!owns || this.closed) {
      await this.releaseLock()
      throw Error('知识库服务已关闭')
    }
    try {
      const child = spawn(this.options.executable || process.execPath, [this.options.entry], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          SHIPING_LIBRARY_CHILD: '1',
          SHIPING_PARENT_PID: String(process.pid),
          RAG_ADMIN_ROOT: this.options.root,
          SHIPING_LIBRARY_WEB: this.options.publicDir,
          SHIPING_LEGACY_DOCUMENTS: this.options.legacyDocuments || '',
          SHIPING_OCR_DATA: this.options.ocrDir || ''
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      })
      this.child = child
      const log = createWriteStream(join(this.options.root, 'data', 'library', 'runtime.log'), {
        flags: 'a',
        mode: 0o600
      })
      log.on('error', () => {})
      child.stderr?.pipe(log)
      child.once('exit', () => log.end())
      child.on('error', () => {})
      child.once('exit', () => {
        if (this.child === child) {
          this.child = undefined
          this.address = ''
        }
        void this.releaseLock(owner)
        if (!this.closed && this.restarts++ < 3)
          this.timer = setTimeout(() => {
            void this.ready().catch(() => {})
          }, 1000 * this.restarts)
      })
      const deadline = Date.now() + (this.options.timeoutMs || 20000)
      while (
        Date.now() < deadline &&
        !this.closed &&
        child.exitCode === null &&
        !child.signalCode
      ) {
        const url = await this.probe()
        if (url) {
          this.address = url
          return url
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw Error('内置知识库服务启动失败，请重启Shiping或检查日志')
    } catch (e) {
      this.child?.kill()
      await this.releaseLock()
      throw e
    }
  }
  async stop() {
    this.closed = true
    clearTimeout(this.timer)
    const child = this.child
    if (child && child.exitCode === null && !child.signalCode) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 5000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        child.kill('SIGTERM')
      })
    }
    await this.pending?.catch(() => {})
    await this.releaseLock()
  }
}
