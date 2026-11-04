import { open } from 'node:fs/promises'
import { request } from 'node:http'
import { basename, extname } from 'node:path'
import { KNOWLEDGE_EXTENSIONS } from '../../shared/knowledge'

export interface UploadReceipt {
  jobId: string
  docId: string
  pending?: boolean
  status?: string
  reused?: boolean
}

/** Uses the same binary endpoint and receipt reconciliation as the browser. */
export async function uploadLocalFile(
  origin: string,
  path: string,
  project: string,
  submission: string,
  progress: (loaded: number, total: number) => void,
  signal?: AbortSignal
): Promise<UploadReceipt> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat(),
      name = basename(path)
    if (!info.isFile() || !info.size || info.size > 30 * 1024 * 1024)
      throw Error('文件须大于0且不超过30MB')
    if (!KNOWLEDGE_EXTENSIONS.includes(extname(name).slice(1).toLowerCase()))
      throw Error('上传文件格式无效')
    signal?.throwIfAborted()
    const session = await fetch(origin + '/api/session', {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000)
    })
    const cookie = session.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')
    const { csrf } = await session.json()
    const endpoint = origin + '/api/projects/' + encodeURIComponent(project)
    try {
      return await new Promise<UploadReceipt>((resolve, reject) => {
        const req = request(
          endpoint +
            '/upload?name=' +
            encodeURIComponent(name) +
            '&submission=' +
            encodeURIComponent(submission),
          {
            method: 'POST',
            signal,
            headers: {
              Cookie: cookie,
              Origin: origin,
              'X-Rag-CSRF': csrf,
              'Content-Type': 'application/octet-stream',
              'Content-Length': info.size
            }
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c) => chunks.push(c))
            res.on('error', reject)
            res.on('end', () => {
              try {
                const value = JSON.parse(Buffer.concat(chunks).toString())
                if ((res.statusCode || 500) >= 300) reject(Error(value.error || '上传失败'))
                else resolve(value)
              } catch {
                reject(Error('后台返回无效，请重试核对接收记录'))
              }
            })
          }
        )
        req.setTimeout(300000, () => req.destroy(Error('上传超时')))
        const stream = file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })
        req.on('error', reject)
        req.on('close', () => stream.destroy())
        void (async () => {
          let loaded = 0
          for await (const chunk of stream) {
            await new Promise<void>((resolve, reject) =>
              req.write(chunk, (err) => (err ? reject(err) : resolve()))
            )
            loaded += chunk.length
            progress(loaded, info.size)
          }
          req.end()
        })().catch((e) => req.destroy(e))
      })
    } catch (error) {
      // Even cancellation can race with durable acceptance. Never blindly resubmit.
      const response = await fetch(endpoint + '/uploads/' + encodeURIComponent(submission), {
        headers: { Cookie: cookie },
        signal: AbortSignal.timeout(15000)
      }).catch(() => undefined)
      if (response?.ok) return response.json()
      throw error
    }
  } finally {
    await file.close()
  }
}
