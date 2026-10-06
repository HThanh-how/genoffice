import { isIndexingPaused, subscribeIndexingPolicy, type PublishedPolicy } from '../fork/indexing-policy-bus'

export enum BackgroundWorkPriority {
  P0_INTERACTIVE = 0,
  P1_USER_INITIATED = 1,
  P2_NORMAL_INDEXING = 2,
  P3_MIGRATION = 3,
  P4_HOUSEKEEPING = 4,
}

export type RequestClassification = 'interactive' | 'index' | 'maintenance'

export function classifyPriority(priority: BackgroundWorkPriority | number): RequestClassification {
  switch (priority) {
    case BackgroundWorkPriority.P0_INTERACTIVE:
      return 'interactive'
    case BackgroundWorkPriority.P1_USER_INITIATED:
    case BackgroundWorkPriority.P2_NORMAL_INDEXING:
      return 'index'
    case BackgroundWorkPriority.P3_MIGRATION:
    case BackgroundWorkPriority.P4_HOUSEKEEPING:
    default:
      return 'maintenance'
  }
}

export function classifyRequestType(type: string): RequestClassification {
  switch (type.toLowerCase()) {
    case 'search':
    case 'search-lexical':
    case 'search-semantic':
    case 'open-now':
    case 'read-now':
    case 'query-embedding':
    case 'interactive':
      return 'interactive'

    case 'user-index':
    case 'folder-priority':
    case 'manual-index':
    case 'extract':
    case 'passage-embedding':
    case 'embed':
    case 'index':
      return 'index'

    case 'chunk-upgrade':
    case 'embedding-migration':
    case 'fts-maintenance':
    case 'fts-maintenance-step':
    case 'gc':
    case 'gc-step':
    case 'vacuum':
    case 'incremental-vacuum':
    case 'ann-rebuild':
    case 'ann-sync':
    case 'counter-backfill':
    case 'maintenance':
    default:
      return 'maintenance'
  }
}

export function getPriorityForType(type: string): BackgroundWorkPriority {
  switch (type.toLowerCase()) {
    case 'search':
    case 'search-lexical':
    case 'search-semantic':
    case 'open-now':
    case 'read-now':
    case 'query-embedding':
    case 'interactive':
      return BackgroundWorkPriority.P0_INTERACTIVE

    case 'user-index':
    case 'folder-priority':
    case 'manual-index':
      return BackgroundWorkPriority.P1_USER_INITIATED

    case 'extract':
    case 'passage-embedding':
    case 'embed':
    case 'index':
      return BackgroundWorkPriority.P2_NORMAL_INDEXING

    case 'chunk-upgrade':
    case 'embedding-migration':
      return BackgroundWorkPriority.P3_MIGRATION

    case 'fts-maintenance':
    case 'fts-maintenance-step':
    case 'gc':
    case 'gc-step':
    case 'vacuum':
    case 'incremental-vacuum':
    case 'ann-rebuild':
    case 'ann-sync':
    case 'counter-backfill':
    case 'maintenance':
    default:
      return BackgroundWorkPriority.P4_HOUSEKEEPING
  }
}

interface QueuedItem {
  id: string
  priority: BackgroundWorkPriority
  classification: RequestClassification
  task: (signal: AbortSignal) => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  controller: AbortController
}

export interface BackgroundWorkGateOptions {
  pauseCheck?: () => boolean
  autoSubscribePolicy?: boolean
  concurrency?: number
}

export class BackgroundWorkGate {
  private readonly pauseCheck: () => boolean
  private readonly unsubscribePolicy: (() => void) | null = null
  private readonly concurrency: number
  private readonly queue: QueuedItem[] = []
  private readonly activeItems = new Map<string, QueuedItem>()
  private running = 0
  private disposed = false
  private nextItemId = 1

  constructor(options: BackgroundWorkGateOptions = {}) {
    this.pauseCheck = options.pauseCheck ?? isIndexingPaused
    this.concurrency = Math.max(1, options.concurrency ?? 2)

    if (options.autoSubscribePolicy !== false) {
      this.unsubscribePolicy = subscribeIndexingPolicy((next: PublishedPolicy) => {
        if (next.paused) {
          this.handlePaused()
        } else {
          this.drain()
        }
      })
    }
  }

  isPaused(): boolean {
    return this.pauseCheck()
  }

  canRun(target: BackgroundWorkPriority | RequestClassification | string): boolean {
    if (this.disposed) return false
    const classification = this.resolveClassification(target)
    if (classification === 'interactive') return true
    return !this.isPaused()
  }

  resolveClassification(target: BackgroundWorkPriority | RequestClassification | string): RequestClassification {
    if (typeof target === 'number') {
      return classifyPriority(target)
    }
    if (target === 'interactive' || target === 'index' || target === 'maintenance') {
      return target
    }
    return classifyRequestType(target)
  }

  enqueue<T>(
    priorityOrType: BackgroundWorkPriority | string,
    task: (signal: AbortSignal) => Promise<T>,
    options: { id?: string } = {},
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('BackgroundWorkGate has been disposed'))
    }

    const priority =
      typeof priorityOrType === 'number'
        ? priorityOrType
        : getPriorityForType(priorityOrType)
    const classification = classifyPriority(priority)

    if (this.isPaused() && classification !== 'interactive') {
      return Promise.reject(new Error('Work rejected: indexing is paused'))
    }

    return new Promise<T>((resolve, reject) => {
      const id = options.id ?? `work-${this.nextItemId++}`
      const controller = new AbortController()

      const item: QueuedItem = {
        id,
        priority,
        classification,
        task,
        resolve,
        reject,
        controller,
      }

      // Priority ordering: lower numeric value = higher priority (P0 < P1 < P2 < P3 < P4)
      const insertIndex = this.queue.findIndex((queued) => queued.priority > item.priority)
      if (insertIndex === -1) {
        this.queue.push(item)
      } else {
        this.queue.splice(insertIndex, 0, item)
      }

      this.drain()
    })
  }

  cancelPendingBackground(reason = 'Work cancelled: indexing paused'): number {
    let cancelledCount = 0
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const item = this.queue[i]!
      if (item.classification !== 'interactive') {
        this.queue.splice(i, 1)
        item.controller.abort(reason)
        item.reject(new Error(reason))
        cancelledCount++
      }
    }
    return cancelledCount
  }

  cancelPending(classification?: RequestClassification, reason = 'Work cancelled'): number {
    let cancelledCount = 0
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const item = this.queue[i]!
      if (!classification || item.classification === classification) {
        this.queue.splice(i, 1)
        item.controller.abort(reason)
        item.reject(new Error(reason))
        cancelledCount++
      }
    }
    return cancelledCount
  }

  cancelTask(id: string, reason = 'Task cancelled'): boolean {
    const queueIndex = this.queue.findIndex((item) => item.id === id)
    if (queueIndex !== -1) {
      const [item] = this.queue.splice(queueIndex, 1)
      item!.controller.abort(reason)
      item!.reject(new Error(reason))
      return true
    }

    const activeItem = this.activeItems.get(id)
    if (activeItem) {
      activeItem.controller.abort(reason)
      return true
    }

    return false
  }

  handlePaused(): void {
    // 1. Cancel pending background tasks
    this.cancelPendingBackground()

    // 2. Abort running background tasks if any
    for (const [id, active] of this.activeItems.entries()) {
      if (active.classification !== 'interactive') {
        active.controller.abort('Indexing paused')
        this.activeItems.delete(id)
      }
    }
  }

  private drain(): void {
    if (this.disposed) return

    while (this.running < this.concurrency && this.queue.length > 0) {
      // Find highest priority item allowed to run
      const eligibleIndex = this.queue.findIndex((item) => {
        if (item.classification === 'interactive') return true
        return !this.isPaused()
      })

      if (eligibleIndex === -1) {
        // No item can run currently (e.g. paused and only background items remaining)
        break
      }

      const [item] = this.queue.splice(eligibleIndex, 1)
      if (!item) break

      this.running++
      this.activeItems.set(item.id, item)

      void (async () => {
        try {
          const result = await item.task(item.controller.signal)
          item.resolve(result)
        } catch (error) {
          item.reject(error)
        } finally {
          this.activeItems.delete(item.id)
          this.running--
          this.drain()
        }
      })()
    }
  }

  getPendingCount(priorityOrClassification?: BackgroundWorkPriority | RequestClassification): number {
    if (priorityOrClassification === undefined) {
      return this.queue.length
    }
    if (typeof priorityOrClassification === 'number') {
      return this.queue.filter((item) => item.priority === priorityOrClassification).length
    }
    return this.queue.filter((item) => item.classification === priorityOrClassification).length
  }

  getActiveCount(): number {
    return this.running
  }

  dispose(): void {
    this.disposed = true
    if (this.unsubscribePolicy) {
      this.unsubscribePolicy()
    }
    this.cancelPending(undefined, 'BackgroundWorkGate disposed')
    for (const active of this.activeItems.values()) {
      active.controller.abort('BackgroundWorkGate disposed')
    }
    this.activeItems.clear()
  }
}
