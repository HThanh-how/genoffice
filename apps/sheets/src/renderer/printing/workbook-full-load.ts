import { pollUntilReady } from '@genoffice/electron-utils/headless-export'
import type { LazyWorkbookState } from '../univer-state'
import { preloadEntireWorkbook } from '../univer-sync'
import type {
  WorkbookFullLoadContext,
  WorkbookFullLoadRequest,
  WorkbookFullLoadResult,
} from './types'

export const DEFAULT_FULL_LOAD_TIMEOUT_MS = 180_000

export function needsWorkbookFullLoad(state: LazyWorkbookState | null): boolean {
  return Boolean(state && !state.flags.preloadComplete)
}

function workbookDeclaredCellCount(state: LazyWorkbookState): number | null {
  let totalCells = 0
  for (const sheet of state.file.sheets) {
    const { rowCount, columnCount } = sheet
    if (
      !Number.isSafeInteger(rowCount) ||
      !Number.isSafeInteger(columnCount) ||
      rowCount < 0 ||
      columnCount < 0 ||
      rowCount >= Number.MAX_SAFE_INTEGER ||
      columnCount >= Number.MAX_SAFE_INTEGER
    ) {
      return null
    }
    const sheetCells = rowCount * columnCount
    if (
      !Number.isSafeInteger(sheetCells) ||
      sheetCells < 0 ||
      sheetCells >= Number.MAX_SAFE_INTEGER
    ) {
      return null
    }
    totalCells += sheetCells
    if (
      !Number.isSafeInteger(totalCells) ||
      totalCells < 0 ||
      totalCells >= Number.MAX_SAFE_INTEGER
    ) {
      return null
    }
  }
  return totalCells
}

interface SharedPreloadOperation {
  readonly promise: Promise<void>
  error: unknown | null
}

const inFlightPreloads = new WeakMap<LazyWorkbookState, SharedPreloadOperation>()

function ensurePreloadStarted(
  ctx: WorkbookFullLoadContext,
  state: LazyWorkbookState,
): SharedPreloadOperation | null {
  const existing = inFlightPreloads.get(state)
  if (existing) {
    return existing
  }
  if (state.flags.preloadRunning) {
    return null
  }

  const runtime = ctx.univerRef.current
  if (!runtime) {
    return null
  }

  const operationHolder: { current: SharedPreloadOperation | null } = { current: null }
  const promise = (async () => {
    try {
      await preloadEntireWorkbook(runtime, ctx.lazyWorkbookRef, () => undefined)
    } catch (err: unknown) {
      if (operationHolder.current) {
        operationHolder.current.error = err
      }
    } finally {
      if (operationHolder.current && inFlightPreloads.get(state) === operationHolder.current) {
        inFlightPreloads.delete(state)
      }
    }
  })()

  const operation: SharedPreloadOperation = {
    promise,
    error: null,
  }
  operationHolder.current = operation
  inFlightPreloads.set(state, operation)
  return operation
}

export async function ensureWorkbookFullyLoaded(
  ctx: WorkbookFullLoadContext,
  state: LazyWorkbookState,
  request: WorkbookFullLoadRequest,
): Promise<WorkbookFullLoadResult> {
  if (ctx.lazyWorkbookRef.current !== state) {
    return { status: 'stale-workbook' }
  }

  if (state.flags.preloadComplete) {
    return { status: 'ready' }
  }

  const totalCells = workbookDeclaredCellCount(state)
  if (totalCells === null) {
    return { status: 'failed', error: new Error('Invalid workbook dimensions') }
  }

  if (totalCells > request.maxCells) {
    return { status: 'too-large', totalCells, maxCells: request.maxCells }
  }

  const runtime = ctx.univerRef.current
  if (!runtime) {
    return { status: 'failed', error: new Error('Univer runtime not initialized') }
  }

  const operation = ensurePreloadStarted(ctx, state)

  try {
    await pollUntilReady(
      () =>
        ctx.lazyWorkbookRef.current !== state ||
        state.flags.preloadComplete ||
        Boolean(operation?.error) ||
        !state.flags.preloadRunning,
      'timeout',
      {
        timeoutMs: request.timeoutMs,
        pollMs: 50,
      },
    )
  } catch {
    if (ctx.lazyWorkbookRef.current === state) {
      return { status: 'timeout' }
    }
    return { status: 'stale-workbook' }
  }

  if (ctx.lazyWorkbookRef.current !== state) {
    return { status: 'stale-workbook' }
  }

  if (operation?.error) {
    return { status: 'failed', error: operation.error }
  }

  if (!state.flags.preloadComplete) {
    return {
      status: 'failed',
      error: new Error('Workbook preload ended before completion'),
    }
  }

  return { status: 'ready' }
}
