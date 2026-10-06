import type { DocumentMemoryStore } from '../store'
import type { TruncatedReason } from '../storage/repositories/document-repository'
import type { PdfScanInfo } from '../ocr-sidecar'

export interface ExtractResultPayload {
  hash: string
  mtimeMs: number
  sizeBytes: number
  chunks: Array<{ text: string; location: string; vector?: number[] }>
  status?: 'ready' | 'text-only' | 'empty' | 'error'
  error?: string
  truncated?: boolean
  truncatedReason?: TruncatedReason | null
  skipEmbeddings?: boolean
  totalPages?: number
  scanned?: number[] | boolean
  scan?: PdfScanInfo
}

export interface ExtractionCoordinatorOptions {
  store: DocumentMemoryStore
  pdfMaxPages?: number
  workerTimeoutMs?: number
}

export class ExtractionCoordinator {
  private pdfMaxPages: number
  private readonly workerTimeoutMs: number

  constructor(private readonly options: ExtractionCoordinatorOptions) {
    this.pdfMaxPages = options.pdfMaxPages ?? 100
    this.workerTimeoutMs = options.workerTimeoutMs ?? 60_000
  }

  get store(): DocumentMemoryStore {
    return this.options.store
  }

  getPdfMaxPages(): number {
    return this.pdfMaxPages
  }

  setPdfMaxPages(maxPages: number): number {
    const prior = this.pdfMaxPages
    this.pdfMaxPages = Math.max(1, Math.min(1000, maxPages))
    if (this.pdfMaxPages > prior) {
      return this.store.requeueTruncatedPdfs()
    }
    return 0
  }

  retryDocument(id: number): string | null {
    return this.store.retryDocument(id)
  }

  recordScanInfo(path: string, result: ExtractResultPayload): void {
    if (result.scan) {
      this.store.ocr.saveScanInfo(path, { mtimeMs: result.mtimeMs, sizeBytes: result.sizeBytes }, result.scan)
    } else if (result.totalPages !== undefined && Array.isArray(result.scanned)) {
      this.store.ocr.saveScanInfo(
        path,
        { mtimeMs: result.mtimeMs, sizeBytes: result.sizeBytes },
        { totalPages: result.totalPages, scannedPages: result.scanned },
      )
    }
  }
}
