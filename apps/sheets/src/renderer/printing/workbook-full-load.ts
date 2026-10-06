import { pollUntilReady } from '@genoffice/electron-utils/headless-export'
import { FULL_LOAD_MAX_CELLS } from '../app-constants'
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
      columnCount < 0
    ) {
      return null
    }
    const sheetCells = rowCount * columnCount
    if (!Number.isSafeInteger(sheetCells) || sheetCells < 0) {
      return null
    }
    totalCells += sheetCells
    if (!Number.isSafeInteger(totalCells) || totalCells < 0) {
      return null
    }
  }
  return totalCells
}

const inFlightLoads = new WeakMap<LazyWorkbookState, Promise<WorkbookFullLoadResult>>()

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

  const existingLoad = inFlightLoads.get(state)
  if (existingLoad) {
    return existingLoad
  }

  const promise = performFullLoad(ctx, state, request)
  inFlightLoads.set(state, promise)
  try {
    return await promise
  } finally {
    if (inFlightLoads.get(state) === promise) {
      inFlightLoads.delete(state)
    }
  }
}

async function performFullLoad(
  ctx: WorkbookFullLoadContext,
  state: LazyWorkbookState,
  request: WorkbookFullLoadRequest,
): Promise<WorkbookFullLoadResult> {
  if (ctx.lazyWorkbookRef.current !== state) {
    return { status: 'stale-workbook' }
  }

  const runtime = ctx.univerRef.current
  if (!runtime) {
    return { status: 'failed', error: new Error('Univer runtime not initialized') }
  }

  let preloadFailed = false
  let preloadError: unknown = null
  if (!state.flags.preloadRunning) {
    void preloadEntireWorkbook(runtime, ctx.lazyWorkbookRef, () => undefined).catch((err) => {
      preloadFailed = true
      preloadError = err
    })
  }

  try {
    await pollUntilReady(
      () =>
        ctx.lazyWorkbookRef.current !== state ||
        state.flags.preloadComplete ||
        preloadFailed ||
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

  if (preloadFailed) {
    return { status: 'failed', error: preloadError }
  }

  if (!state.flags.preloadComplete) {
    return {
      status: 'failed',
      error: new Error('Workbook preload ended before completion'),
    }
  }

  return { status: 'ready' }
}
