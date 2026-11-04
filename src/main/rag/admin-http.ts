import type { RequestListener } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { localHost, json, readJSON, errorResponse, HttpError } from './local-http'
export function createAdminHandler(options: {
  token: string
  methods: Record<string, (...args: unknown[]) => unknown>
}): RequestListener {
  return (req, res) => {
    void (async () => {
      localHost(req)
      if (req.headers.origin) throw new HttpError(403, '此接口仅供本机后台调用')
      const supplied = Buffer.from(req.headers.authorization ?? ''),
        expected = Buffer.from(`Bearer ${options.token}`)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        throw new HttpError(401, '连接凭据已失效，请重新连接Shiping')
      if (req.method === 'GET' && req.url === '/health') {
        json(res, 200, { ready: true })
        return
      }
      if (req.method !== 'POST' || req.url !== '/rpc') throw new HttpError(404, '接口不存在')
      const body = await readJSON(req)
      if (!body || typeof body.method !== 'string' || !Object.hasOwn(options.methods, body.method))
        throw new HttpError(404, '接口不存在')
      const args = body.args ?? []
      if (!Array.isArray(args) || args.length > 4) throw new HttpError(400, '请求参数无效')
      json(res, 200, await options.methods[body.method](...args))
    })().catch((error) => errorResponse(res, error))
  }
}
