import { readFile, stat } from 'node:fs/promises'
import { ApiError } from './store'
export class Bridge {
  constructor(private file: string) {}
  async call(
    method: string,
    args: unknown[] = [],
    timeout = method === 'importFile' ? 210_000 : 60_000
  ): Promise<any> {
    let discovery: { url: string; token: string }
    try {
      const info = await stat(this.file)
      if (info.size > 4096 || info.mode & 0o077) throw new Error('Invalid permissions')
      discovery = JSON.parse(await readFile(this.file, 'utf8'))
      if (
        !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(discovery.url) ||
        !/^[a-f0-9]{64}$/.test(discovery.token)
      )
        throw new Error('Invalid endpoint')
    } catch {
      throw new ApiError(503, 'Shiping尚未连接，请先启动更新后的“ShipingRAG试用”')
    }
    let response: Response
    try {
      response = await fetch(discovery.url + '/rpc', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${discovery.token}`
        },
        body: JSON.stringify({ method, args }),
        signal: AbortSignal.timeout(timeout)
      })
    } catch {
      throw new ApiError(503, 'Shiping连接中断，请重新打开试用版后重试')
    }
    if (response.status === 401) throw new ApiError(503, 'Shiping连接已更新，请刷新网页后重试')
    const result = await response.json()
    if (!response.ok) throw new ApiError(response.status, result.error ?? 'Shiping操作失败')
    return result
  }
}
