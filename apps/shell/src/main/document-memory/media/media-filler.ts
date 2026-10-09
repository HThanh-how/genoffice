import type { DatabaseSync } from 'node:sqlite'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { readMediaMetadata } from './media-reader'
import { pendingMediaBatch, saveMediaMetadata, type PendingMedia } from './media-repository'
import type { MediaKind, MediaMetadata } from './media-types'

export interface MediaFillerOptions {
  /** Reads one file's header (default: the real bounded reader). */
  read?: (path: string, kind: MediaKind) => Promise<MediaMetadata | null>
  /** False pauses work (app stopped / indexing disabled); pending rows simply wait. */
  shouldRun?: () => boolean
  batchSize?: number
  concurrency?: number
  /** Debounce between `kick()` and the first read. */
  delayMs?: number
}

/**
 * Fills width/height/duration/date of media rows in the background: asynchronous positioned reads
 * (never on the enrollment path, never the whole file), a few files at a time, one short write
 * transaction per batch and a yield to the event loop between batches. Enrolling a photo therefore
 * costs no file IO at all; its header is read once, here, and again only after the file changes.
 */
export class MediaMetadataFiller {
  private running: Promise<number> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  lastError: string | undefined

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: MediaFillerOptions = {},
  ) {}

  /** Ask for a pass soon; calls while a pass is scheduled or running are free. */
  kick(): void {
    if (this.stopped || this.timer || this.running) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
    }, this.options.delayMs ?? 100)
    this.timer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Read every pending header; resolves with how many rows were filled (tests and shutdown flushes). */
  drain(): Promise<number> {
    if (this.stopped) return Promise.resolve(0)
    this.running ??= this.run().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async run(): Promise<number> {
    const read = this.options.read ?? ((path: string, kind: MediaKind) => readMediaMetadata(path, kind))
    const batchSize = this.options.batchSize ?? 64
    const width = Math.max(1, this.options.concurrency ?? 4)
    let filled = 0
    try {
      while (!this.stopped && (this.options.shouldRun?.() ?? true)) {
        const batch = pendingMediaBatch(this.db, batchSize)
        if (!batch.length) break
        const results = new Array<MediaMetadata | null>(batch.length)
        let next = 0
        const worker = async () => {
          for (let i = next++; i < batch.length; i = next++) {
            results[i] = await read(batch[i]!.path, batch[i]!.kind).catch(() => null)
          }
        }
        await Promise.all(Array.from({ length: Math.min(width, batch.length) }, worker))
        if (this.stopped) break
        const saved = this.save(batch, results)
        filled += saved
        if (saved === 0) break // nothing changed: never spin on rows that cannot be written
        await yieldToEventLoop()
      }
      this.lastError = undefined
    } catch (error) {
      // A closed database or a busy writer: rows stay pending and the next kick retries.
      this.lastError = error instanceof Error ? error.message : String(error)
    }
    return filled
  }

  private save(batch: PendingMedia[], results: Array<MediaMetadata | null>): number {
    let saved = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (let i = 0; i < batch.length; i++) {
        if (saveMediaMetadata(this.db, batch[i]!.id, batch[i]!.mtimeMs, results[i] ?? null)) saved++
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // already rolled back
      }
      throw error
    }
    return saved
  }
}
