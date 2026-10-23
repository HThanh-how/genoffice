import type { WorkerReply, WorkerRequest } from '../worker-types'
import type { SourceRecoveryPage } from '../storage/repositories/ocr-source-recovery-repository'
import { rootAvailability } from '../root-availability'

/** Startup, existing idle opportunities and scan/retry signals share a single resumable traversal. */
export class OcrSourceRecovery {
  private afterId = 0
  private done = false
  private running = false
  private restart = false
  private manual = false
  private clearCloud: ((paths: string[]) => boolean) | undefined
  private readonly stopRoots: () => void

  constructor(
    private readonly deps: {
      ask(request: WorkerRequest): Promise<WorkerReply | null>
      isActive(): boolean
      enqueue(path: string): void
      wake?(): void
      hasWork?(manual: boolean): boolean
    },
  ) {
    this.stopRoots = rootAvailability.onRecovered((root) => {
      this.trigger(root)
      this.deps.wake?.()
    })
  }

  dispose(): void {
    this.stopRoots()
  }

  subscribe(clear: (paths: string[]) => boolean): () => void {
    this.clearCloud = clear
    this.trigger()
    return () => {
      if (this.clearCloud === clear) this.clearCloud = undefined
    }
  }

  trigger(root?: string, manual = false): void {
    // Signals coalesce while work is in flight. A final global pass covers concurrent roots.
    this.restart = true
    this.manual ||= manual
    void this.run(root)
  }

  async run(root?: string, manual = false): Promise<void> {
    if (this.running || !this.deps.isActive()) return
    if (this.restart) {
      this.afterId = 0
      this.done = false
      this.restart = false
    }
    if (this.done) return
    if (this.deps.hasWork && !this.deps.hasWork(this.manual || manual)) {
      this.done = true
      this.manual = false
      this.clearCloud?.([])
      return
    }
    this.running = true
    this.manual ||= manual
    try {
      do {
        await rootAvailability.probeDue(this.manual && this.afterId === 0)
        if (!this.deps.isActive()) return
        const reply = await this.deps.ask({
          type: 'ocr-source-recovery',
          afterId: this.afterId,
          root,
          roots: rootAvailability.configuredRoots(),
          rootStates: rootAvailability.snapshot(),
          manual: this.manual,
        })
        const page = reply && 'result' in reply ? (reply.result as SourceRecoveryPage) : null
        if (
          !page ||
          !Array.isArray(page.paths) ||
          !Array.isArray(page.cloudPaths) ||
          typeof page.done !== 'boolean' ||
          !Number.isSafeInteger(page.afterId) ||
          (!page.done && page.afterId <= this.afterId)
        )
          return
        for (const path of page.paths) this.deps.enqueue(path)
        for (const state of page.roots ?? []) {
          const previous = rootAvailability.snapshot().find((s) => s.root === state.root)
          if (!previous || previous.online !== state.online)
            rootAvailability.observe(state.root, state.online)
        }
        // Persist cloud state before acknowledging the durable handoff.
        if (page.cloudPaths.length && this.clearCloud) {
          if (!this.clearCloud(page.cloudPaths)) return
          const ack = await this.deps.ask({
            type: 'ocr-source-recovery-ack',
            paths: page.cloudPaths,
          })
          if (!ack || !('result' in ack)) return
        }
        this.afterId = page.afterId
        this.done = page.done && (page.cloudPaths.length === 0 || !this.clearCloud)
        if (this.done && !page.cloudPaths.length) this.clearCloud?.([])
        if (this.restart) {
          this.afterId = 0
          this.done = false
          this.restart = false
          root = undefined
        }
        await new Promise<void>((resolve) => setImmediate(resolve))
      } while (!this.done && this.deps.isActive())
    } catch {
      // Existing idle / write-ready opportunities resume after worker recycling.
    } finally {
      this.running = false
      if (this.done) this.manual = false
    }
  }
}
