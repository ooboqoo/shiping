import { createHash } from 'node:crypto'
import { proxyFromRoute } from './backend-fetch'
import { normalizeProxySettings } from '../../shared/proxy'
import type { ApiProfile } from '../../shared/api-profile'
import type { ProxySettings } from '../../shared/proxy'
/** Only the selected conversation profile crosses the authenticated local RPC. */
export class ModelSync {
  private generation = 0
  private closed = false
  private last = ''
  private timer?: ReturnType<typeof setTimeout>
  private retries = 0
  private controller?: AbortController
  private state = { synced: false, message: '等待桌面对话模型配置' }
  constructor(
    private read: () => { profile: ApiProfile; proxy: ProxySettings },
    private resolveSystem: (base: string) => Promise<{ route: string; error?: string }>,
    private send: (profile: any, version: string, signal?: AbortSignal) => Promise<any>
  ) {}
  status() {
    return { ...this.state }
  }
  notify() {
    this.generation++
    this.retries = 0
    this.controller?.abort()
    clearTimeout(this.timer)
    if (!this.closed)
      this.timer = setTimeout(() => {
        void this.flush()
      }, 600)
  }
  async flush() {
    clearTimeout(this.timer)
    if (this.closed) return
    const ticket = this.generation,
      { profile: p, proxy } = this.read()
    if (!p.apiKey?.trim() || !p.model?.trim() || !p.apiBaseURL?.trim()) return
    if (!/deepseek/i.test([p.name, p.model, p.apiBaseURL].join(' '))) {
      this.state = { synced: false, message: '请先选择已授权的 DeepSeek 对话模型' }
      return
    }
    const signature = createHash('sha256').update(JSON.stringify({ p, proxy })).digest('hex')
    if (signature === this.last) return
    const controller = new AbortController()
    this.controller = controller
    try {
      let route = normalizeProxySettings(proxy)
      if (route.mode === 'custom' && !/^https?:/.test(route.url)) throw Error('proxy')
      if (proxy.mode === 'system') {
        const result = await this.resolveSystem(p.apiBaseURL)
        if (this.closed || ticket !== this.generation) return
        if (result.error) throw Error('proxy')
        try {
          route = proxyFromRoute(result.route)
        } catch {
          throw Error('proxy')
        }
      }
      if (this.closed || ticket !== this.generation) return
      const safe = {
        apiBaseURL: p.apiBaseURL,
        apiKey: p.apiKey,
        apiHeaders: p.apiHeaders,
        model: p.model,
        disableThinking: p.disableThinking,
        proxy: route
      }
      const result = await this.send(safe, signature, controller.signal)
      if (this.closed || ticket !== this.generation) return
      this.last = signature
      this.retries = 0
      this.state = {
        synced: true,
        message:
          result?.source === 'web'
            ? '网页使用独立模型配置，已保留'
            : '已安全同步桌面 DeepSeek 对话模型'
      }
    } catch (e) {
      if (this.closed || ticket !== this.generation) return
      const isProxy = (e as Error).message === 'proxy'
      this.state = {
        synced: false,
        message: isProxy
          ? '后台不支持当前代理路线，请选择 HTTP(S) 或直连配置'
          : '本地知识库服务未就绪，模型配置将在后台重试'
      }
      if (!isProxy && this.retries++ < 2)
        this.timer = setTimeout(() => {
          void this.flush()
        }, 2500)
    }
  }
  close() {
    this.closed = true
    clearTimeout(this.timer)
    this.controller?.abort()
  }
}
