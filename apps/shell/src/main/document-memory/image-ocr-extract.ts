/**
 * Extraction of an image that has been read by the local OCR pass: the stored `ocr_pages` text
 * (keyed by path + SHA-256 of the file, like a scanned PDF) becomes ordinary chunks, so the usual
 * replace / FTS / embedding pipeline makes it searchable.
 *
 * Media rows stay lean until text exists: an image with no stored OCR (or only blank pages) produces
 * a result with zero chunks and `media: true`, which the manager stores as a finished `ready` row
 * (never `empty`, never an error), exactly the state enrollment gave it. Only a reindex requested by
 * the OCR job ever reaches this code; extraction is never queued for media on its own.
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { CHUNKER_VERSION } from './chunks'
import { MAX_OCR_IMAGE_BYTES } from './media/media-kinds'
import { ocrChunksFromPages, ocrDocumentHash, type OcrLookup } from './ocr-sidecar'

export async function extractImageOcrText(path: string, before: { mtimeMs: number; size: number }, ocr?: OcrLookup) {
  let chunks: ReturnType<typeof ocrChunksFromPages>['chunks'] = []
  let truncated = false
  let hash = ''
  if (ocr && before.size <= MAX_OCR_IMAGE_BYTES) {
    const bytes = await readFile(path)
    hash = createHash('sha256').update(bytes).digest('hex')
    const stored = ocr(path, hash)
    const pages = stored?.pages.filter((page) => page.text.trim()) ?? []
    if (stored && pages.length) {
      const read = ocrChunksFromPages({ totalPages: stored.totalPages, pages })
      chunks = read.chunks
      truncated = read.truncated
      hash = ocrDocumentHash(hash, pages)
    }
  }
  const after = await stat(path)
  if (before.mtimeMs !== after.mtimeMs || before.size !== after.size)
    throw new Error('Document changed during indexing; retry after saving')
  return {
    hash: hash || createHash('sha256').update(`${path}:${after.mtimeMs}:${after.size}`).digest('hex'),
    mtimeMs: after.mtimeMs,
    sizeBytes: after.size,
    chunks,
    chunkerVersion: CHUNKER_VERSION,
    status: chunks.length ? ('text-only' as const) : ('ready' as const),
    media: true as const,
    ...(truncated ? { truncated: true, truncatedReason: 'chunk-limit' as const } : {}),
  }
}
