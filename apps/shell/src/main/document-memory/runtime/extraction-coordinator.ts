import { stat } from 'node:fs/promises'
import type { DocumentMemoryStore, StoredDocument } from '../store'
import type { DocumentChunk } from '../chunks'
import type { TruncatedReason } from '../storage/repositories/document-repository'
import type { PdfScanInfo } from '../ocr-sidecar'

export interface ExtractResult {
  hash: string
  mtimeMs: number
  sizeBytes: number
  chunks: DocumentChunk[]
  chunkerVersion?: number
  status?: 'ready' | 'text-only' | 'empty' | 'error'
  error?: string
  truncated?: boolean
  truncatedReason?: TruncatedReason | null
  skipEmbeddings?: boolean
  totalPages?: number
  scanned?: number[] | boolean
  scan?: PdfScanInfo
  /** an image read from its stored OCR text: with no text it stays a finished `ready` media row */
  media?: true
}

export type ExtractResultPayload = ExtractResult

export const READ_NOW_ATTEMPTS = 3
export const INTERRUPTED_FOR_USER = 'Paused so a file you chose could be read first.'
export const MAX_PENDING_EMBED_DOCUMENTS = 16
export const PDF_SLICE_MS = 10_000

export async function statMeta(p: string): Promise<{ mtimeMs: number; sizeBytes: number } | null> {
  try { const s = await stat(p); return { mtimeMs: s.mtimeMs, sizeBytes: s.size } } catch { return null }
}
export function extractedStatus(r: ExtractResult): 'text-only' | 'empty' | 'ready' {
  if (!r.chunks.length) return r.media ? 'ready' : 'empty'
  return r.skipEmbeddings ? 'ready' : 'text-only'
}
export function isPartialExtract(v: unknown): v is { partial: true; pagesDone: number; totalPages: number } {
  const r = v as { partial?: unknown; pagesDone?: unknown; totalPages?: unknown } | null
  return !!r && r.partial === true && typeof r.pagesDone === 'number' && typeof r.totalPages === 'number'
}
export function isExtractResult(v: unknown): v is ExtractResult {
  if (!v || typeof v !== 'object') return false
  const r = v as Partial<ExtractResult>
  return typeof r.hash === 'string' && typeof r.mtimeMs === 'number' && Array.isArray(r.chunks)
}
export function readOutcome(doc: StoredDocument | null | undefined): { ok: boolean; error?: string; empty?: boolean } {
  if (doc?.error) return { ok: false, error: doc.error }
  if (doc?.status === 'error') return { ok: false, error: doc.error ?? 'Could not be read' }
  if (doc?.status === 'empty') return { ok: true, empty: true }
  return doc?.status === 'pending' ? { ok: false, error: 'not finished' } : { ok: true }
}

import { readPdfPages, writePdfPages } from '../pdf-pages'
import { clampPdfPages, DEFAULT_PDF_PAGES } from '../chunks'

export interface ExtractionCoordinatorOptions {
  store: DocumentMemoryStore
  pdfMaxPages?: number
  pdfPagesPath?: string
  workerTimeoutMs?: number
}

export class ExtractionCoordinator {
  private pdfMaxPages: number
  private readonly workerTimeoutMs: number

  constructor(private readonly options: ExtractionCoordinatorOptions) {
    this.pdfMaxPages = options.pdfPagesPath ? readPdfPages(options.pdfPagesPath) : (options.pdfMaxPages ?? DEFAULT_PDF_PAGES)
    this.workerTimeoutMs = options.workerTimeoutMs ?? 60_000
  }

  get store(): DocumentMemoryStore {
    return this.options.store
  }

  getPdfMaxPages(): number {
    return this.pdfMaxPages
  }

  setPdfMaxPages(maxPages: number, settingsPath?: string): { pages: number; requeued: number } {
    const clamped = clampPdfPages(maxPages)
    const prior = this.pdfMaxPages
    this.pdfMaxPages = clamped
    if (settingsPath) writePdfPages(settingsPath, clamped)
    const requeued = clamped > prior ? this.store.requeueTruncatedPdfs() : 0
    return { pages: clamped, requeued }
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
