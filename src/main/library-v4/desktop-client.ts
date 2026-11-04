import { uploadLocalFile } from './desktop-upload'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { readFile, stat, writeFile, rename, unlink } from 'node:fs/promises'
export function privateFileMode(mode: number, platform = process.platform) {
  return platform === 'win32' || (mode & 0o077) === 0
}
/** A thin local client: no SQLite connection and no fallback writes. */
export class DesktopLibrary {
  constructor(
    private discovery: string,
    private ready?: () => Promise<void>
  ) {}
  async register() {
    const file = join(dirname(this.discovery), 'desktop.json'),
      start =
        process.platform === 'win32'
          ? String(Date.now())
          : execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], {
              encoding: 'utf8'
            }).trim()
    await writeFile(
      file + '.tmp',
      JSON.stringify({ pid: process.pid, marker: process.execPath, start }),
      { mode: 0o600 }
    )
    await rename(file + '.tmp', file)
    return async () => {
      try {
        const current = JSON.parse(await readFile(file, 'utf8'))
        if (current.pid === process.pid && current.start === start) await unlink(file)
      } catch {}
    }
  }
  async call<T = any>(method: string, args: unknown[] = [], signal?: AbortSignal): Promise<T> {
    const config = await this.connection()
    signal?.throwIfAborted()
    const deadline = AbortSignal.timeout(
      ['search', 'searchDetails', 'providerModels', 'testProvider'].includes(method) ? 65000 : 15000
    )
    let response: Response
    try {
      response = await fetch(config.url + '/api/internal/rpc', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, args }),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline
      })
    } catch (e) {
      if (signal?.aborted) throw e
      throw Error('本地知识库服务连接失败，请检查服务状态')
    }
    const result = await response.json()
    if (!response.ok) throw Error(result.error || '本地知识库操作失败')
    return result as T
  }
  async upload(
    path: string,
    submission: string,
    progress: (loaded: number, total: number) => void,
    signal?: AbortSignal,
    project = 'shiping'
  ) {
    const config = await this.connection()
    return uploadLocalFile(config.url, path, project, submission, progress, signal)
  }
  private async connection() {
    await this.ready?.()
    let config: { url: string; token: string }
    try {
      const info = await stat(this.discovery)
      if (info.size > 4096 || !privateFileMode(info.mode)) throw Error()
      config = JSON.parse(await readFile(this.discovery, 'utf8'))
      if (
        !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(config.url) ||
        !/^[a-f0-9]{64}$/.test(config.token)
      )
        throw Error()
    } catch {
      throw Error('本地知识库服务未运行或连接配置无效，请启动本地服务')
    }
    return config
  }
}
