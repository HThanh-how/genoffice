import { Worker } from 'node:worker_threads'
import type { SearchOptions, SearchResult } from './store'

/** The thread that answers searches (a stand-in in tests). */
export interface SearchThread {
  postMessage(message: unknown): void
  on(
    event: 'message',
    listener: (value: { id: number; result?: SearchResult; error?: string }) => void,
  ): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: () => void): unknown
  terminate(): unknown
  unref?(): unknown
}

interface Job {
  q: string
  options: SearchOptions
  resolve: (result: SearchResult) => void
}

const EMPTY: SearchResult = { hits: [], total: 0 }
const SEARCH_TIMEOUT_MS = 60_000

/**
 * Runs file-index searches in a worker thread, one at a time. A search that is still waiting when newer ones arrive is
 * answered with an empty page instead of being run: its caller has moved on (every caller discards a page whose
 * request is no longer the latest), and a backlog of one-second searches would make the current one wait for all of them.
 */
export class FileIndexSearchClient {
  private thread: SearchThread | null = null
  private running: (Job & { id: number; timer: NodeJS.Timeout }) | null = null
  private readonly waiting: Job[] = []
  private nextId = 1
  private closed = false

  constructor(private readonly createThread: () => SearchThread) {}

  static forDatabase(dbPath: string, workerPath: string): FileIndexSearchClient {
    return new FileIndexSearchClient(() => new Worker(workerPath, { workerData: { dbPath } }))
  }

  search(q: string, options: SearchOptions = {}): Promise<SearchResult> {
    if (this.closed) return Promise.resolve(EMPTY)
    return new Promise((resolve) => {
      // typing asks for a new search per keystroke: only the newest one waits behind the running one
      for (const older of this.waiting.splice(0)) older.resolve(EMPTY)
      this.waiting.push({ q, options, resolve })
      this.pump()
    })
  }

  close(): void {
    this.closed = true
    for (const job of this.waiting.splice(0)) job.resolve(EMPTY)
    this.finishRunning(EMPTY)
    void this.thread?.terminate()
    this.thread = null
  }

  private pump(): void {
    if (this.running || this.closed) return
    const job = this.waiting.pop()
    if (!job) return
    const id = this.nextId++
    const timer = setTimeout(() => {
      this.finishRunning(EMPTY)
      this.dropThread() // a wedged search must not hold the next ones
    }, SEARCH_TIMEOUT_MS)
    timer.unref?.()
    this.running = { ...job, id, timer }
    try {
      this.ensureThread().postMessage({ id, q: job.q, options: job.options })
    } catch {
      this.finishRunning(EMPTY)
    }
  }

  private finishRunning(result: SearchResult): void {
    const running = this.running
    if (!running) return
    this.running = null
    clearTimeout(running.timer)
    running.resolve(result)
    queueMicrotask(() => this.pump())
  }

  private dropThread(): void {
    const thread = this.thread
    this.thread = null
    void thread?.terminate()
  }

  private ensureThread(): SearchThread {
    if (this.thread) return this.thread
    const thread = this.createThread()
    thread.on('message', (message) => {
      if (this.thread !== thread || this.running?.id !== message.id) return
      this.finishRunning(message.error !== undefined || !message.result ? EMPTY : message.result)
    })
    const lost = (): void => {
      if (this.thread !== thread) return
      this.thread = null
      this.finishRunning(EMPTY)
    }
    thread.on('error', lost)
    thread.on('exit', lost)
    thread.unref?.()
    this.thread = thread
    return thread
  }
}
