/**
 * Priority levels for Local VLM inference tasks.
 * Lower numeric value = higher priority.
 */
export enum InferencePriority {
  /** User-facing interactive chat (Docs chat, HomeChat). Highest priority. */
  INTERACTIVE = 1,
  /** User-initiated document transformations (e.g. apply_ops, formatting). */
  FOREGROUND_DOC = 2,
  /** Background indexing, document memory chunking, offline OCR. Lowest priority. */
  BACKGROUND_OCR = 3,
}

export interface QueuedInferenceTask<T> {
  id: string
  priority: InferencePriority
  label?: string
  task: () => Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
  signal?: AbortSignal
  enqueuedAt: number
}

export interface SchedulerStats {
  running: number
  queued: number
  maxConcurrency: number
  activePriority?: InferencePriority
  queueByPriority: {
    interactive: number
    foregroundDoc: number
    backgroundOcr: number
  }
}

export interface LocalVlmSchedulerOptions {
  /**
   * Maximum concurrent inference operations running simultaneously.
   * Default: 1. CPU GEMM and AVX2 inference threads stall when multiple
   * models execute in parallel on the same memory bus.
   */
  maxConcurrency?: number
  /** Maximum queue size before backpressure rejects new background tasks. */
  maxQueueSize?: number
}

/**
 * Centralized inference scheduler with Priority Queue and backpressure control (Issue 7.4).
 * Ensures interactive user chat immediately preempts background OCR and prevents
 * CPU memory bus thrashing by bounding concurrency.
 */
export class LocalVlmInferenceScheduler {
  private queue: QueuedInferenceTask<any>[] = []
  private runningCount = 0
  private maxConcurrency: number
  private maxQueueSize: number
  private nextTaskId = 1

  constructor(options?: LocalVlmSchedulerOptions) {
    this.maxConcurrency = options?.maxConcurrency ?? 1
    this.maxQueueSize = options?.maxQueueSize ?? 64
  }

  setMaxConcurrency(concurrency: number): void {
    this.maxConcurrency = Math.max(1, concurrency)
    this.drain()
  }

  /**
   * Schedules an inference task with a given priority level and optional AbortSignal.
   */
  async schedule<T>(
    priority: InferencePriority,
    task: () => Promise<T>,
    options?: { signal?: AbortSignal; label?: string },
  ): Promise<T> {
    const signal = options?.signal
    if (signal?.aborted) {
      const err = new Error('Inference task aborted before execution')
      err.name = 'AbortError'
      throw err
    }

    if (this.queue.length >= this.maxQueueSize && priority === InferencePriority.BACKGROUND_OCR) {
      throw new Error(
        `Local VLM inference queue is saturated (${this.queue.length} tasks). Backpressure rejected background task.`,
      )
    }

    return new Promise<T>((resolve, reject) => {
      const taskId = `task-${this.nextTaskId++}`
      const entry: QueuedInferenceTask<T> = {
        id: taskId,
        priority,
        label: options?.label,
        task,
        resolve,
        reject,
        signal,
        enqueuedAt: Date.now(),
      }

      if (signal) {
        const onAbort = () => {
          this.removeFromQueue(taskId)
          const err = new Error('Inference task aborted while in scheduler queue')
          err.name = 'AbortError'
          reject(err)
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      // Priority insertion: sort so lower priority numbers (higher urgency) come first.
      // Stable order (FIFO) within the same priority level.
      this.insertWithPriority(entry)
      this.drain()
    })
  }

  private insertWithPriority(entry: QueuedInferenceTask<any>): void {
    let insertIndex = this.queue.length
    for (let i = 0; i < this.queue.length; i++) {
      if (entry.priority < this.queue[i]!.priority) {
        insertIndex = i
        break
      }
    }
    this.queue.splice(insertIndex, 0, entry)
  }

  private removeFromQueue(id: string): void {
    const idx = this.queue.findIndex((t) => t.id === id)
    if (idx !== -1) {
      this.queue.splice(idx, 1)
    }
  }

  private drain(): void {
    while (this.runningCount < this.maxConcurrency && this.queue.length > 0) {
      const nextTask = this.queue.shift()
      if (!nextTask) break

      if (nextTask.signal?.aborted) {
        const err = new Error('Inference task aborted')
        err.name = 'AbortError'
        nextTask.reject(err)
        continue
      }

      this.runningCount++
      this.executeTask(nextTask)
    }
  }

  private async executeTask(entry: QueuedInferenceTask<any>): Promise<void> {
    try {
      const result = await entry.task()
      entry.resolve(result)
    } catch (error) {
      entry.reject(error)
    } finally {
      this.runningCount = Math.max(0, this.runningCount - 1)
      this.drain()
    }
  }

  getStats(): SchedulerStats {
    let interactive = 0
    let foregroundDoc = 0
    let backgroundOcr = 0

    for (const item of this.queue) {
      if (item.priority === InferencePriority.INTERACTIVE) interactive++
      else if (item.priority === InferencePriority.FOREGROUND_DOC) foregroundDoc++
      else backgroundOcr++
    }

    return {
      running: this.runningCount,
      queued: this.queue.length,
      maxConcurrency: this.maxConcurrency,
      queueByPriority: {
        interactive,
        foregroundDoc,
        backgroundOcr,
      },
    }
  }

  clearQueue(): void {
    while (this.queue.length > 0) {
      const task = this.queue.shift()
      if (task) {
        const err = new Error('Scheduler queue cleared')
        err.name = 'AbortError'
        task.reject(err)
      }
    }
  }
}

// Global shared scheduler instance
let defaultScheduler: LocalVlmInferenceScheduler | null = null

export function getLocalVlmScheduler(): LocalVlmInferenceScheduler {
  if (!defaultScheduler) {
    defaultScheduler = new LocalVlmInferenceScheduler()
  }
  return defaultScheduler
}

export function setLocalVlmScheduler(scheduler: LocalVlmInferenceScheduler | null): void {
  defaultScheduler = scheduler
}
