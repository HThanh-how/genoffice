import { AsyncLocalStorage } from 'node:async_hooks'
import type { IpcMain } from 'electron'

type Details = {
  kind?: 'ipc' | 'timer' | 'startup' | 'indexer' | 'search'
  source?: 'user-input' | 'automatic' | 'unknown'
  queryLength?: number
  resultCount?: number
}
interface Operation {
  label: string
  start: number
  end?: number
  details: Details
  parent?: Operation
}
const context = new AsyncLocalStorage<Operation>()
const active = new Set<Operation>()
const recent: Operation[] = []

/** Labels are static code identifiers; details deliberately cannot carry queries, paths or content. */
export function traceOp<T>(label: string, fn: () => T, details: Details = {}): T {
  const op: Operation = { label, start: performance.now(), details, parent: context.getStore() }
  active.add(op)
  const finish = (): void => {
    op.end = performance.now()
    active.delete(op)
    // The watchdog runs AFTER a blocking call returns. Retain slow completed calls too.
    if (op.end - op.start >= 8) {
      recent.push(op)
      if (recent.length > 64) recent.shift()
    }
  }
  try {
    const result = context.run(op, fn)
    if (result instanceof Promise) return result.finally(finish) as T
    finish()
    return result
  } catch (error) {
    finish()
    throw error
  }
}

/** Overlap with the delayed timer's interval, including parents of completed operations. Bounded log size. */
export function operationsSince(since: number, now = performance.now()) {
  const found = new Set<Operation>()
  for (const op of [...recent, ...active].sort(
    (a, b) => (b.end ?? now) - b.start - ((a.end ?? now) - a.start),
  )) {
    if ((op.end ?? now) < since) continue
    let ancestor: Operation | undefined = op
    while (ancestor && found.size < 64) {
      found.add(ancestor)
      ancestor = ancestor.parent
    }
  }
  return [...found].slice(0, 32).map((op) => ({
    label: op.label,
    parent: op.parent?.label,
    ...op.details,
    source: op.details.source ?? 'unknown',
    startMs: Math.round(op.start),
    ms: Math.round((op.end ?? now) - op.start),
    active: op.end === undefined,
  }))
}

/** Install before any registrations; preserve handler return values, errors and async ancestry. */
export function installIpcTracing(ipc: Pick<IpcMain, 'handle'>): void {
  const handle = ipc.handle.bind(ipc)
  ipc.handle = (channel, listener) =>
    handle(channel, (event, ...args) =>
      traceOp(channel, () => listener(event, ...args), { kind: 'ipc' }),
    )
}
