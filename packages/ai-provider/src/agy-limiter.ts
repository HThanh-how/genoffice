function abortError(): Error {
  const error = new Error('Request aborted')
  error.name = 'AbortError'
  return error
}

/** FIFO semaphore; queued waiters leave on abort. Dependency-free to prevent cyclic module TDZ issues. */
export class Limiter {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly max: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError()
    if (this.active >= this.max) {
      await new Promise<void>((resolve, reject) => {
        const waiter = () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = () => {
          const i = this.waiters.indexOf(waiter)
          if (i >= 0) this.waiters.splice(i, 1)
          reject(abortError())
        }
        this.waiters.push(waiter)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
    this.active++
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.waiters.shift()?.()
    }
  }
}

export function createAgyLimiter(max = 2): Limiter {
  return new Limiter(max)
}
