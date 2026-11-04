import type { EventEmitter } from 'node:events'
import { describeError } from './redact'

/** The logger calls the lifecycle hooks use. */
export interface LifecycleSink {
  debug(cat: string, ev: string, data?: unknown): void
  info(cat: string, ev: string, data?: unknown): void
  warn(cat: string, ev: string, data?: unknown): void
  error(cat: string, ev: string, data?: unknown): void
}

/** The few things of Electron's `app` the hooks need (so tests can pass an EventEmitter). */
export interface AppLike extends EventEmitter {
  getVersion(): string
}

export interface LifecycleOptions {
  readonly app: AppLike
  readonly proc?: NodeJS.Process | EventEmitter
  readonly sink: LifecycleSink
  readonly memoryIntervalMs?: number
  /** rss above this is logged at warn level on every sample */
  readonly memoryWarnBytes?: number
  /** rss growth since the last info line that earns a new info line */
  readonly memoryStepBytes?: number
  readonly sample?: () => { rss: number; heapUsed: number; external: number }
  readonly setInterval?: typeof setInterval
  readonly clearInterval?: typeof clearInterval
}

const MB = 1024 * 1024
const round1 = (n: number): number => Math.round(n * 10) / 10

interface WindowLike extends EventEmitter {
  isDestroyed(): boolean
}

/**
 * Records the events that explain a crash or a freeze after the fact: renderer and child processes
 * that died, windows that stopped answering, uncaught errors, rejected promises that nobody
 * handled, a slow rise in memory, and how the app was asked to quit. Returns a function that removes
 * every listener (used by tests).
 */
export function installLifecycleLogging(options: LifecycleOptions): () => void {
  const { app, sink } = options
  const proc = options.proc ?? process
  const undo: Array<() => void> = []
  const on = (target: EventEmitter, event: string, listener: (...args: any[]) => void): void => {
    target.on(event, listener)
    undo.push(() => void target.off(event, listener))
  }

  on(app, 'render-process-gone', (_event: unknown, wc: { id?: number }, details: any) => {
    sink.error('app', 'render-process-gone', {
      wc: wc?.id,
      reason: details?.reason,
      exitCode: details?.exitCode,
    })
  })
  on(app, 'child-process-gone', (_event: unknown, details: any) => {
    sink.error('app', 'child-process-gone', {
      type: details?.type,
      reason: details?.reason,
      exitCode: details?.exitCode,
      name: details?.name,
      serviceName: details?.serviceName,
    })
  })
  on(app, 'browser-window-created', (_event: unknown, win: WindowLike) => {
    const id = (win as { id?: number }).id
    let hungSince: number | undefined
    const unresponsive = (): void => {
      hungSince = Date.now()
      sink.warn('window', 'unresponsive', { win: id })
    }
    const responsive = (): void => {
      sink.warn('window', 'responsive', {
        win: id,
        hungMs: hungSince === undefined ? undefined : Date.now() - hungSince,
      })
      hungSince = undefined
    }
    win.on('unresponsive', unresponsive)
    win.on('responsive', responsive)
    win.once('closed', () => {
      win.off('unresponsive', unresponsive)
      win.off('responsive', responsive)
    })
  })

  // `uncaughtExceptionMonitor` observes without changing what Node does with the error
  on(proc as EventEmitter, 'uncaughtExceptionMonitor', (error: unknown, origin: unknown) => {
    sink.error('process', 'uncaughtException', { origin, err: describeError(error) })
  })
  on(proc as EventEmitter, 'unhandledRejection', (reason: unknown) => {
    sink.error('process', 'unhandledRejection', { err: describeError(reason) })
    // a listener replaces Node's own warning, so keep the message visible on the console
    console.error('[unhandledRejection]', reason)
  })

  on(app, 'before-quit', () => sink.info('app', 'before-quit'))
  on(app, 'will-quit', () => sink.info('app', 'will-quit'))
  on(app, 'quit', (_event: unknown, exitCode: unknown) => sink.info('app', 'quit', { exitCode }))

  const sample =
    options.sample ??
    ((): { rss: number; heapUsed: number; external: number } => {
      const m = process.memoryUsage()
      return { rss: m.rss, heapUsed: m.heapUsed, external: m.external }
    })
  const warnAt = options.memoryWarnBytes ?? 1500 * MB
  const step = options.memoryStepBytes ?? 200 * MB
  let lastInfoRss = 0
  const set = options.setInterval ?? setInterval
  const clear = options.clearInterval ?? clearInterval
  const timer = set(() => {
    try {
      const m = sample()
      const data = {
        rssMb: round1(m.rss / MB),
        heapMb: round1(m.heapUsed / MB),
        externalMb: round1(m.external / MB),
      }
      if (m.rss >= warnAt) {
        sink.warn('process', 'memory.high', data)
        lastInfoRss = m.rss
      } else if (lastInfoRss === 0 || Math.abs(m.rss - lastInfoRss) >= step) {
        sink.info('process', 'memory', data)
        lastInfoRss = m.rss
      } else {
        sink.debug('process', 'memory', data)
      }
    } catch (error) {
      sink.error('process', 'memory.sample-failed', { err: describeError(error) })
    }
  }, options.memoryIntervalMs ?? 60_000)
  ;(timer as { unref?: () => void }).unref?.()
  undo.push(() => clear(timer))

  return () => {
    for (const fn of undo.splice(0)) fn()
  }
}

/** The line written once at startup: enough to know which build produced the rest of the log. */
export function startupInfo(
  app: { getVersion(): string },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: (process as { getSystemVersion?: () => string }).getSystemVersion?.(),
    ...extra,
  }
}
