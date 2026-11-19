import { randomUUID } from 'node:crypto'
import {
  LocalLlmError,
  localOptions,
  type HostEvent,
  type HostRequest,
  type LocalChatRequest,
  type LocalOptions,
} from './protocol'

export type ClientState = 'STOPPED' | 'STARTING' | 'READY' | 'BUSY' | 'IDLE' | 'STOPPING'
export interface HostProcess {
  postMessage(message: HostRequest): void
  on(event: 'message', listener: (message: HostEvent) => void): unknown
  on(event: 'exit', listener: (code: number | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(): unknown
}
interface Pending {
  resolve(): void
  reject(error: Error): void
  event?: ((event: HostEvent) => void) | undefined
}

/** No Electron dependency: utilityProcess and child_process adapters implement the same interface. */
export class LocalLlmClient {
  state: ClientState = 'STOPPED'
  private process: HostProcess | undefined
  private exitPromise: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  private starting: Promise<void> | undefined
  private loaded = false
  private pending = new Map<string, Pending>()
  private idleTimer?: ReturnType<typeof setTimeout>
  private options: LocalOptions
  private claimed = false

  constructor(
    private readonly spawn: () => HostProcess,
    private readonly modelPath: string,
    options?: Partial<LocalOptions>,
    private readonly shutdownTimeoutMs = 5000,
  ) {
    this.options = localOptions(options)
  }

  private request(message: HostRequest, event?: (event: HostEvent) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending.set(message.id, { resolve, reject, event })
      try {
        this.process!.postMessage(message)
      } catch (error) {
        this.pending.delete(message.id)
        reject(error)
      }
    })
  }

  private async start(): Promise<void> {
    if (this.stopping) await this.stopping
    if (this.loaded) return
    if (this.starting) return this.starting
    this.state = 'STARTING'
    this.starting = (async () => {
      if (!this.process) {
        const child = this.spawn()
        this.process = child
        this.exitPromise = new Promise<void>((resolve) => {
          child.on('exit', (code) => {
            if (this.process === child) {
              this.process = undefined
              this.loaded = false
              this.state = 'STOPPED'
              for (const pending of this.pending.values())
                pending.reject(
                  new LocalLlmError(
                    'NATIVE_CRASH',
                    `Local native host exited (${code}). Retry to restart it.`,
                  ),
                )
              this.pending.clear()
            }
            resolve()
          })
        })
        child.on('error', (error) => {
          for (const pending of this.pending.values())
            pending.reject(new LocalLlmError('NATIVE_CRASH', error.message))
          this.pending.clear()
          child.kill()
        })
        child.on('message', (message) => {
          const pending = this.pending.get(message.id)
          if (!pending) return
          try {
            pending.event?.(message)
          } catch (error) {
            this.pending.delete(message.id)
            pending.reject(error instanceof Error ? error : new Error(String(error)))
            child.postMessage({ id: randomUUID(), type: 'abort', requestId: message.id })
            return
          }
          if (message.type === 'error' || message.type === 'done') {
            this.pending.delete(message.id)
            if (message.type === 'error')
              pending.reject(new LocalLlmError(message.code, message.message))
            else pending.resolve()
          }
        })
      }
      await this.request({
        id: randomUUID(),
        type: 'load',
        modelPath: this.modelPath,
        options: this.options,
      })
      if (this.stopping || !this.process)
        throw new LocalLlmError('ABORTED', 'Local startup cancelled')
      this.loaded = true
      this.state = 'READY'
    })()
      .catch(async (error) => {
        // Failed loads release the native host before a retry is allowed.
        await this.shutdown()
        throw error
      })
      .finally(() => {
        this.starting = undefined
      })
    return this.starting
  }

  async chat(
    request: LocalChatRequest,
    event: (event: HostEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.claimed)
      throw new LocalLlmError(
        'BUSY',
        'Local model is busy. Wait for the current request to finish.',
      )
    if (signal?.aborted) throw new LocalLlmError('ABORTED', 'Local request cancelled')
    this.claimed = true
    clearTimeout(this.idleTimer)
    const id = randomUUID()
    let abortTimer: ReturnType<typeof setTimeout> | undefined
    const abort = () => {
      if (this.state === 'STARTING') void this.shutdown()
      else {
        this.process?.postMessage({ id: randomUUID(), type: 'abort', requestId: id })
        // A stalled native decode must not keep consuming CPU after cancellation.
        abortTimer = setTimeout(() => {
          if (this.pending.has(id)) void this.shutdown()
        }, 2000)
      }
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await this.start()
      if (signal?.aborted) throw new LocalLlmError('ABORTED', 'Local request cancelled')
      this.state = 'BUSY'
      await this.request({ id, type: 'chat', request }, event)
    } catch (error) {
      if (signal?.aborted) throw new LocalLlmError('ABORTED', 'Local request cancelled')
      throw error
    } finally {
      clearTimeout(abortTimer)
      signal?.removeEventListener('abort', abort)
      this.claimed = false
      if (this.process && this.state !== 'STOPPING') {
        this.state = 'IDLE'
        this.idleTimer = setTimeout(() => {
          if (!this.claimed) void this.unload().catch(() => this.shutdown())
        }, this.options.keepHotMinutes * 60_000)
        this.idleTimer.unref?.()
      }
    }
  }

  async unload(): Promise<void> {
    clearTimeout(this.idleTimer)
    if (this.claimed) throw new LocalLlmError('BUSY', 'Cannot unload during a request')
    if (this.starting) await this.starting
    if (this.process && this.loaded) {
      await this.request({ id: randomUUID(), type: 'unload' })
      this.loaded = false
      this.state = 'IDLE'
    }
  }

  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping
    clearTimeout(this.idleTimer)
    const child = this.process
    if (!child) {
      this.state = 'STOPPED'
      return Promise.resolve()
    }
    this.state = 'STOPPING'
    this.stopping = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // Resolve only on the exit event, including after the timeout's forced termination.
        timer = setTimeout(() => child.kill(), this.shutdownTimeoutMs)
        try {
          child.postMessage({ id: randomUUID(), type: 'shutdown' })
        } catch {
          child.kill()
        }
        await this.exitPromise
      } finally {
        clearTimeout(timer)
        this.loaded = false
        this.state = 'STOPPED'
        this.stopping = undefined
      }
    })()
    return this.stopping
  }
}
