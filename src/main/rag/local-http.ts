import type { IncomingMessage, ServerResponse } from 'node:http'
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}
export function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(JSON.stringify(value))
}
export function localHost(req: IncomingMessage) {
  if (req.headers.host !== `127.0.0.1:${req.socket.localPort}`)
    throw new HttpError(403, '只允许通过本机地址访问')
}
export function readJSON(
  req: IncomingMessage,
  limit = 45 * 1024 * 1024
): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
    throw new HttpError(415, '请使用JSON请求')
  if (Number(req.headers['content-length']) > limit) {
    req.resume()
    throw new HttpError(413, '请求超过允许大小')
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0,
      failed = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        if (!failed) reject(new HttpError(413, '请求超过允许大小'))
        failed = true
        chunks.length = 0
        return
      }
      if (!failed) chunks.push(chunk)
    })
    req.on('end', () => {
      if (failed) return
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Expected object')
        resolve(value as Record<string, unknown>)
      } catch {
        reject(new HttpError(400, 'JSON内容无效'))
      }
    })
    req.on('error', reject)
    req.on('aborted', () => reject(new HttpError(400, '请求已中断')))
  })
}
export function errorResponse(res: ServerResponse, error: unknown) {
  const e = error as Error & { status?: number }
  json(res, e.status && e.status >= 400 && e.status <= 599 ? e.status : 500, {
    error: e.message || '操作失败，请重试'
  })
}

export async function readBinary(req: IncomingMessage, limit = 30 * 1024 * 1024): Promise<Buffer> {
  if (!/^application\/octet-stream(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415,'请使用二进制文件上传')
  const expected = req.headers['content-length'] === undefined ? undefined : Number(req.headers['content-length'])
  if(expected !== undefined && (!Number.isSafeInteger(expected) || expected<=0 || expected>limit)) {req.resume();throw new HttpError(413,'文件不能为空且不能超过30MB')}
  return new Promise((resolve,reject)=>{
    const chunks:Buffer[]=[];let size=0,failed=false
    const fail=(e:Error)=>{if(!failed){failed=true;chunks.length=0;reject(e)}}
    req.on('data',(chunk:Buffer)=>{if(failed)return;size+=chunk.length;if(size>limit){fail(new HttpError(413,'文件超过30MB'));return}chunks.push(chunk)})
    req.on('aborted',()=>fail(new HttpError(400,'上传已取消或中断，请重试')))
    req.on('error',fail)
    req.on('end',()=>{if(failed)return;if(!size || (expected!==undefined&&expected!==size)){fail(new HttpError(400,'上传文件不完整'));return}resolve(Buffer.concat(chunks,size))})
  })
}
