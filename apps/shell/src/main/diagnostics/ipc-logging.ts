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
  /** a call that has not answered after this long is logged once, while it is still running (default 10 s) */
  readonly pendingMs?: number
  /** channels that wait for a person (file dialogs, confirmations): never reported as slow or pending */
  readonly waitsForUser?: (channel: string) => boolean
  readonly now?: () => number
  readonly setInterval?: typeof setInterval
  readonly clearInterval?: typeof clearInterval
}

/**
 * Channels whose handler opens a dialog or waits for a decision. Their duration is the time the
 * person took, not a stall, so they would only add noise to the slow and pending lines.
 */
const USER_WAIT =
  /(^|[:.-])(browse|pick|choose|dialog|save-as|open-file|print|confirm|export|scan-document-folder|folder-root-add|save-skill-zip|import-opening-html)([:.-]|$)/i

export const defaultWaitsForUser = (channel: string): boolean => USER_WAIT.test(channel)

interface InFlight {
  readonly channel: string
  readonly started: number
  reported: boolean
}

/**
 * Logs the IPC handlers of the main process: every failure, every call slower than `slowMs`, and
 * every call still running after `pendingMs` (a handler that never answers leaves no other trace).
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
  const pendingMs = options.pendingMs ?? 10_000
  const waitsForUser = options.waitsForUser ?? defaultWaitsForUser
  const now = options.now ?? (() => performance.now())
  const set = options.setInterval ?? setInterval
  const clear = options.clearInterval ?? clearInterval
  const handle = ipc.handle.bind(ipc)

  const inFlight = new Set<InFlight>()
  let sweeper: ReturnType<typeof setInterval> | undefined

  const safely = (fn: () => void): void => {
    // logging must never change what the handler returns or throws
    try {
      fn()
    } catch {
      // the logger is broken; the handler's own result stands
    }
  }

  const sweep = (): void => {
    const at = now()
    for (const call of inFlight) {
      if (call.reported || at - call.started < pendingMs) continue
      call.reported = true
      safely(() =>
        sink()?.warn('ipc', 'handler.pending', {
          channel: call.channel,
          ageMs: Math.round(at - call.started),
        }),
      )
    }
  }

  const track = (call: InFlight): void => {
    inFlight.add(call)
    if (!sweeper) {
      sweeper = set(sweep, Math.max(1000, Math.min(pendingMs / 2, 5000)))
      ;(sweeper as { unref?: () => void }).unref?.()
    }
  }
  const untrack = (call: InFlight): void => {
    inFlight.delete(call)
    if (inFlight.size === 0 && sweeper) {
      clear(sweeper)
      sweeper = undefined
    }
  }

  ipc.handle = (channel, listener) =>
    handle(channel, (event, ...args) => {
      const started = now()
      const userWait = waitsForUser(channel)
      const done = (call: InFlight | undefined, error?: unknown): void => {
        if (call) untrack(call)
        safely(() => {
          const ms = Math.round(now() - started)
          const log = sink()
          if (!log) return
          if (error !== undefined) {
            log.error('ipc', 'handler.failed', { channel, ms, err: describeError(error) })
          } else if (!userWait && (ms >= slowMs || call?.reported)) {
            // a call that was reported as pending gets its total time when it finally ends
            log.warn('ipc', 'handler.slow', { channel, ms })
          }
        })
      }
      let result: unknown
      try {
        result = listener(event, ...args)
      } catch (error) {
        done(undefined, error ?? new Error('thrown value was undefined'))
        throw error
      }
      if (result instanceof Promise) {
        const call: InFlight = { channel, started, reported: userWait }
        if (!userWait) track(call)
        // observe the outcome without changing it: the caller still gets the original promise
        result.then(
          () => done(userWait ? undefined : call),
          (error: unknown) =>
            done(userWait ? undefined : call, error ?? new Error('rejected with undefined')),
        )
      } else {
        done(undefined)
      }
      return result
    })
}
