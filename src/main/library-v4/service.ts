import {
  ModelProviders,
  embedModel,
  listProviderModels,
  normalizeModelConfig,
  type ModelConfig
} from './model-providers'
import { rerankCandidates, validateRerankConfig, type RerankConfig } from './reranker'
import { formatKnowledgePrompt } from '../../shared/knowledge-context'
import { uploadValue, decode } from './inputs'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  writeFileSync,
  lstatSync,
  unlinkSync,
  readFileSync,
  renameSync,
  chmodSync
} from 'node:fs'
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { Catalog } from './catalog'
import { EmbeddedVectorStore } from './vector-store'
import { AIClient } from './ai-client'
import { ChatCoordinator } from './chat'
import { IndexEngine, COLLECTIONS } from './indexing'
import { Retriever, type RetrievalConfig } from './retrieval'
import { canonicalMarkdown, digest, reportMarkdown, MARKDOWN_VERSION } from './markdown'
import { analyzeLocalDocument } from '../document-import'
import { cleanPages } from '../document-processing/quality'
import * as runtime from './runtime'
import type { ProcessingResult } from '../../shared/document-processing'
interface Options {
  ai?: AIClient
  io?: typeof runtime
  analyze?: typeof analyzeLocalDocument
  retrieval?: Partial<RetrievalConfig>
}
const BLOCKING = new Set([
  'layout-review',
  'column-order',
  'image-limit',
  'image-unresolved',
  'image-ocr-failed',
  'empty-ocr',
  'page-failed',
  'office-layout-review',
  'ocr-quality-review'
])
export class LibraryService {
  readonly catalog: Catalog
  readonly ai: AIClient
  readonly chat: ChatCoordinator
  private retrievalConfig: Partial<RetrievalConfig>
  private providers: ModelProviders
  private vectorStore?: EmbeddedVectorStore
  private io: typeof runtime
  private engine: IndexEngine
  private retriever: Retriever
  private timer: ReturnType<typeof setInterval>
  private running?: Promise<void>
  private closed = false
  private passwords = new Map<string, string>()
  private controllers = new Map<string, AbortController>()
  constructor(
    readonly root: string,
    private options: Options = {}
  ) {
    this.catalog = new Catalog(join(root, 'shiping.sqlite'))
    this.providers = new ModelProviders(root)
    if (options.io) this.io = options.io
    else {
      this.vectorStore = new EmbeddedVectorStore(join(root, 'vectors.sqlite'))
      this.vectorStore.migrate(this.catalog)
      this.io = { ...this.providers.io, request: this.vectorStore.request }
    }
    this.engine = new IndexEngine(this.catalog, this.io)
    const config =
      options.retrieval ||
      (existsSync(join(root, 'retrieval.json'))
        ? JSON.parse(readFileSync(join(root, 'retrieval.json'), 'utf8'))
        : {})
    if (existsSync(join(root, 'retrieval.json'))) chmodSync(join(root, 'retrieval.json'), 0o600)
    if (!config.reranker?.provider || config.reranker.provider === 'local')
      config.reranker = { ...config.reranker, enabled: false }
    this.retrievalConfig = config
    this.retriever = new Retriever(this.catalog, this.io, config)
    this.ai = options.ai || new AIClient(root)
    this.chat = new ChatCoordinator(
      this.catalog,
      (project, query, mode, signal, extra) =>
        this.retriever.retrieve(project, query, mode, signal, extra),
      this.ai
    )
    this.timer = setInterval(() => this.wake(), 200)
    this.timer.unref()
  }
  runtimeStatus() {
    return { version: 1, storage: 'sqlite-vectors', migration: this.vectorStore?.migrationStatus() }
  }
  modelStatus() {
    return this.ai.status()
  }
  configureModel(profile: any, source: 'desktop' | 'web' = 'desktop', version = randomUUID()) {
    return this.ai.configure(profile, source, version)
  }
  retrievalStatus() {
    return {
      reranker: this.retrievalConfig.reranker?.enabled === true,
      model: this.retrievalConfig.reranker?.model || ''
    }
  }
  configureRetrieval(enabled: boolean) {
    if (typeof enabled !== 'boolean') throw Error('精排开关无效')
    if (
      enabled &&
      (!this.retrievalConfig.reranker?.provider ||
        this.retrievalConfig.reranker.provider === 'local')
    )
      throw Error('请先在AI模型配置精排模型')
    const config = {
      ...this.retrievalConfig,
      reranker: { ...this.retrievalConfig.reranker, enabled }
    }
    const retriever = new Retriever(this.catalog, this.io, config)
    this.saveRetrieval(config)
    this.retrievalConfig = config
    this.retriever = retriever
    return this.retrievalStatus()
  }
  private saveRetrieval(config: Partial<RetrievalConfig>) {
    const file = join(this.root, 'retrieval.json')
    writeFileSync(file + '.tmp', JSON.stringify(config, null, 2), { mode: 0o600 })
    chmodSync(file + '.tmp', 0o600)
    renameSync(file + '.tmp', file)
  }
  providerStatus() {
    const { apiKey, ...rerank } = this.retrievalConfig.reranker || { enabled: false }
    return {
      embedding: this.providers.status(),
      rerank: {
        ...rerank,
        provider: rerank.provider || (rerank.url ? 'local' : 'siliconflow'),
        baseURL: rerank.baseURL || (rerank.url ? undefined : ''),
        model: rerank.model || '',
        hasApiKey: !!apiKey,
        configured: !!rerank.provider && rerank.provider !== 'local'
      }
    }
  }
  private resolveProvider(kind: string, value: ModelConfig): ModelConfig {
    if (!['embedding', 'rerank'].includes(kind)) throw Error('模型类型无效')
    if (kind === 'embedding') return this.providers.resolve(value)
    const c = normalizeModelConfig(value, kind, false)
    const previous = this.retrievalConfig.reranker
    if (
      value.apiKey === undefined &&
      previous?.provider === c.provider &&
      previous.baseURL === c.baseURL
    )
      c.apiKey = previous.apiKey
    return normalizeModelConfig(c, kind)
  }
  configureProvider(kind: string, value: ModelConfig | RerankConfig) {
    if (this.running || this.catalog.tasks().some((t) => t.status === 'running'))
      throw Error('后台正在处理资料，请稍后再修改模型配置')
    if (kind === 'embedding') {
      this.providers.configure(value as ModelConfig)
      this.wake()
    } else if (kind === 'rerank') {
      if (!value?.provider || value.provider === 'local') throw Error('请先在AI模型配置精排模型')
      const reranker: RerankConfig = validateRerankConfig({
        ...this.resolveProvider(kind, value as ModelConfig),
        enabled: this.retrievalConfig.reranker?.enabled === true
      })
      const config = { ...this.retrievalConfig, reranker }
      const retriever = new Retriever(this.catalog, this.io, config)
      this.saveRetrieval(config)
      this.retrievalConfig = config
      this.retriever = retriever
    } else throw Error('模型类型无效')
    return this.providerStatus()
  }
  async providerModels(kind: string, value: ModelConfig, signal?: AbortSignal) {
    return listProviderModels(
      this.resolveProvider(kind, { ...value, model: value?.model || '__list__' }),
      signal,
      fetch,
      kind
    )
  }
  async testProvider(kind: string, value: ModelConfig | RerankConfig, signal?: AbortSignal) {
    if (kind === 'embedding') {
      const vectors = await embedModel(
        this.resolveProvider(kind, value as ModelConfig),
        ['连接测试'],
        signal
      )
      return { ok: true, dimensions: vectors[0].length }
    }
    if (kind !== 'rerank') throw Error('模型类型无效')
    if (!value?.provider || value.provider === 'local') throw Error('请先在AI模型配置精排模型')
    const config: RerankConfig = {
      ...this.resolveProvider(kind, value as ModelConfig),
      enabled: true
    }
    const result = await rerankCandidates(
      '连接测试',
      [{ text: '连接测试' }, { text: '无关资料' }],
      config,
      signal
    )
    if (result.diagnostics.status !== 'applied')
      throw Error(result.diagnostics.error || '精排测试失败')
    return { ok: true }
  }
  private wake() {
    if (this.closed || this.running) return
    this.running = this.run(false)
      .catch(() => {})
      .finally(() => {
        this.running = undefined
      })
  }
  async drain() {
    if (this.running) await this.running
    await this.run(true)
  }
  private async run(force: boolean) {
    for (;;) {
      if (this.closed) return
      const now = Date.now(),
        job = this.catalog
          .tasks()
          .reverse()
          .find(
            (j) =>
              (j.status === 'queued' || (j.status === 'running' && j.lease <= now)) &&
              (j.kind !== 'index' || !!this.options.io || this.providers.isConfigured()) &&
              (force || j.kind !== 'index' || now - j.updated >= 400) &&
              !this.catalog.projectInfo(j.project, true).deletedAt &&
              (j.kind === 'purge-document' || !this.catalog.documentPurgeTask(j.project))
          )
      if (!job) return
      const owner = randomUUID()
      if (!this.catalog.claim(job.id, owner)) return
      const controller = new AbortController()
      this.controllers.set(job.id, controller)
      const heartbeat = setInterval(() => {
        if (!this.catalog.heartbeat(job.id, owner)) controller.abort()
      }, 5000)
      heartbeat.unref()
      try {
        if (job.kind === 'purge-document') {
          this.chat.cancelProject(job.project)
          await this.chat.waitProject(job.project)
          const result = await this.purgeDocument(
            job.project,
            job.payload.docId,
            job.payload.expectedVersion,
            controller.signal
          )
          this.catalog.finish(job.id, owner, 'done', result)
        } else if (job.kind === 'index') {
          const stats = await this.engine.build(
            job.project,
            job.payload.kind || 'incremental',
            controller.signal,
            { id: job.id, owner }
          )
          this.catalog.finish(job.id, owner, 'done', stats)
        } else if (job.kind === 'ingest' || job.kind === 'correction') {
          let report: ProcessingResult
          if (job.kind === 'correction') report = job.payload.report
          else {
            const data = await readFile(job.payload.sourcePath)
            if (digest(data.toString('base64')) !== job.payload.bytesHash)
              throw Error('原件校验失败，文件可能已经改变')
            report = reportMarkdown(
              await (this.options.analyze || analyzeLocalDocument)(
                data,
                job.payload.ext,
                controller.signal,
                this.passwords.get(job.id),
                (progress) => {
                  if (!this.catalog.taskProgress(job.id, owner, progress)) controller.abort()
                }
              ),
              job.payload.ext
            )
          }
          report.sourceName = job.payload.sourceName
          report.sourceHash = job.payload.sourceHash
          const blocking =
            !report.complete ||
            (job.kind !== 'correction' &&
              report.pages
                .filter((p) => !p.excluded)
                .some((p) => p.issues.some((i) => i.severity === 'error' || BLOCKING.has(i.code))))
          if (!canonicalMarkdown(report.cleaned).trim()) {
            this.catalog.finish(job.id, owner, 'needs_attention', report)
            continue
          }
          this.catalog.withLease(job.id, owner, () => {
            const current = this.catalog.get(job.project, job.payload.docId)
            this.catalog.projectInfo(job.project)
            if (current.deletedAt || current.version !== job.payload.expectedVersion)
              throw Error('资料已修改或移除，请刷新；原件未覆盖人工修改')
            const next = this.catalog.update(job.project, current.id, current.version, {
              text: canonicalMarkdown(report.cleaned),
              pending: false,
              modes: job.payload.desiredModes || current.modes,
              formatVersion: MARKDOWN_VERSION,
              processingTask: job.id,
              sourceHash: job.payload.sourceHash,
              sourcePath: job.payload.sourcePath,
              source: job.payload.sourceName,
              chars: report.cleaned.length,
              tokens: Math.ceil(report.cleaned.length * 0.8)
            })
            if (job.payload.sourceFileId)
              this.catalog.linkSource(next.revisionId, job.payload.sourceFileId)
            this.catalog.finish(job.id, owner, blocking ? 'needs_attention' : 'done', {
              ...report, indexedVersion: next.version
            })
            this.catalog.enqueue(job.project, 'index', { kind: 'incremental' })
          })
        } else throw Error('未知后台任务')
      } catch (error) {
        if (!controller.signal.aborted)
          this.catalog.finish(
            job.id,
            owner,
            'failed',
            undefined,
            Date.now(),
            String((error as Error).message || error)
              .split(this.passwords.get(job.id) || '\0')
              .join('[已隐藏]')
          )
      } finally {
        clearInterval(heartbeat)
        this.controllers.delete(job.id)
        this.passwords.delete(job.id)
      }
    }
  }
  projects(trash = false) {
    return this.catalog.projectList(trash).map((p) => ({
      ...p,
      kind: p.id === 'shiping' ? 'desktop' : 'managed',
      documents: this.catalog.list(p.id).length
    }))
  }
  createProject(name: string) {
    return this.catalog.atomic(() => {
      const title = this.catalog.projectName(name),
        id = randomUUID()
      this.catalog.project(id, title)
      return { ...this.catalog.projectInfo(id), kind: 'managed', documents: 0 }
    })
  }
  renameProject(project: string, name: unknown, version: string) {
    return this.catalog.renameProject(project, name, version)
  }
  private fields(input: any, partial = false): any {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('资料参数无效')
    const patch: any = {}
    if (!partial || input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80)
        throw Error('资料名称应为1至80字符')
      patch.name = input.name.trim()
    }
    if (!partial || input.text !== undefined) {
      if (typeof input.text !== 'string') throw Error('正文必须是Markdown文本')
      patch.text = canonicalMarkdown(input.text)
      patch.formatVersion = MARKDOWN_VERSION
      patch.pending = false
      patch.chars = patch.text.length
      patch.tokens = Math.ceil(patch.text.length * 0.8)
    }
    if (input.modes !== undefined) {
      if (
        !Array.isArray(input.modes) ||
        input.modes.some((m: any) => !['conversation', 'screenshot'].includes(m))
      )
        throw Error('使用模式无效')
      patch.modes = [...new Set(input.modes)]
    }
    if (input.tags !== undefined) {
      if (
        !Array.isArray(input.tags) ||
        input.tags.length > 10 ||
        input.tags.some((v: any) => typeof v !== 'string' || !v.trim() || v.length > 30)
      )
        throw Error('标签无效')
      patch.tags = [...new Set(input.tags)]
    }
    return patch
  }
  private visible(project: string, doc: any, text = true): any {
    const { sourcePath, storageFile, textHash, revisionId, ...visible } = doc
    void sourcePath
    void storageFile
    void textHash
    void revisionId
    const active = this.catalog.activeDocuments(project).find((d) => d.id === doc.id),
      jobs = this.catalog.tasks(project),
      ingest = jobs.find((j) => j.payload.docId === doc.id),
      index = jobs.find((j) => j.kind === 'index'),
      same = active?.activeVersion === doc.version
    const status = ingest?.status === 'needs_attention'
      ? 'needs_attention'
      : same
      ? 'ready'
      : ingest &&
          ['queued', 'running', 'needs_attention', 'failed', 'cancelled'].includes(ingest.status)
        ? (
            {
              queued: 'queued',
              running: 'parsing',
              needs_attention: 'needs_attention',
              failed: 'failed',
              cancelled: 'cancelled'
            } as any
          )[ingest.status]
        : index?.status === 'running'
          ? 'indexing'
          : index?.status === 'failed'
            ? 'failed'
            : 'waiting_index'
    if (!text) delete visible.text
    return {
      ...visible,
      hasOriginal: Boolean(doc.sourcePath),
      processingStatus: status,
      activeAvailable: Boolean(active),
      indexReady: Boolean(same),
      chars: doc.text.length,
      taskId: ingest?.id,
      purgeTask: jobs.find(
        (j) => j.kind === 'purge-document' && j.payload.docId === doc.id && j.status !== 'done'
      )
        ? this.taskView(
            jobs.find(
              (j) =>
                j.kind === 'purge-document' && j.payload.docId === doc.id && j.status !== 'done'
            )
          )
        : undefined
    }
  }
  list(project: string, options: { trash?: boolean; q?: string; text?: boolean } = {}) {
    this.catalog.projectInfo(project)
    return this.catalog
      .list(project, Boolean(options.trash))
      .filter(
        (d) =>
          !options.q ||
          `${d.name}\n${d.text}\n${(d.tags || []).join(' ')}`
            .toLowerCase()
            .includes(options.q.toLowerCase())
      )
      .map((d) => this.visible(project, d, Boolean(options.text)))
  }
  get(project: string, id: string) {
    this.catalog.projectInfo(project)
    return this.visible(project, this.catalog.get(project, id))
  }
  create(project: string, input: any) {
    this.catalog.projectInfo(project)
    const d = this.catalog.atomic(() => {
      const d = this.catalog.create(project, {
        ...this.fields(input),
        modes: input.modes || ['conversation', 'screenshot'],
        tags: input.tags || []
      })
      this.catalog.enqueue(project, 'index', { kind: 'incremental' })
      return d
    })
    this.wake()
    return this.visible(project, d)
  }
  update(project: string, id: string, input: any) {
    this.catalog.projectInfo(project)
    const d = this.catalog.atomic(() => {
      const d = this.catalog.update(project, id, input.version, this.fields(input, true))
      this.catalog.enqueue(project, 'index', { kind: 'incremental' })
      return d
    })
    this.wake()
    return this.visible(project, d)
  }
  trash(project: string, id: string, version: string) {
    this.catalog.projectInfo(project)
    const d = this.catalog.atomic(() => {
      const d = this.catalog.trash(project, id, version)
      for (const task of this.catalog.tasks(project).filter((j) => j.payload.docId === id)) {
        this.catalog.cancelTask(task.id)
        this.controllers.get(task.id)?.abort()
      }
      this.catalog.enqueue(project, 'index', { kind: 'incremental' })
      return d
    })
    this.wake()
    return this.visible(project, d)
  }
  restore(project: string, id: string, version: string) {
    this.catalog.projectInfo(project)
    const d = this.catalog.atomic(() => {
      const d = this.catalog.restore(project, id, version)
      this.catalog.enqueue(project, 'index', { kind: 'incremental' })
      return d
    })
    this.wake()
    return this.visible(project, d)
  }
  uploadReceipt(project: string, submissionId: string): any {
    this.catalog.projectInfo(project)
    const receipt = this.catalog.uploadRecord(project, submissionId),
      task = receipt ? this.catalog.task(receipt.job_id) : undefined
    return task
      ? {
          pending: task.status !== 'done',
          jobId: task.id,
          docId: task.payload.docId,
          status: task.status,
          reused: true
        }
      : undefined
  }
  async upload(
    project: string,
    file: { name: string; data: Buffer },
    replace?: { docId: string; version: string },
    submissionId?: string
  ) {
    this.catalog.projectInfo(project)
    const ext = uploadValue(file)
    const sourceHash = (await import('node:crypto'))
        .createHash('sha256')
        .update(file.data)
        .digest('hex'),
      sourcePath = join(this.root, 'originals', sourceHash + '.' + ext),
      ruleVersion = MARKDOWN_VERSION
    const remember = (result: any) => {
      if (submissionId)
        this.catalog.recordUpload(
          project,
          submissionId,
          sourceHash,
          file.name,
          result.docId,
          result.jobId
        )
      return result
    }
    if (submissionId) {
      const previous = this.uploadReceipt(project, submissionId)
      if (previous) {
        const receipt = this.catalog.uploadRecord(project, submissionId)
        if (
          receipt.source_hash !== sourceHash ||
          receipt.source_name !== file.name ||
          (replace && receipt.doc_id !== replace.docId)
        )
          throw Error('提交编号已用于其他文件')
        return previous
      }
    }
    if (!replace) {
      const existing = this.catalog.list(project).find((d) => d.sourceHash === sourceHash)
      if (existing) {
        const task = this.catalog
          .tasks(project)
          .find((j) => j.payload.docId === existing.id && j.payload.ruleVersion === ruleVersion)
        if (task)
          return remember({
            pending: task.status !== 'done',
            jobId: task.id,
            docId: existing.id,
            status: task.status,
            reused: true
          })
      }
    }
    await mkdir(dirname(sourcePath), { recursive: true, mode: 0o700 })
    try {
      await writeFile(sourcePath, file.data, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const saved = await readFile(sourcePath)
      if (!saved.equals(file.data)) throw Error('原件哈希冲突或文件损坏')
    }
    const result = this.catalog.atomic(() => {
      this.catalog.projectInfo(project)
      if (submissionId) {
        const previous = this.uploadReceipt(project, submissionId)
        if (previous) {
          const receipt = this.catalog.uploadRecord(project, submissionId)
          if (
            receipt.source_hash !== sourceHash ||
            receipt.source_name !== file.name ||
            (replace && receipt.doc_id !== replace.docId)
          )
            throw Error('提交编号已用于其他文件')
          return previous
        }
      }
      if (!replace) {
        const existing = this.catalog.list(project).find((d) => d.sourceHash === sourceHash)
        if (existing) {
          const task = this.catalog
            .tasks(project)
            .find((j) => j.payload.docId === existing.id && j.kind === 'ingest')
          if (task)
            return remember({
              pending: task.status !== 'done',
              jobId: task.id,
              docId: existing.id,
              status: task.status,
              reused: true
            })
        }
      }
      const doc = replace
        ? this.catalog.get(project, replace.docId)
        : this.catalog.create(project, {
            name: basename(file.name, extname(file.name)).slice(0, 80),
            text: '文件正在后台处理，尚未启用。',
            modes: [],
            tags: [],
            pending: true,
            sourceHash,
            sourcePath,
            source: file.name
          })
      if (doc.deletedAt || (replace && doc.version !== replace.version))
        throw Error('资料已修改或移除')
      if (!existsSync(sourcePath)) writeFileSync(sourcePath, file.data, { flag: 'wx', mode: 0o600 })
      if (lstatSync(sourcePath).isSymbolicLink()) throw Error('原件不能为符号链接')
      const sourceFileId = this.catalog.registerSource(
          project,
          sourceHash,
          file.name,
          sourcePath,
          file.data.length
        ),
        task = this.catalog.enqueue(project, 'ingest', {
          docId: doc.id,
          expectedVersion: doc.version,
          sourceName: file.name,
          sourcePath,
          sourceHash,
          sourceFileId,
          bytesHash: digest(file.data.toString('base64')),
          ext,
          ruleVersion,
          ...(submissionId ? { submissionId } : {}),
          ...(doc.pending ? { desiredModes: ['conversation', 'screenshot'] } : {})
        })
      return remember({ pending: true, jobId: task.id, docId: doc.id })
    })
    this.wake()
    return result
  }
  fullContext(project: string, mode: string) {
    return formatKnowledgePrompt(this.active(project, mode))
  }
  active(project: string, mode?: string) {
    return this.catalog.activeDocuments(project, mode)
  }
  scheduleIndex(project: string, kind: 'incremental' | 'full' = 'incremental') {
    if (!['incremental', 'full'].includes(kind)) throw Error('索引模式无效')
    const task = this.catalog.enqueue(project, 'index', { kind })
    this.wake()
    return task
  }
  status(project: string) {
    this.catalog.projectInfo(project)
    const tasks = this.catalog.tasks(project),
      last = tasks.find((j) => j.kind === 'index'),
      gen = this.catalog.generation(project),
      missingVectors = gen && this.vectorStore ? this.vectorStore.coverage(gen).missing : 0
    return {
      state:
        last?.status === 'running' || last?.status === 'queued'
          ? 'indexing'
          : last?.status === 'failed'
            ? 'error'
            : gen
              ? 'ready'
              : 'idle',
      message:
        !this.options.io && !this.providers.isConfigured() && last?.status === 'queued'
          ? '请先配置Embedding模型，资料将在配置后自动向量化'
          : last?.error ||
            (missingVectors
              ? `活动向量不完整（缺少${missingVectors}条），当前检索已降级，请重建索引`
              : '后台自动处理'),
      documents: this.catalog.list(project).length,
      chunks: gen?.chunks.length || 0,
      lastTask: last?.id,
      lastResult: last?.result
    }
  }
  private taskView(job: any) {
    const { sourcePath, bytesHash, ...payload } = job.payload
    void sourcePath
    void bytesHash
    return { ...job, payload, owner: undefined }
  }
  tasks(project: string) {
    this.catalog.projectInfo(project)
    return this.catalog
      .tasks(project)
      .slice(0, 100)
      .map((j) => this.taskView(j))
  }
  task(project: string, id: string) {
    this.catalog.projectInfo(project)
    const job = this.catalog.task(id)
    if (job.project !== project) throw Error('任务不存在')
    return this.taskView(job)
  }
  cancel(project: string, id: string) {
    if (this.task(project, id).kind === 'purge-document')
      throw Error('永久清理开始后不能取消，请重试至完成')
    this.catalog.cancelTask(id)
    this.controllers.get(id)?.abort()
    this.passwords.delete(id)
    return this.task(project, id)
  }
  retry(project: string, id: string, password?: string) {
    if (password !== undefined && (typeof password !== 'string' || password.length > 1024))
      throw Error('文件密码格式无效')
    this.task(project, id)
    const job = this.catalog.task(id)
    if (job.kind === 'purge-document')
      return this.scheduleDocumentPurge(
        project,
        job.payload.docId,
        job.payload.expectedVersion,
        true
      )
    if (!['failed', 'cancelled'].includes(job.status)) throw Error('当前状态不能重试')
    if (
      job.payload.docId &&
      this.catalog.get(project, job.payload.docId).version !== job.payload.expectedVersion
    )
      throw Error('资料已修改，请明确重新解析原件，不覆盖人工修改')
    const next = this.catalog.enqueue(project, job.kind, job.payload)
    if (password) this.passwords.set(next.id, password)
    this.wake()
    return this.taskView(next)
  }
  resolve(project: string, id: string, input: any) {
    this.task(project, id)
    const job = this.catalog.task(id)
    if (!['needs_attention', 'failed'].includes(job.status) || !job.result)
      throw Error('没有可修正的报告')
    if (input.version !== job.updated) throw Error('报告版本冲突')
    let report = job.result as ProcessingResult
    if (input.excludedPages) {
      if (
        !Array.isArray(input.excludedPages) ||
        input.excludedPages.some((n: number) => !report.pages.some((p) => p.number === n))
      )
        throw Error('排除页码无效')
      report = reportMarkdown(
        cleanPages(
          report.pages.map((p) => {
            const excluded = input.excludedPages.includes(p.number),
              reason = input.exclusionReasons?.[p.number]
            if (excluded && (typeof reason !== 'string' || !reason.trim() || reason.length > 500))
              throw Error('排除页需填写原因')
            return { ...p, excluded, exclusionReason: reason }
          })
        ),
        job.payload.ext
      )
    }
    if (input.text !== undefined) {
      report = { ...report, cleaned: canonicalMarkdown(input.text), sources: [] }
    }
    if (!report.complete || input.acknowledged !== true) throw Error('请处理失败页面并确认核对原件')
    const next = this.catalog.enqueue(project, 'correction', {
      ...this.catalog.task(id).payload,
      expectedVersion: (job.result as any).indexedVersion || job.payload.expectedVersion,
      report
    })
    this.wake()
    return this.taskView(next)
  }
  chunks(project: string, id: string, offset = 0, limit = 50) {
    this.get(project, id)
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw Error('分页无效')
    const chunks = this.catalog.generation(project)?.chunks.filter((c: any) => c.docId === id) || []
    return { total: chunks.length, items: chunks.slice(offset, offset + limit) }
  }
  async taskOriginal(project: string, id: string) {
    this.task(project, id)
    const task = this.catalog.task(id)
    if (
      !task.payload.sourcePath ||
      dirname(task.payload.sourcePath) !== join(this.root, 'originals')
    )
      throw Error('任务原件不存在')
    return { name: task.payload.sourceName, data: await readFile(task.payload.sourcePath) }
  }
  async reparse(project: string, id: string, version: string, confirm: boolean) {
    if (confirm !== true) throw Error('重新解析原件需要确认')
    const file = await this.original(project, id)
    await this.upload(project, file, { docId: id, version })
    return { doc: this.get(project, id) }
  }
  searchDetails(project: string, query: string, mode = 'conversation', signal?: AbortSignal) {
    return this.retriever.retrieve(project, query, mode, signal)
  }
  async search(project: string, query: string, mode = 'conversation', signal?: AbortSignal) {
    return (await this.searchDetails(project, query, mode, signal)).hits
  }
  async original(project: string, id: string) {
    this.catalog.projectInfo(project)
    const doc = this.catalog.get(project, id)
    if (!doc.sourcePath) return { name: doc.name + '.md', data: Buffer.from(doc.text) }
    if (dirname(doc.sourcePath) !== join(this.root, 'originals'))
      throw Error('原件路径不属于资料目录')
    if ((await lstat(doc.sourcePath)).isSymbolicLink()) throw Error('原件不能为符号链接')
    return { name: doc.source || doc.name, data: await readFile(doc.sourcePath) }
  }
  markdown(project: string, id: string, active = false) {
    const d = active ? this.active(project).find((d) => d.id === id) : this.get(project, id)
    if (!d) throw Error('资料尚无已启用版本')
    return {
      name: d.name.replace(/[\\/]/g, '_') + '.md',
      data: Buffer.from(canonicalMarkdown(d.text))
    }
  }
  projectTrash(project: string, version: string) {
    const result = this.catalog.setProjectState(project, version, true)
    this.chat.cancelProject(project)
    for (const task of this.catalog.tasks(project)) this.controllers.get(task.id)?.abort()
    return result
  }
  projectRestore(project: string, version: string) {
    const result = this.catalog.setProjectState(project, version, false)
    this.scheduleIndex(project)
    return result
  }
  clearProject(project: string, version: string) {
    const batch = this.catalog.clearProject(project, version)
    this.chat.cancelProject(project)
    for (const task of this.catalog.tasks(project)) this.controllers.get(task.id)?.abort()
    this.scheduleIndex(project)
    return { batch }
  }
  restoreClear(project: string, batch: string) {
    this.catalog.restoreClear(project, batch)
    this.scheduleIndex(project)
    return this.catalog.projectInfo(project)
  }
  async rollback(project: string, id: string, confirm: boolean) {
    if (confirm !== true) throw Error('回退需明确确认')
    const state = this.catalog.projectInfo(project),
      target = this.catalog.generation(project, id),
      io = this.io
    if (!target || !this.catalog.generationInfo(id) || target.status !== 'ready')
      throw Error('历史版本不可用')
    if ((await io.fingerprint()) !== target.fingerprint) throw Error('模型指纹变化，请重建索引')
    const remote = await io.request<any>(`${COLLECTIONS}/${target.collection}`)
    const keys = [...new Set<string>(target.chunks.map((c: any) => c.vectorKey))]
    for (let offset = 0; offset < keys.length; offset += 500) {
      const result = await io.request<any>(`${COLLECTIONS}/${remote.id}/get`, {
        ids: keys.slice(offset, offset + 500),
        include: []
      })
      if (result.ids?.length !== Math.min(500, keys.length - offset))
        throw Error('历史向量不完整，请重建')
    }
    this.catalog.atomic(() => {
      if (this.catalog.projectInfo(project).version !== state.version) throw Error('知识库发生变化')
      for (const task of this.catalog.tasks(project)) {
        this.catalog.cancelTask(task.id)
        this.controllers.get(task.id)?.abort()
      }
      this.catalog.rollbackGeneration(project, id)
      for (const doc of [...this.catalog.list(project), ...this.catalog.list(project, true)])
        if (doc.sourceFileId) this.catalog.linkSource(doc.revisionId, String(doc.sourceFileId))
      this.catalog.enqueue(project, 'index', { kind: 'incremental' })
    })
    this.wake()
    return { active: id }
  }
  async backup(project: string) {
    const documents: any[] = []
    let bytes = 0
    for (const doc of [
      ...this.list(project, { text: true }),
      ...this.list(project, { trash: true, text: true })
    ]) {
      const file = doc.hasOriginal ? await this.original(project, doc.id) : undefined
      const original = file ? { name: file.name, base64: file.data.toString('base64') } : undefined
      bytes += Buffer.byteLength(JSON.stringify({ ...doc, original }))
      if (bytes > 45 * 1024 * 1024) throw Error('备份超过45MB，请停止服务后完整备份')
      documents.push({ ...doc, ...(original ? { original } : {}) })
    }
    return {
      format: 'local-rag-backup',
      version: 1,
      project: { name: this.catalog.projectInfo(project).name },
      documents
    }
  }
  async importBackup(project: string, backup: any) {
    this.catalog.projectInfo(project)
    if (
      backup?.format !== 'local-rag-backup' ||
      !Array.isArray(backup.documents) ||
      backup.documents.length > 5000
    )
      throw Error('备份格式无效')
    const inputs = backup.documents.map((d: any) => {
      const fields = this.fields(d),
        original = d.original
          ? { name: d.original.name, data: decode(d.original.base64) }
          : undefined
      if (original) uploadValue(original)
      return { fields, original, deletedAt: d.deletedAt ? Date.now() : undefined }
    })
    const crypto = await import('node:crypto')
    for (const input of inputs) {
      if (input.original) {
        const file = input.original,
          sourceHash = crypto.createHash('sha256').update(file.data).digest('hex'),
          sourcePath = join(this.root, 'originals', sourceHash + '.' + uploadValue(file))
        await mkdir(dirname(sourcePath), { recursive: true, mode: 0o700 })
        Object.assign(input.fields, { source: file.name, sourceHash, sourcePath })
      }
    }
    const added = this.catalog.atomic(() =>
      inputs.map((input: any) => {
        if (input.original) {
          const { sourcePath, sourceHash, source } = input.fields
          if (!existsSync(sourcePath))
            writeFileSync(sourcePath, input.original.data, { flag: 'wx', mode: 0o600 })
          if (lstatSync(sourcePath).isSymbolicLink()) throw Error('原件不能为符号链接')
          const saved = readFileSync(sourcePath)
          if (!saved.equals(input.original.data)) throw Error('原件校验失败')
          input.fields.sourceFileId = this.catalog.registerSource(
            project,
            sourceHash,
            source,
            sourcePath,
            saved.length
          )
        }
        const doc = this.catalog.create(project, {
          ...input.fields,
          modes: input.fields.modes || ['conversation', 'screenshot'],
          tags: input.fields.tags || [],
          deletedAt: input.deletedAt
        })
        if (input.fields.sourceFileId)
          this.catalog.linkSource(doc.revisionId, input.fields.sourceFileId)
        return doc
      })
    )
    this.scheduleIndex(project)
    return { added: added.length }
  }
  scheduleDocumentPurge(project: string, id: string, version: string, confirm: boolean) {
    if (confirm !== true) throw Error('永久删除需要明确确认')
    this.catalog.documentPurgePlan(project, id, version)
    const existing = this.catalog.documentPurgeTask(project, id)
    if (existing) {
      if (existing.status === 'failed') this.catalog.requeueDocumentPurge(existing.id)
      this.wake()
      return this.task(project, existing.id)
    }
    const job = this.catalog.enqueue(project, 'purge-document', {
      docId: id,
      expectedVersion: version
    })
    for (const other of this.catalog
      .tasks(project)
      .filter((j) => j.id !== job.id && j.payload.docId === id)) {
      this.catalog.cancelTask(other.id)
      this.controllers.get(other.id)?.abort()
    }
    this.wake()
    return this.task(project, job.id)
  }
  private async purgeDocument(project: string, id: string, version: string, signal: AbortSignal) {
    const plan = this.catalog.documentPurgePlan(project, id, version),
      io = this.io
    for (const collection of plan.collections) {
      signal.throwIfAborted()
      let remote: any
      try {
        remote = await io.request<any>(`${COLLECTIONS}/${collection.name}`, undefined, signal)
      } catch (e) {
        if (/HTTP\s*404/.test(String(e))) continue
        throw e
      }
      for (let offset = 0; offset < collection.ids.length; offset += 500) {
        const ids = collection.ids.slice(offset, offset + 500)
        await io.request(`${COLLECTIONS}/${remote.id}/delete`, { ids }, signal)
        const found = await io.request<any>(
          `${COLLECTIONS}/${remote.id}/get`,
          { ids, include: ['metadatas'] },
          signal
        )
        if (found.ids?.length) throw Error('向量删除校验未通过，请重试')
      }
    }
    signal.throwIfAborted()
    return this.catalog.deleteDocumentRecords(project, id, version, (paths) => {
      for (const file of paths) {
        if (dirname(file) !== join(this.root, 'originals')) throw Error('原件归属不明确，停止清理')
        try {
          if (lstatSync(file).isSymbolicLink()) throw Error('拒绝删除符号链接原件')
          unlinkSync(file)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        }
      }
    })
  }
  purgePreview(project: string) {
    const { paths, collections, ...info } = this.catalog.purgePlan(project)
    return {
      ...info,
      originalFiles: paths.length,
      collections: collections.map((c) => c.name),
      backupsRetained: true
    }
  }
  async purge(project: string, input: { version: string; confirm: boolean }) {
    if (input.confirm !== true) throw Error('永久删除需要明确确认')
    const plan = this.catalog.purgePlan(project)
    if (plan.version !== input.version) throw Error('知识库版本冲突')
    this.catalog.beginPurge(project, input.version)
    try {
      for (const collection of plan.collections) {
        try {
          await this.io.request(`${COLLECTIONS}/${collection.name}`, undefined, undefined, 'DELETE')
        } catch (e) {
          if (!/HTTP 404/.test(String(e))) throw e
        }
      }
      for (const file of plan.paths)
        this.catalog.atomic(() => {
          if (!this.catalog.purgePlan(project).paths.includes(file)) return
          if (dirname(file) !== join(this.root, 'originals'))
            throw Error('原件归属不明确，停止清理')
          try {
            if (lstatSync(file).isSymbolicLink()) throw Error('拒绝删除符号链接原件')
            unlinkSync(file)
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
          }
        })
      this.catalog.purgeRecords(project, input.version)
      return { deleted: true, backupsRetained: true }
    } catch (error) {
      return { deleted: false, pending: true, error: String((error as Error).message || error) }
    }
  }
  async close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    await this.chat.close()
    for (const c of this.controllers.values()) c.abort()
    await this.running?.catch(() => {})
    this.passwords.clear()
    this.vectorStore?.close()
    this.catalog.close()
  }
}
