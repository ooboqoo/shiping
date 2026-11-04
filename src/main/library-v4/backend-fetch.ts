import { request as httpRequest, type ClientRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { normalizeProxySettings, type ProxySettings } from '../../shared/proxy'
export function proxyFromRoute(route: string): ProxySettings {
  const first = route.split(';')[0].trim()
  if (first.toUpperCase() === 'DIRECT') return { mode: 'direct', url: '' }
  const m = first.match(/^(PROXY|HTTPS)\s+([\w.\-[\]:]+:\d{1,5})$/i)
  if (!m) throw Error('后台仅支持 HTTP(S) 代理路线')
  return normalizeProxySettings({
    mode: 'custom',
    url: (m[1].toUpperCase() === 'PROXY' ? 'http' : 'https') + '://' + m[2]
  })
}
/** Explicit same-route transport. Cancellation also owns the pending CONNECT socket. */
export function backendFetch(value: ProxySettings, direct: typeof fetch = fetch): typeof fetch {
  const proxy = normalizeProxySettings(value)
  if (proxy.mode === 'system') throw Error('请先解析系统代理路线')
  if (proxy.mode === 'direct') return (input, init) => direct(input, { ...init, redirect: 'error' })
  if (!/^https?:/.test(proxy.url)) throw Error('后台仅支持 HTTP(S) 代理')
  return async (input, init) => {
    const request = new Request(input, init),
      url = new URL(request.url)
    if (!['http:', 'https:'].includes(url.protocol)) throw Error('模型请求地址无效')
    request.signal.throwIfAborted()
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined
    if (body && body.length > 256 * 1024) throw Error('模型请求超过大小限制')
    request.signal.throwIfAborted()
    const connection = new AbortController(),
      agent =
        url.protocol === 'https:'
          ? new HttpsProxyAgent(proxy.url, { signal: connection.signal })
          : new HttpProxyAgent(proxy.url, { signal: connection.signal })
    return new Promise<Response>((resolve, reject) => {
      let req: ClientRequest
      const clearHandshake = () => clearTimeout(handshake)
      const cleanup = () => {
        clearHandshake()
        request.signal.removeEventListener('abort', cancel)
        agent.destroy()
      }
      const cancel = () => {
        connection.abort(request.signal.reason)
        req?.destroy()
        cleanup()
        reject(request.signal.reason)
      }
      const handshake = setTimeout(() => {
        connection.abort(new DOMException('代理握手超时', 'TimeoutError'))
        req?.destroy()
        cleanup()
        reject(Error('模型代理握手超时，请检查本机代理'))
      }, 10000)
      request.signal.addEventListener('abort', cancel, { once: true })
      // Agent forwards this signal to net/tls.connect before its socket belongs to the pool.
      agent.once('proxyConnect', clearHandshake)
      req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          agent,
          signal: request.signal
        },
        (res) => {
          clearHandshake()
          const headers = new Headers()
          for (const [name, val] of Object.entries(res.headers))
            if (val !== undefined) headers.set(name, Array.isArray(val) ? val.join(', ') : val)
          const stream = Readable.toWeb(res) as ReadableStream<Uint8Array>
          res.once('close', cleanup)
          resolve(
            new Response([204, 205, 304].includes(res.statusCode || 0) ? null : stream, {
              status: res.statusCode || 502,
              statusText: res.statusMessage,
              headers
            })
          )
        }
      )
      req.once('socket', clearHandshake)
      req.on('error', () => {
        cleanup()
        if (request.signal.aborted) reject(request.signal.reason)
        else reject(Error('模型代理连接失败，请检查本机代理是否运行'))
      })
      req.end(body)
    })
  }
}
