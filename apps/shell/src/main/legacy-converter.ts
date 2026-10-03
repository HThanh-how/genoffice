export type LegacyConvertMode = 'off' | 'xls' | 'all'
export type LegacyConvertOutcome = 'converted' | 'skipped' | 'failed'

export interface LegacyConverterState {
  running: boolean
  pending: number
  converted: number
  failed: number
}

const EXTENSIONS: Record<Exclude<LegacyConvertMode, 'off'>, readonly string[]> = {
  xls: ['.xls'],
  all: ['.xls', '.doc', '.ppt'],
}

interface Deps {
  mode(): LegacyConvertMode
  /** indexed files with these extensions that are still in the old format */
  list(extensions: readonly string[], limit: number): string[]
  convert(path: string): Promise<LegacyConvertOutcome>
  /** battery, sleep or a locked screen: wait without converting */
  paused(): boolean
  wait(ms: number): Promise<void>
  onState?(state: LegacyConverterState): void
}

const PAUSE_MS = 30_000
const BETWEEN_FILES_MS = 400
const BATCH = 200

/**
 * Turns the old-format files of the index (.xls, and with the online converter .doc/.ppt) into
 * .xlsx/.docx/.pptx one at a time, in the background. Once a file is converted the original goes
 * to the recovery folder, so the index sees only the new file.
 */
export class LegacyConverter {
  private running = false
  private converted = 0
  private readonly failed = new Set<string>()
  /** not ready yet (recently changed): asked again on the next start */
  private readonly skipped = new Set<string>()
  /** converted in this run: the index may still list them until it notices the move */
  private readonly handled = new Set<string>()
  private pending = 0

  constructor(private readonly deps: Deps) {}

  state(): LegacyConverterState {
    return {
      running: this.running,
      pending: this.pending,
      converted: this.converted,
      failed: this.failed.size,
    }
  }

  /** Start (or continue) converting; safe to call as often as wanted. */
  kick(): void {
    if (this.running || this.deps.mode() === 'off') return
    this.running = true
    this.skipped.clear()
    void this.loop().finally(() => {
      this.running = false
      this.publish()
    })
  }

  private publish(): void {
    this.deps.onState?.(this.state())
  }

  private async loop(): Promise<void> {
    for (;;) {
      const mode = this.deps.mode()
      if (mode === 'off') return
      const todo = this.deps
        .list(EXTENSIONS[mode], BATCH)
        .filter(
          (path) => !this.failed.has(path) && !this.skipped.has(path) && !this.handled.has(path),
        )
      this.pending = todo.length
      this.publish()
      const next = todo[0]
      if (!next) return
      if (this.deps.paused()) {
        await this.deps.wait(PAUSE_MS)
        continue
      }
      let outcome: LegacyConvertOutcome
      try {
        outcome = await this.deps.convert(next)
      } catch {
        outcome = 'failed'
      }
      if (outcome === 'converted') {
        this.converted++
        this.handled.add(next)
      } else if (outcome === 'skipped') this.skipped.add(next)
      else this.failed.add(next)
      await this.deps.wait(BETWEEN_FILES_MS)
    }
  }
}
