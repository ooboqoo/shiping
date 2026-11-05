/** One low-priority request at a time; foreground requests never await this queue. */
export class SummaryQueue {
  readonly summaries = new Map<number, string>()
  private pending = new Map<number, string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private paused = false
  private active: { id: number; input: string; controller: AbortController } | undefined

  constructor(
    private summarize: (input: string, signal: AbortSignal) => Promise<string>,
    private idleMs = 1500
  ) {}

  enqueue(id: number, input: string): void {
    this.summaries.delete(id)
    if (this.active?.id === id) this.pause()
    this.pending.set(id, input)
    // Memory is session-only and bounded; the UI keeps the full transcript separately.
    while (this.pending.size > 20) this.pending.delete(this.pending.keys().next().value!)
    this.schedule()
  }

  pause(): void {
    this.paused = true
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.active) {
      const task = this.active
      this.active = undefined
      task.controller.abort()
      if (!this.pending.has(task.id)) this.pending.set(task.id, task.input)
    }
  }

  resume(): void {
    this.paused = false
    this.schedule()
  }

  clear(): void {
    this.pause()
    this.pending.clear()
    this.summaries.clear()
  }

  invalidate(id: number): void {
    this.summaries.delete(id)
    this.pending.delete(id)
    if (this.active?.id === id) {
      this.active.controller.abort()
      this.active = undefined
    }
  }

  private schedule(): void {
    if (this.paused || this.active || this.timer || !this.pending.size) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.run()
    }, this.idleMs)
    this.timer.unref?.()
  }

  private async run(): Promise<void> {
    if (this.paused || this.active) return
    // Newest completed turn is the most likely to be needed next.
    const entry = [...this.pending.entries()].at(-1)
    if (!entry) return
    const [id, input] = entry
    this.pending.delete(id)
    const task = { id, input, controller: new AbortController() }
    this.active = task
    const timeout = setTimeout(() => task.controller.abort(), 8000)
    try {
      const summary = await this.summarize(input, task.controller.signal)
      if (this.active === task && !task.controller.signal.aborted && summary.trim()) {
        this.summaries.set(id, summary.trim())
        while (this.summaries.size > 20) this.summaries.delete(this.summaries.keys().next().value!)
      }
    } catch {
      // Missing summaries are omitted. Failure must not fail or delay a hint.
    } finally {
      clearTimeout(timeout)
      if (this.active === task) this.active = undefined
      this.schedule()
    }
  }
}
