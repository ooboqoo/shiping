import { submitDocument } from './submit'
import { buildGeneration } from '../library/generations'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Library } from '../library/repository'
import { analyzeLocalDocument } from '../document-import'
import { cleanPages } from './quality'
export class ProcessingJobs {
  private queue: Promise<unknown> = Promise.resolve()
  private controllers = new Map<string, AbortController>()
  private poll: ReturnType<typeof setInterval>
  constructor(
    private library: Library,
    private root: string,
    private afterApplied?: (project: string) => void
  ) {
    library.recoverJobs()
    this.poll = setInterval(() => {
      for (const j of library.queuedJobs()) this.enqueue(j.project_id, j.id)
    }, 1000)
    this.poll.unref()
  }
  private visible(job: any, report = true) {
    const { inputPath, ...info } = job.info
    void inputPath
    return { ...job, info, ...(!report ? { result: undefined } : {}) }
  }
  list(project: string) {
    return this.library
      .jobs(project)
      .slice(0, 100)
      .map((j) => this.visible(j, false))
  }
  get(project: string, id: string) {
    return this.visible(this.library.job(project, id))
  }
  async submit(
    project: string,
    docId: string | undefined,
    file: { name: string; data: Buffer },
    password?: string
  ) {
    const job = await submitDocument(this.library, this.root, project, file, docId)
    if (job.status === 'queued') this.enqueue(project, job.id, password)
    return this.visible(job, false)
  }
  private enqueue(project: string, id: string, password?: string) {
    if (!this.library.claimJob(project, id)) return Promise.resolve()
    const controller = new AbortController()
    this.controllers.set(id, controller)
    const task = this.queue.then(async () => {
      if (controller.signal.aborted) return
      const job = this.library.job(project, id)
      this.library.setJob(project, id, 'running')
      try {
        const buffer = await readFile(job.info.inputPath)
        if (createHash('sha256').update(buffer).digest('hex') !== job.info.sourceHash)
          throw Error('原件哈希不一致，文件可能已改变，请重新上传')
        const result = await analyzeLocalDocument(buffer, job.info.ext, controller.signal, password)
        result.sourceName = job.info.sourceName
        result.sourceHash = job.info.sourceHash
        if (!controller.signal.aborted && this.library.job(project, id).status !== 'cancelled')
          this.library.setJob(
            project,
            id,
            result.complete ? 'review' : 'failed',
            result,
            result.complete ? undefined : '部分页面失败，不能直接启用'
          )
      } catch (e) {
        if (!controller.signal.aborted)
          this.library.setJob(project, id, 'failed', undefined, String((e as Error).message || e))
      } finally {
        this.controllers.delete(id)
      }
    })
    this.queue = task.catch(() => {})
    return task
  }
  async original(project: string, id: string) {
    const job = this.library.job(project, id),
      data = await readFile(job.info.inputPath)
    if (createHash('sha256').update(data).digest('hex') !== job.info.sourceHash)
      throw Error('原件哈希不一致')
    return { name: job.info.sourceName, data }
  }
  cancel(project: string, id: string) {
    const job = this.library.job(project, id)
    if (!['queued', 'scheduled', 'running'].includes(job.status)) throw Error('任务已结束')
    this.controllers.get(id)?.abort()
    this.controllers.delete(id)
    return this.visible(this.library.setJob(project, id, 'cancelled'))
  }
  retry(project: string, id: string, password?: string) {
    const job = this.library.job(project, id)
    if (!['failed', 'cancelled', 'interrupted'].includes(job.status)) throw Error('此状态不能重试')
    if (password !== undefined && (typeof password !== 'string' || password.length > 256))
      throw Error('密码格式无效')
    const next = this.library.createJob(project, job.docId, {
      ...job.info,
      expectedVersion: this.library.get(project, job.docId).version
    })
    this.enqueue(project, next.id, password)
    return this.visible(next, false)
  }
  review(
    project: string,
    id: string,
    input: {
      disabledRules?: string[]
      text?: string
      acknowledged?: boolean
      version?: number
      excludedPages?: number[]
      exclusionReasons?: Record<string, string>
    }
  ) {
    const job = this.library.job(project, id)
    if (input.version !== job.updatedAt) throw Error('报告版本冲突，请刷新后重试')
    if (!['failed', 'review', 'ready'].includes(job.status) || !job.result?.pages?.length)
      throw Error('没有可复核的完整结果')
    if (
      input.disabledRules &&
      (!Array.isArray(input.disabledRules) ||
        input.disabledRules.some((r) => !['repeated-margin', 'join-line'].includes(r)))
    )
      throw Error('清洗规则无效')
    let pages = job.result.pages
    if (input.excludedPages) {
      if (
        !Array.isArray(input.excludedPages) ||
        input.excludedPages.some((n) => !pages.some((p: any) => p.number === n))
      )
        throw Error('排除页码无效')
      pages = pages.map((p: any) => {
        const excluded = input.excludedPages!.includes(p.number),
          reason = input.exclusionReasons?.[p.number] || p.exclusionReason
        if (excluded && (!reason || typeof reason !== 'string' || reason.length > 500))
          throw Error('排除页面必须填写原因')
        return { ...p, excluded, exclusionReason: excluded ? reason : undefined }
      })
    }
    const next = cleanPages(pages, input.disabledRules ?? job.result.disabledRules ?? [])
    next.sourceName = job.info.sourceName
    next.sourceHash = job.info.sourceHash
    if (input.text !== undefined) {
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2_000_000)
        throw Error('复核正文无效')
      if (input.text !== next.cleaned) {
        next.cleaned = input.text
        next.sources = []
        next.issues.push({
          code: 'manual-edit',
          severity: 'warning',
          reason: '人工修改正文后仅保留文档与页级来源，字符位置映射需重新核对'
        })
      }
    }
    return this.visible(
      this.library.setJob(
        project,
        id,
        input.acknowledged && next.complete ? 'ready' : 'review',
        next
      )
    )
  }
  apply(project: string, id: string, version: number) {
    const job = this.library.job(project, id)
    if (version !== job.updatedAt) throw Error('报告版本冲突，请刷新后重试')
    if (job.status !== 'ready') throw Error('请先确认复核结果')
    this.library.setJob(project, id, 'indexing')
    const task = this.queue
      .then(() => buildGeneration(this.library, project, id))
      .then((result) => {
        this.afterApplied?.(project)
        return result
      })
    this.queue = task.catch((e) => {
      this.library.setJob(project, id, 'ready', undefined, String((e as Error).message || e))
    })
    return this.get(project, id)
  }
  close() {
    clearInterval(this.poll)
    for (const c of this.controllers.values()) c.abort()
  }
}
