import { randomBytes } from 'node:crypto'

/**
 * A way for code that has no access to the app's diagnostic log (this package is used by apps and
 * tools that do not have one) to leave a trace in it: the app registers its logger with `setDiagSink`,
 * and `diagHook.info(...)` and `observeChild(...)` reach it; with no sink they do nothing.
 *
 * What is written is always an event name and numbers or short fixed words (provider, model name,
 * process label, exit code, milliseconds): never a prompt, an answer, a file name or a file's content.
 */
export interface DiagSink {
  info(cat: string, ev: string, data?: unknown): void
  warn(cat: string, ev: string, data?: unknown): void
  error(cat: string, ev: string, data?: unknown): void
}

let sink: DiagSink | undefined

export function setDiagSink(next: DiagSink | undefined): void {
  sink = next
}

/** Never throws: a log must not decide whether a request works. */
function emit(level: keyof DiagSink, cat: string, ev: string, data?: unknown): void {
  try {
    sink?.[level](cat, ev, data)
  } catch {
    // the sink is broken; the work goes on
  }
}

export const diagHook: DiagSink = {
  info: (cat, ev, data) => emit('info', cat, ev, data),
  warn: (cat, ev, data) => emit('warn', cat, ev, data),
  error: (cat, ev, data) => emit('error', cat, ev, data),
}

/** A short random id to tie the lines of one request together across the processes it passes through. */
export function newReqId(): string {
  return randomBytes(6).toString('hex')
}

/** The few things of a child process that `observeChild` reads. */
export interface ObservableChild {
  readonly pid?: number | undefined
  on(event: 'spawn', listener: () => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/**
 * Writes the life of a child process to the log: when it started (pid), how it ended (exit code or
 * signal, and how long it ran), and if it could not be started. `label` is a fixed name for the kind
 * of process ("agy-run", "codex-app-server"), not a command line. `reqId` ties it to a request.
 */
export function observeChild(child: ObservableChild, label: string, reqId?: string): void {
  const started = Date.now()
  const base = { label, ...(reqId ? { reqId } : {}) }
  try {
    if (child.pid !== undefined) diagHook.info('proc', 'spawn', { ...base, pid: child.pid })
    else child.on('spawn', () => diagHook.info('proc', 'spawn', { ...base, pid: child.pid }))
    child.on('exit', (code, signal) => {
      const data = { ...base, pid: child.pid, code, signal, ms: Date.now() - started }
      // a process that ended with a failure is a warning; a signal is how it is stopped on purpose
      if (code !== 0 && code !== null) diagHook.warn('proc', 'exit', data)
      else diagHook.info('proc', 'exit', data)
    })
    child.on('error', (error) =>
      diagHook.error('proc', 'error', { ...base, err: error, ms: Date.now() - started }),
    )
  } catch {
    // an object that is not a real child process (a test double): nothing to observe
  }
}
