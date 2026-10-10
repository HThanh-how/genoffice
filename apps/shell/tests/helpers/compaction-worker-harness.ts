import { EventEmitter } from 'node:events'
import { DocumentMemoryStore } from '../../src/main/document-memory/store'
import { extractDocument } from '../../src/main/document-memory/worker'
import { EMBEDDING_PROFILES } from '../../src/main/document-memory/embedding-profiles'
import {
  StorageAccountingRunner,
  type StorageAccountingWorkerLike,
} from '../../src/main/document-memory/runtime/storage-accounting-runner'
import { collectStorageAccounting } from '../../src/main/document-memory/runtime/storage-accounting'
import { storageBudgetAckReply } from './storage-budget-ack'

export const PROFILE = EMBEDDING_PROFILES.standard

/**
 * Production measures accounting in a real worker thread (real I/O fake timers cannot advance). This keeps the
 * production runner and protocol but hosts the measurement in an in-process stand-in that replies on a microtask and
 * reports a TEST-CONTROLLED managed total (the usual way the budget tests drive the 80/90/100/110% zones).
 */
export function simulatedAccountingRunner(usage: () => number): StorageAccountingRunner {
  return new StorageAccountingRunner({
    workerPath: 'inline-accounting-worker',
    workerFactory: (_p, data) => {
      const worker = new EventEmitter() as EventEmitter & StorageAccountingWorkerLike
      worker.terminate = () => Promise.resolve(0)
      queueMicrotask(() => {
        try {
          const report = collectStorageAccounting(data)
          const total = usage()
          report.totalManagedBytes = total
          report.totalTrackedBytes = total
          report.databaseBytes = Math.min(report.databaseBytes, total)
          worker.emit('message', { ok: true, report })
        } catch (err) {
          worker.emit('message', {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })
      return worker
    },
  })
}

type Handler = (message: any) => unknown | Promise<unknown>

/**
 * Fake index worker: ACKs the budget handshake, really extracts files, answers embeds with constant vectors and routes
 * every storage-compaction request to a scripted handler (or null = "unknown request", like an old worker).
 */
export class ScriptedWorker extends EventEmitter {
  received: any[] = []
  embedCalls = 0
  extractPaths: string[] = []
  private pendingTimers = new Set<NodeJS.Timeout>()
  private inFlight = new Set<Promise<unknown>>()

  constructor(
    private readonly dbPath: string,
    private readonly handlers: Partial<Record<string, Handler>> = {},
    private readonly options: { extract?: boolean; delayMs?: number } = {},
  ) {
    super()
  }
  of(type: string): any[] {
    return this.received.filter((m) => m.type === type)
  }
  postMessage(message: any): void {
    this.received.push(message)
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer)
      const task = (async () => {
        try {
          const ack = storageBudgetAckReply(message)
          if (ack) return void this.emit('message', ack)
          const handler = this.handlers[message.type]
          if (handler) {
            const result = await handler(message)
            return void this.emit('message', { id: message.id, result })
          }
          if (message.type === 'extract' && message.path && this.options.extract !== false) {
            this.extractPaths.push(message.path)
            const s = new DocumentMemoryStore(this.dbPath)
            try {
              const result = await extractDocument(
                message.path,
                (p, h) => s.ocr.pages(p, h),
                message.maxPdfPages,
              )
              this.emit('message', { id: message.id, result })
            } finally {
              s.close()
            }
          } else if (message.type === 'embed') {
            this.embedCalls++
            this.emit('message', { type: 'model', state: 'ready' })
            this.emit('message', {
              id: message.id,
              result: (message.texts ?? []).map(() => new Array(PROFILE.dimensions).fill(0.01)),
            })
          } else {
            this.emit('message', { id: message.id, result: null })
          }
        } catch (err) {
          this.emit('message', {
            id: message.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })()
      this.inFlight.add(task)
      task.finally(() => this.inFlight.delete(task))
    }, this.options.delayMs ?? 0)
    this.pendingTimers.add(timer)
  }
  async terminate(): Promise<number> {
    for (const t of this.pendingTimers) clearTimeout(t)
    this.pendingTimers.clear()
    await Promise.allSettled(Array.from(this.inFlight))
    this.inFlight.clear()
    return 0
  }
}

export async function waitFor(cond: () => boolean, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return cond()
}
