import type { DocumentMemoryStore } from './store'
import type { OcrRenderRequest, OcrRenderResult } from './agy-ocr-render'
import type { OcrJobHost, OcrSavePagesResult } from './agy-ocr-job'
import type { OcrFileMeta, OcrPageText } from './ocr-sidecar'
import type { StorageAdmissionController } from './runtime/storage-admission'
import type { MaintenanceScheduler } from './runtime/maintenance-scheduler'
import type { StorageBudgetCoordinator } from './runtime/storage-budget-coordinator'
import { persistOcrPagesGated, executeOcrRenderGated } from './runtime/ocr-write-budget'

export interface OcrHostInput {
  store: Pick<DocumentMemoryStore, 'ocr' | 'documentById'>
  isEnabled(): boolean
  isStopped?(): boolean
  sourceAvailable?(path: string): Promise<boolean>
  sourceRoot?(path: string): string
  sourceSelectable?(path: string): boolean
  sourceOffline?(path: string): void
  /**
   * A local OCR engine is on and able to run: automatic cloud reading then leaves files the local
   * pass has not reached yet to it, and only ever sees the pages the local engine escalated.
   */
  localFirst?(): boolean
  admission?: StorageAdmissionController
  maintScheduler?: MaintenanceScheduler
  budgetCoord?: StorageBudgetCoordinator
  dbDir?: string
  askWorker?: (req: any, timeoutMs?: number) => Promise<any>
  workerTimeoutMs?: number
  /** ask the index process to render pages; resolves null when it did not answer in time */
  renderInWorker?(path: string, request: OcrRenderRequest): Promise<OcrRenderResult | null>
  /** queue a document for (prioritised) re-extraction */
  onSourcesRecovered?(clear: (paths: string[]) => boolean): () => void
  reindex(path: string): void
  /** read a document now and resolve once its new text is searchable (rejects with why not) */
  reindexNow?(path: string): Promise<void>
  /** optional custom persistence gate */
  savePages?(
    path: string,
    meta: OcrFileMeta,
    pages: readonly OcrPageText[],
  ): Promise<OcrSavePagesResult>
}

/** Binds the OCR job to a document-memory manager's store, index process and queue. */
export function createOcrHost(input: OcrHostInput): OcrJobHost {
  const { store } = input
  return {
    isEnabled: () => input.isEnabled(),
    ...(input.onSourcesRecovered ? { onSourcesRecovered: input.onSourcesRecovered } : {}),
    recordSourceFailure: (path, meta, code, detail) =>
      store.ocr.recordLocalFailure(path, meta, code, false, detail),
    candidates: (maxPagesPerFile, options) =>
      store.ocr
        .candidates(
          maxPagesPerFile,
          options?.manual
            ? { mode: 'cloud-all' }
            : { mode: 'cloud', leaveToLocal: input.localFirst?.() === true },
        )
        .filter((row) => input.sourceSelectable?.(row.path) ?? true),
    documentById: (id) => {
      const document = store.documentById(id)
      return document && document.status !== 'excluded'
        ? { id: document.id, path: document.path }
        : null
    },
    pagesDone: (path, mtimeMs, sizeBytes) => store.ocr.pagesDone(path, mtimeMs, sizeBytes),
    render: async (path, request) => {
      if (input.sourceAvailable && !(await input.sourceAvailable(path)))
        return {
          ok: false,
          code: 'offline',
          message: 'The drive or folder is not connected; reading resumes automatically.',
        }
      let result: OcrRenderResult | null = null
      if (input.sourceRoot) request = { ...request, sourceRoot: input.sourceRoot(path) }
      if (input.renderInWorker) {
        result = await input.renderInWorker(path, request)
      } else if (input.admission && input.maintScheduler && input.budgetCoord && input.askWorker) {
        result = await executeOcrRenderGated({
          admission: input.admission,
          maintScheduler: input.maintScheduler,
          budgetCoord: input.budgetCoord,
          dbDir: input.dbDir ?? '',
          path,
          request,
          isStopped: input.isStopped,
          isEnabled: () => input.isEnabled(),
          workerTimeoutMs: input.workerTimeoutMs,
          askWorker: input.askWorker,
        })
      }
      if (result && !result.ok && result.code === 'offline') input.sourceOffline?.(path)
      return result
    },
    savePages: async (path, meta, pages) => {
      if (input.savePages) {
        return input.savePages(path, meta, pages)
      }
      if (input.admission && input.maintScheduler && input.budgetCoord) {
        return persistOcrPagesGated({
          store,
          admission: input.admission,
          maintScheduler: input.maintScheduler,
          budgetCoord: input.budgetCoord,
          dbDir: input.dbDir ?? '',
          path,
          meta,
          pages,
          isStopped: input.isStopped,
          isEnabled: () => input.isEnabled(),
        })
      }
      return {
        ok: false,
        code: 'quota-denied',
        error: 'OCR persistence admission is not configured',
      }
    },
    reindex: (path) => input.reindex(path),
    ...(input.reindexNow ? { reindexNow: (path: string) => input.reindexNow!(path) } : {}),
  }
}
