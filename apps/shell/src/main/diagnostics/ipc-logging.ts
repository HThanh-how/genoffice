import type { IpcMain } from 'electron'
import { describeError } from './redact'

/** The part of the logger the IPC wrapper needs (kept small so tests can pass a fake). */
export interface IpcLogSink {
  warn(cat: string, ev: string, data?: unknown): void
  error(cat: string, ev: string, data?: unknown): void
}

export interface IpcLoggingOptions {
  /** calls slower than this are logged (default 500 ms) */
  readonly slowMs?: number
  readonly now?: () => number
}

/**
 * Logs the IPC handlers of the main process: every failure, and every call slower than `slowMs`.
 * Only the channel name and the duration are recorded, never the arguments or the result, because
 * those carry the user's documents and prompts. The handler's return value, its thrown errors and
 * its sync/async nature are passed through unchanged.
 *
 * `sink` is a getter so the wrapper can be installed before the logger exists (it is created once
 * `userData` is known) without losing the calls made in between.
 */
export function installIpcLogging(
  ipc: Pick<IpcMain, 'handle'>,
  sink: () => IpcLogSink | undefined,
  options: IpcLoggingOptions = {},
): void {
  const slowMs = options.slowMs ?? 500
  const now = options.now ?? (() => performance.now())
  const handle = ipc.handle.bind(ipc)

  ipc.handle = (channel, listener) =>
    handle(channel, (event, ...args) => {
      const started = now()
      const done = (error?: unknown): void => {
        // logging must never change what the handler returns or throws
        try {
          const ms = Math.round(now() - started)
          const log = sink()
          if (!log) return
          if (error !== undefined) {
            log.error('ipc', 'handler.failed', { channel, ms, err: describeError(error) })
          } else if (ms >= slowMs) {
            log.warn('ipc', 'handler.slow', { channel, ms })
          }
        } catch {
          // the logger is broken; the handler's own result stands
        }
      }
      let result: unknown
      try {
        result = listener(event, ...args)
      } catch (error) {
        done(error ?? new Error('thrown value was undefined'))
        throw error
      }
      if (result instanceof Promise) {
        // observe the outcome without changing it: the caller still gets the original promise
        result.then(
          () => done(),
          (error: unknown) => done(error ?? new Error('rejected with undefined')),
        )
      } else {
        done()
      }
      return result
    })
}
