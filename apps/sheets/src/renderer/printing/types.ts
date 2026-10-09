import type { LazyWorkbookState, UniverRuntime } from '../univer-state'
import type { WorkbookExportPdfRequest } from '../../shared/desktop-api'

export type WorkbookFullLoadPurpose =
  'print' | 'pdf-export' | 'headless-export' | 'csv-export' | 'filter'

export interface WorkbookFullLoadRequest {
  readonly purpose: WorkbookFullLoadPurpose
  readonly maxCells: number
  readonly timeoutMs: number
}

export type WorkbookFullLoadResult =
  | { readonly status: 'ready' }
  | { readonly status: 'too-large'; readonly totalCells: number; readonly maxCells: number }
  | { readonly status: 'timeout' }
  | { readonly status: 'stale-workbook' }
  | { readonly status: 'failed'; readonly error: unknown }

export interface WorkbookFullLoadContext {
  readonly lazyWorkbookRef: {
    readonly current: LazyWorkbookState | null
  }
  readonly univerRef: {
    readonly current: UniverRuntime | null
  }
}

export interface PrintContext extends WorkbookFullLoadContext {
  readonly setMessage: (message: string) => void
  readonly requestVisualInstall?: () => void
}

export type PrintPayloadResult =
  | { readonly status: 'ready'; readonly payload: WorkbookExportPdfRequest }
  | { readonly status: 'too-large'; readonly totalCells: number; readonly maxCells: number }
  | { readonly status: 'timeout' }
  | { readonly status: 'stale-workbook' }
  | { readonly status: 'active-sheet-unavailable' }
  | { readonly status: 'failed'; readonly error: unknown }
