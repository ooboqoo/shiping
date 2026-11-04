import type { ModelConfig } from '../src/main/library-v4/model-providers'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LibraryService } from '../src/main/library-v4/service'
import { readJSON, json, HttpError } from '../src/main/rag/local-http'
import { validId } from './store'
export async function handleChat(
  service: LibraryService,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const method = req.method || 'GET',
    parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (url.pathname === '/api/model-providers') {
    if (method === 'GET') json(res, 200, service.providerStatus())
    else if (method === 'PUT' || method === 'POST') {
      const controller = new AbortController()
      const disconnect = () => {
        if (!res.writableEnded) controller.abort()
      }
      res.once('close', disconnect)
      try {
        const body = await readJSON(req, 16000)
        if (method === 'PUT')
          json(
            res,
            200,
            service.configureProvider(
              String(body.kind),
              body.config as ModelConfig
            )
          )
        else if (body.action === 'models')
          json(
            res,
            200,
            await service.providerModels(
              String(body.kind),
              body.config as ModelConfig,
              controller.signal
            )
          )
        else if (body.action === 'test')
          json(
            res,
            200,
            await service.testProvider(
              String(body.kind),
              body.config as ModelConfig,
              controller.signal
            )
          )
        else throw new HttpError(400, '模型操作无效')
      } catch (error) {
        if (error instanceof HttpError) throw error
        throw new HttpError(
          400,
          error instanceof Error ? error.message : '模型配置失败'
        )
      } finally {
        res.off('close', disconnect)
      }
    } else throw new HttpError(405, '请求方法不支持')
    return true
  }
  if (url.pathname === '/api/model') {
    if (method === 'GET') json(res, 200, service.modelStatus())
    else throw new HttpError(405, '请求方法不支持')
    return true
  }
  if (url.pathname === '/api/retrieval') {
    if (method === 'GET') json(res, 200, service.retrievalStatus())
    else if (method === 'PUT') {
      const body = await readJSON(req, 1000)
      if (typeof body.reranker !== 'boolean')
        throw new HttpError(400, '精排开关无效')
      json(res, 200, service.configureRetrieval(body.reranker))
    } else throw new HttpError(405, '请求方法不支持')
    return true
  }
  if (parts[1] !== 'projects' || parts[3] !== 'chat') return false
  const project = parts[2]
  if (project !== 'shiping') validId(project)
  service.catalog.projectInfo(project)
  if (parts[4] !== 'sessions') throw new HttpError(404, '对话接口不存在')
  if (parts.length === 5) {
    if (method === 'GET') json(res, 200, service.catalog.chat.list(project))
    else if (method === 'POST')
      json(res, 201, service.catalog.chat.create(project))
    else throw new HttpError(405, '请求方法不支持')
    return true
  }
  const session = validId(parts[5])
  if (parts.length === 6) {
    if (method === 'GET')
      json(res, 200, service.catalog.chat.get(project, session))
    else if (method === 'DELETE') {
      service.catalog.chat.remove(project, session)
      json(res, 200, { deleted: true })
    } else throw new HttpError(405, '请求方法不支持')
    return true
  }
  service.catalog.chat.get(project, session)
  if (
    parts[6] === 'turns' &&
    parts.length === 9 &&
    parts[8] === 'stop' &&
    method === 'POST'
  ) {
    json(res, 200, service.chat.stop(project, session, validId(parts[7])))
    return true
  }
  if (parts[6] !== 'turns' || parts.length !== 7 || method !== 'POST')
    throw new HttpError(404, '对话接口不存在')
  const body = await readJSON(req, 16000)
  if (
    typeof body.question !== 'string' ||
    !body.question.trim() ||
    body.question.length > 3000 ||
    typeof body.requestId !== 'string' ||
    !/^[-\w]{1,80}$/.test(body.requestId)
  )
    throw new HttpError(400, '问题或提交编号无效')
  if (body.useKnowledge !== undefined && typeof body.useKnowledge !== 'boolean')
    throw new HttpError(400, '知识库开关无效')
  const controller = new AbortController(),
    disconnect = () =>
      controller.abort(new DOMException('页面连接已断开', 'AbortError'))
  res.on('close', disconnect)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive'
  })
  const heartbeat = setInterval(() => {
    if (!res.destroyed) res.write(': keepalive\n\n')
  }, 10000)
  heartbeat.unref()
  try {
    for await (const event of service.chat.run(
      project,
      session,
      {
        question: body.question,
        requestId: body.requestId,
        useKnowledge: body.useKnowledge !== false,
        rewrite: body.rewrite !== false,
        retrievalOnly: body.retrievalOnly === true,
        mode: typeof body.mode === 'string' ? body.mode : undefined
      },
      controller.signal
    )) {
      if (
        !res.destroyed &&
        !res.write('data: ' + JSON.stringify(event) + '\n\n')
      )
        await new Promise<void>((resolve) => {
          const finish = () => {
            res.off('drain', finish)
            res.off('close', finish)
            resolve()
          }
          res.once('drain', finish)
          res.once('close', finish)
        })
    }
  } catch {
    if (!res.destroyed)
      res.write(
        'data: ' +
          JSON.stringify({
            type: 'error',
            message: '无法开始对话，请检查模型配置、对话状态或索引'
          }) +
          '\n\n'
      )
  } finally {
    clearInterval(heartbeat)
    res.off('close', disconnect)
    res.end()
  }
  return true
}
