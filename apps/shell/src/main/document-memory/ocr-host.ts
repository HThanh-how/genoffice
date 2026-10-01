import type { DocumentMemoryStore } from './store'
import type { OcrRenderRequest, OcrRenderResult } from './agy-ocr-render'
import type { OcrJobHost } from './agy-ocr-job'

export interface OcrHostInput {
  store: Pick<DocumentMemoryStore, 'ocr' | 'documentById'>
  /** ask the index process to render pages; resolves null when it did not answer in time */
  renderInWorker(path: string, request: OcrRenderRequest): Promise<OcrRenderResult | null>
  /** queue a document for (prioritised) re-extraction */
  reindex(path: string): void
  isEnabled(): boolean
}

/** Binds the OCR job to a document-memory manager's store, index process and queue. */
export function createOcrHost(input: OcrHostInput): OcrJobHost {
  const { store } = input
  return {
    isEnabled: () => input.isEnabled(),
    candidates: (maxPagesPerFile) => store.ocr.candidates(maxPagesPerFile),
    documentById: (id) => {
      const document = store.documentById(id)
      return document && document.status !== 'excluded'
        ? { id: document.id, path: document.path }
        : null
    },
    pagesDone: (path, mtimeMs, sizeBytes) => store.ocr.pagesDone(path, mtimeMs, sizeBytes),
    render: (path, request) => input.renderInWorker(path, request),
    savePages: (path, meta, pages) => store.ocr.savePages(path, meta, pages),
    reindex: (path) => input.reindex(path),
  }
}
