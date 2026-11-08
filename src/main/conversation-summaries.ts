export interface SummaryJob {
  id: number
  text: string
}

/** A best-effort, single-request cache. Foreground callers never await this queue. */
export class SummaryQueue {
  readonly summaries = new Map<number, string>()
  private jobs: SummaryJob[] = []
  private fingerprints = new Map<number, string>()
  private attempted = new Set<number>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private active: { job: SummaryJob; controller: AbortController; finish: () => void } | undefined
  private idleMs: number
  private timeoutMs: number

  constructor(
    private summarize: (text: string, signal: AbortSignal) => Promise<string>,
    options: { idleMs?: number; timeoutMs?: number } = {}
  ) {
    this.idleMs = options.idleMs ?? 1500
    this.timeoutMs = options.timeoutMs ?? 8000
  }

  sync(jobs: SummaryJob[]): void {
    this.jobs = jobs.slice(-20)
    const next = new Map(this.jobs.map((job) => [job.id, job.text]))
    if (this.active && next.get(this.active.job.id) !== this.active.job.text) this.pause()
    for (const [id, text] of this.fingerprints) {
      if (next.get(id) !== text) {
        this.summaries.delete(id)
        this.attempted.delete(id)
      }
    }
    this.fingerprints = next
    this.schedule()
  }

  pause(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.active) {
      const active = this.active
      this.active = undefined
      this.attempted.delete(active.job.id)
      active.controller.abort()
      active.finish()
    }
  }

  clear(): void {
    this.pause()
    this.jobs = []
    this.fingerprints.clear()
    this.summaries.clear()
    this.attempted.clear()
  }

  private schedule(): void {
    if (this.timer || this.active || !this.jobs.some((j) => !this.attempted.has(j.id))) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.run()
    }, this.idleMs)
  }

  private async run(): Promise<void> {
    const job = [...this.jobs].reverse().find((j) => !this.attempted.has(j.id))
    if (!job) return
    this.attempted.add(job.id)
    const controller = new AbortController()
    let finish!: () => void
    const interrupted = new Promise<string>((resolve) => {
      finish = () => resolve('')
    })
    const active = { job, controller, finish }
    this.active = active
    const timeout = setTimeout(() => {
      controller.abort()
      finish()
    }, this.timeoutMs)
    try {
      const text = await Promise.race([this.summarize(job.text, controller.signal), interrupted])
      if (
        this.active === active &&
        !controller.signal.aborted &&
        this.fingerprints.get(job.id) === job.text &&
        text.trim()
      )
        this.summaries.set(job.id, text.trim())
    } catch {
      // A summary is optional: no retries or notices on the hint's path.
    } finally {
      clearTimeout(timeout)
      if (this.active === active) {
        this.active = undefined
        this.schedule()
      }
    }
  }
}
