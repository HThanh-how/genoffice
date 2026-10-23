import type { WorkerReply, WorkerRequest } from '../worker-types'
import type { OcrRecoveryPage } from '../storage/repositories/ocr-recovery-repository'

/** One bounded traversal per manager lifetime, resumed after pause; uses the existing extraction lane. */
export class CachedOcrRecovery {
  private afterId = 0
  private done = false
  private running = false

  constructor(
    private readonly deps: {
      ask(request: WorkerRequest): Promise<WorkerReply | null>
      isActive(): boolean
      enqueue(path: string): void
    },
  ) {}

  async run(): Promise<void> {
    if (this.done || this.running || !this.deps.isActive()) return
    this.running = true
    try {
      while (!this.done && this.deps.isActive()) {
        const reply = await this.deps.ask({ type: 'ocr-reconcile-page', afterId: this.afterId })
        if (!this.deps.isActive()) return
        const page = reply && 'result' in reply ? (reply.result as OcrRecoveryPage) : null
        if (
          !page ||
          !Array.isArray(page.paths) ||
          typeof page.done !== 'boolean' ||
          !Number.isSafeInteger(page.afterId) ||
          (!page.done && page.afterId <= this.afterId)
        )
          return
        for (const path of page.paths) this.deps.enqueue(path)
        this.afterId = page.afterId
        this.done = page.done
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    } catch {
      // A recycled worker is retried from this cursor on the next existing maintenance opportunity.
    } finally {
      this.running = false
    }
  }
}
