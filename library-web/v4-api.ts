import type { IncomingMessage, ServerResponse } from 'node:http'
import { LibraryService } from '../src/main/library-v4/service'
import {
  readJSON,
  readBinary,
  json,
  HttpError
} from '../src/main/rag/local-http'
import { decodeBase64, validId } from './store'
import JSZip from 'jszip'
function download(
  res: ServerResponse,
  name: string,
  data: Buffer | string,
  type = 'application/octet-stream'
) {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  })
  res.end(data)
}
export async function handleV4(
  service: LibraryService,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent),
    method = req.method || 'GET'
  if (parts[1] !== 'projects') return false
  if (parts.length === 4 && parts[3] === 'upload' && method === 'POST') {
    const project = parts[2]
    if (project !== 'shiping') validId(project)
    const id = validId(url.searchParams.get('submission')),
      data = await readBinary(req)
    try {
      json(
        res,
        202,
        await service.upload(
          project,
          { name: url.searchParams.get('name') || '', data },
          url.searchParams.get('docId')
            ? {
                docId: validId(url.searchParams.get('docId')),
                version: url.searchParams.get('version') || ''
              }
            : undefined,
          id
        )
      )
    } catch (e) {
      const error = e as Error & { status?: number }
      if (/提交编号/.test(error.message)) error.status = 409
      throw e
    }
    return true
  }
  if (parts.length === 5 && parts[3] === 'uploads' && method === 'GET') {
    const found = service.uploadReceipt(parts[2], validId(parts[4]))
    if (!found) throw new HttpError(404, '后台尚未接收到该文件')
    json(res, 200, found)
    return true
  }
  const body = method === 'GET' ? {} : await readJSON(req),
    project = parts[2],
    operation = parts[3],
    id = parts[4],
    action = parts[5]
  try {
    if (parts.length === 2) {
      if (method === 'GET')
        json(res, 200, service.projects(url.searchParams.get('trash') === '1'))
      else if (method === 'POST') {
        if (typeof body.name !== 'string')
          throw new HttpError(400, '知识库名称无效')
        json(res, 201, service.createProject(body.name))
      } else throw new HttpError(405, '请求方法不支持')
      return true
    }
    if (project !== 'shiping') validId(project)
    if (parts.length === 3 && method === 'PATCH') {
      json(
        res,
        200,
        service.renameProject(project, body.name, String(body.version || ''))
      )
      return true
    }
    if (parts.length === 3 && method === 'DELETE') {
      json(res, 200, service.projectTrash(project, String(body.version || '')))
      return true
    }
    if (operation === 'project-restore' && method === 'POST') {
      json(
        res,
        200,
        service.projectRestore(project, String(body.version || ''))
      )
      return true
    }
    if (operation === 'clear' && method === 'POST') {
      json(res, 200, service.clearProject(project, String(body.version || '')))
      return true
    }
    if (operation === 'clear-history' && method === 'GET') {
      service.catalog.projectInfo(project)
      json(res, 200, service.catalog.clearHistory(project))
      return true
    }
    if (operation === 'clear-restore' && method === 'POST') {
      json(res, 200, service.restoreClear(project, String(body.batch || '')))
      return true
    }
    if (operation === 'purge-preview' && method === 'GET') {
      json(res, 200, service.purgePreview(project))
      return true
    }
    if (operation === 'purge' && method === 'POST') {
      const r = await service.purge(project, {
        version: String(body.version || ''),
        confirm: body.confirm === true
      })
      json(res, r.pending ? 202 : 200, r)
      return true
    }
    if (operation === 'status' && method === 'GET') {
      json(res, 200, service.status(project))
      return true
    }
    if (operation === 'rebuild' && method === 'POST') {
      if (!['full', 'incremental'].includes(String(body.kind)))
        throw new HttpError(400, '请选择全量或增量索引')
      json(res, 202, service.scheduleIndex(project, body.kind as any))
      return true
    }
    if (operation === 'import' && method === 'POST') {
      json(
        res,
        202,
        await service.upload(
          project,
          { name: String(body.name || ''), data: decodeBase64(body.base64) },
          body.docId
            ? {
                docId: validId(body.docId),
                version: String(body.version || '')
              }
            : undefined
        )
      )
      return true
    }
    if (operation === 'search' && method === 'POST') {
      json(
        res,
        200,
        await service.searchDetails(
          project,
          String(body.query || ''),
          String(body.mode || 'conversation')
        )
      )
      return true
    }
    if (operation === 'active' && method === 'GET') {
      json(
        res,
        200,
        service
          .active(
            project,
            String(url.searchParams.get('mode') || 'conversation')
          )
          .map(({ sourcePath, storageFile, ...d }) => {
            void sourcePath
            void storageFile
            return d
          })
      )
      return true
    }
    if (operation === 'tasks') {
      if (!id && method === 'GET') {
        json(res, 200, service.tasks(project))
        return true
      }
      validId(id)
      if (method === 'GET' && action === 'original') {
        const file = await service.taskOriginal(project, id)
        download(res, file.name, file.data)
        return true
      }
      if (method === 'GET') {
        json(res, 200, service.task(project, id))
        return true
      }
      if (action === 'retry' && method === 'POST') {
        json(
          res,
          202,
          service.retry(project, id, body.password as string | undefined)
        )
        return true
      }
      if (action === 'cancel' && method === 'POST') {
        json(res, 200, service.cancel(project, id))
        return true
      }
      if (action === 'resolve' && method === 'POST') {
        json(res, 202, service.resolve(project, id, body))
        return true
      }
    }
    if (
      operation === 'generations' &&
      action === 'rollback' &&
      method === 'POST'
    ) {
      json(
        res,
        200,
        await service.rollback(project, validId(id), body.confirm === true)
      )
      return true
    }
    if (operation === 'generations' && method === 'GET') {
      json(res, 200, {
        active: service.catalog.generation(project)?.id,
        items: service.catalog.generations(project)
      })
      return true
    }
    if (operation === 'documents') {
      if (!id && method === 'GET') {
        json(
          res,
          200,
          service.list(project, {
            trash: url.searchParams.get('trash') === '1',
            text: url.searchParams.get('text') === '1',
            q: url.searchParams.get('q') || ''
          })
        )
        return true
      }
      if (!id && method === 'POST') {
        json(res, 201, service.create(project, body))
        return true
      }
      validId(id)
      if (!action && method === 'GET') {
        json(res, 200, service.get(project, id))
        return true
      }
      if (!action && method === 'PUT') {
        json(res, 200, service.update(project, id, body))
        return true
      }
      if (!action && method === 'DELETE') {
        json(res, 200, service.trash(project, id, String(body.version || '')))
        return true
      }
      if (action === 'purge' && method === 'POST') {
        json(
          res,
          202,
          service.scheduleDocumentPurge(
            project,
            id,
            String(body.version || ''),
            body.confirm === true
          )
        )
        return true
      }
      if (action === 'reparse' && method === 'POST') {
        json(
          res,
          202,
          await service.reparse(
            project,
            id,
            String(body.version || ''),
            body.confirm === true
          )
        )
        return true
      }
      if (action === 'restore' && method === 'POST') {
        json(res, 200, service.restore(project, id, String(body.version || '')))
        return true
      }
      if (action === 'markdown' && method === 'GET') {
        const file = service.markdown(
          project,
          id,
          url.searchParams.get('active') === '1'
        )
        download(res, file.name, file.data, 'text/markdown; charset=utf-8')
        return true
      }
      if (action === 'original' && method === 'GET') {
        const file = await service.original(project, id)
        download(res, file.name, file.data)
        return true
      }
      if (action === 'chunks' && method === 'GET') {
        service.get(project, id)
        const chunks =
          service.catalog
            .generation(project)
            ?.chunks.filter((c: any) => c.docId === id) || []
        json(res, 200, { total: chunks.length, items: chunks })
        return true
      }
    }
    if (operation === 'export-md' && method === 'GET') {
      const zip = new JSZip(),
        docs = service.list(project, { text: true })
      let size = 0
      for (const doc of docs) {
        const file = service.markdown(project, doc.id)
        size += file.data.length
        if (size > 45 * 1024 * 1024)
          throw new HttpError(413, '导出超过45MB，请分批下载')
        zip.file(doc.id + '/' + file.name, file.data)
      }
      download(
        res,
        'knowledge-markdown.zip',
        await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
        'application/zip'
      )
      return true
    }
    throw new HttpError(404, '接口不存在')
  } catch (error) {
    const e = error as Error & { status?: number }
    if (!e.status)
      e.status = /冲突|已修改|发生变化/.test(e.message)
        ? 409
        : /不存在|已删除/.test(e.message)
          ? 404
          : 400
    throw e
  }
}
const METHODS = new Set([
  'projects',
  'createProject',
  'list',
  'get',
  'create',
  'update',
  'trash',
  'restore',
  'upload',
  'active',
  'status',
  'scheduleIndex',
  'search',
  'searchDetails',
  'tasks',
  'task',
  'cancel',
  'retry',
  'backup',
  'importBackup',
  'original',
  'chunks',
  'reparse',
  'fullContext',
  'configureModel',
  'modelStatus',
  'retrievalStatus',
  'providerStatus',
  'runtimeStatus',
  'configureProvider',
  'providerModels',
  'testProvider',
  'configureRetrieval'
])
export async function rpcV4(
  service: LibraryService,
  req: IncomingMessage,
  res: ServerResponse
) {
  const body = await readJSON(req)
  if (
    typeof body.method !== 'string' ||
    !METHODS.has(body.method) ||
    !Array.isArray(body.args) ||
    body.args.length > 8
  )
    throw new HttpError(400, '本机调用无效')
  let args = body.args
  if (body.method === 'upload') {
    const [project, file, replace] = args
    args = [
      project,
      { name: file.name, data: decodeBase64(file.base64) },
      replace
    ]
  }
  let result: any = await Reflect.apply(
    (service as any)[body.method],
    service,
    args
  )
  if (body.method === 'original')
    result = { name: result.name, base64: result.data.toString('base64') }
  json(res, 200, result)
}
