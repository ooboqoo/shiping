import type { Catalog } from './catalog'
import type { AIClient } from './ai-client'
import { planQuery } from './query-planner'
type Search = (
  project: string,
  query: string,
  mode: string,
  signal?: AbortSignal,
  options?: { queries?: string[] }
) => Promise<any>
export interface TurnInput {
  requestId: string
  question: string
  rewrite?: boolean
  useKnowledge?: boolean
  retrievalOnly?: boolean
  mode?: string
}
export class ChatCoordinator {
  private active = new Map<
    string,
    {
      controller: AbortController
      project: string
      session: string
      finished: Promise<void>
      resolve: () => void
    }
  >()
  private closed = false
  constructor(
    private catalog: Catalog,
    private search: Search,
    readonly ai: AIClient
  ) {
    catalog.chat.recover()
  }
  cancelProject(project: string) {
    for (const row of this.active.values())
      if (row.project === project)
        row.controller.abort(new DOMException('知识库已变更', 'AbortError'))
  }
  async waitProject(project: string) {
    await Promise.all(
      [...this.active.values()].filter((row) => row.project === project).map((row) => row.finished)
    )
  }
  stop(project: string, session: string, id: string) {
    this.catalog.chat.turn(project, session, id)
    const active = this.active.get(id)
    if (active) active.controller.abort(new DOMException('回答已停止', 'AbortError'))
    return { stopped: Boolean(active) }
  }
  async *run(
    project: string,
    session: string,
    input: TurnInput,
    signal?: AbortSignal
  ): AsyncGenerator<any> {
    if (this.closed) throw Error('后台已关闭')
    if (this.catalog.documentPurgeTask(project)) throw Error('知识库正在永久清理资料，请稍后提问')
    const useKnowledge = input.useKnowledge !== false
    const mode = input.mode || 'conversation'
    if (!['conversation', 'screenshot'].includes(mode)) throw Error('检索模式无效')
    if ((!input.retrievalOnly || !useKnowledge) && !this.ai.status().configured)
      throw Error('尚未配置问答模型，请先在设置中连接模型')
    const turn = this.catalog.chat.begin(project, session, input.requestId, input.question)
    if (turn.replay) {
      yield {
        type: turn.status === 'running' ? 'pending' : 'done',
        turnId: turn.id,
        turn,
        replay: true
      }
      return
    }
    const controller = new AbortController(),
      combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
    let resolve!: () => void
    const finished = new Promise<void>((r) => {
      resolve = r
    })
    this.active.set(turn.id, { controller, project, session, finished, resolve })
    let answer = '',
      payload: any = { mode, useKnowledge, sources: [], diagnostics: {} },
      lastSaved = 0
    const fresh = () => {
      combined.throwIfAborted()
      this.catalog.projectInfo(project)
      if (!useKnowledge) return
      const live = new Map(this.catalog.activeDocuments(project, mode).map((d) => [d.id, d]))
      if (payload.sources.some((s: any) => live.get(s.docId)?.textHash !== s.revision))
        throw new DOMException('参考资料已变更，请重新提问', 'AbortError')
    }
    try {
      yield { type: 'start', turnId: turn.id }
      const history = this.catalog.chat.history(project, session)
      let context = ''
      if (useKnowledge) {
        const plan = await planQuery(
          input.question,
          history,
          this.ai,
          input.rewrite !== false && !input.retrievalOnly,
          combined
        )
        combined.throwIfAborted()
        const result = await this.search(project, input.question, mode, combined, {
          queries: plan.queries
        })
        context = result.context
        payload = {
          mode,
          useKnowledge,
          retrievalOnly: input.retrievalOnly === true,
          sources: result.evidence,
          diagnostics: { ...result.diagnostics, queryPlan: plan.diagnostics }
        }
      }
      fresh()
      this.catalog.chat.update(turn.id, answer, payload)
      yield { type: 'meta', turnId: turn.id, ...payload }
      const stream =
        useKnowledge && input.retrievalOnly
          ? (async function* () {
              yield context
            })()
          : useKnowledge && !payload.sources.length
            ? (async function* () {
                yield '知识库中没有检索到足够的相关依据，请补充资料或换一种问法。'
              })()
            : this.ai.answer(
                [...history, { role: 'user', content: input.question }],
                context,
                combined,
                useKnowledge
              )
      for await (const delta of stream) {
        fresh()
        answer += delta
        if (answer.length > 32000) throw Error('回答超出长度限制')
        if (Date.now() - lastSaved > 400) {
          this.catalog.chat.update(turn.id, answer, payload)
          lastSaved = Date.now()
        }
        yield { type: 'token', turnId: turn.id, text: delta }
      }
      fresh()
      if (useKnowledge)
        answer = answer.replace(/\[(\d{1,3})\]/g, (match, n) =>
          payload.sources.some((s: any) => s.number === Number(n)) ? match : '[引用无效]'
        )
      this.catalog.chat.finish(turn.id, 'completed', answer, payload)
      yield {
        type: 'done',
        turnId: turn.id,
        turn: this.catalog.chat.turn(project, session, turn.id)
      }
    } catch (e) {
      const interrupted = combined.aborted || (e as Error).name === 'AbortError',
        message = interrupted
          ? '回答已中断；已生成的内容仅保留为记录，请重新提问'
          : '问答处理失败，请检查模型、索引或服务后重试'
      this.catalog.chat.finish(
        turn.id,
        interrupted ? 'interrupted' : 'failed',
        answer,
        payload,
        message
      )
      yield {
        type: 'error',
        turnId: turn.id,
        status: interrupted ? 'interrupted' : 'failed',
        message
      }
    } finally {
      this.catalog.chat.finish(turn.id, 'interrupted', answer, payload, '回答连接已关闭')
      this.active.delete(turn.id)
      resolve()
    }
  }
  async close() {
    this.closed = true
    for (const row of this.active.values()) row.controller.abort()
    await Promise.all([...this.active.values()].map((r) => r.finished))
  }
}
