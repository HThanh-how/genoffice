import type { DatabaseSync } from 'node:sqlite'
import type { RetentionDecision } from './retention-policy'
import {
  beginDocumentChunks,
  copyOcrSideRows,
  finalizeDocumentChunks,
  writeChunkSlice,
  writeOcrPages,
  type prepareMigrationStatements,
} from './data-copier'
import { CHUNK_CURSOR_START, nextChunkSlice, nextOcrSlice, withWalAmplification, type ChunkSource } from './chunk-pager'

/** Per-slice storage gate supplied by the runner: live remeasure + contract admission before BEGIN, reconcile after COMMIT. */
export interface SliceBudget {
  admit(estimatedBytes: number): void
  reconcile(): void
}

export interface OversizedDocumentCopy {
  chunks: number
  embeddings: number
  slices: number
}

/** Fixed small reservation for the document row / media row and for the final status settlement. */
const SMALL_STEP_BYTES = withWalAmplification(4 * 1024)

/**
 * Copies ONE document whose estimated growth exceeds the batch byte bound, in byte-bounded slices
 * (each slice = live remeasurement + admission, BEGIN IMMEDIATE, bounded writes, COMMIT, reconcile).
 *
 * Everything the single-transaction path guarantees still holds: every slice is admitted against the live quota and
 * free disk before it is written, the source stays read-only and untouched, the temp database is private and thrown
 * away on any failure (a crash mid-document leaves the V2 file as it was), and counters stay exact (chunk_total is
 * trigger-maintained, completed vector counts accumulate per slice, status / chunk_done are settled in the last
 * step). Only after the last slice does the document reach its final status, so a half-copied document can never
 * be verified as complete: any exception propagates and aborts the whole migration (fail closed).
 */
export function copyOversizedDocument(args: {
  sourceDb: DatabaseSync
  tempDb: DatabaseSync
  stmts: ReturnType<typeof prepareMigrationStatements>
  doc: any
  decision: RetentionDecision
  activeSpaceId: string
  activeDimensions: number
  maxSliceBytes: number
  budget: SliceBudget
  insertDocumentRows: () => void
}): OversizedDocumentCopy {
  const { sourceDb, tempDb, stmts, doc, decision, activeSpaceId, activeDimensions, maxSliceBytes, budget } = args
  let slices = 0

  const inSlice = <T>(bytes: number, write: () => T): T => {
    budget.admit(bytes)
    tempDb.exec('BEGIN IMMEDIATE')
    let result: T
    try {
      result = write()
      tempDb.exec('COMMIT')
    } catch (err) {
      tempDb.exec('ROLLBACK')
      throw err
    }
    budget.reconcile()
    slices++
    return result
  }

  // 1. document (+ media) row and the active chunk-set row
  const opened: { source: ChunkSource | null } = { source: null }
  inSlice(SMALL_STEP_BYTES, () => {
    args.insertDocumentRows()
    if (decision.shouldCopyChunksAndEmbeddings) opened.source = beginDocumentChunks(sourceDb, doc, stmts, activeSpaceId, activeDimensions)
  })
  if (!decision.shouldCopyChunksAndEmbeddings) return { chunks: 0, embeddings: 0, slices }

  // 2. chunks, byte-bounded
  const totals = { chunks: 0, embeddings: 0, truncated: false }
  const source = opened.source
  if (source) {
    let cursor = CHUNK_CURSOR_START
    for (;;) {
      const slice = nextChunkSlice(source, cursor, maxSliceBytes)
      cursor = slice.cursor
      if (slice.chunks.length > 0) {
        const written = inSlice(slice.bytes, () => writeChunkSlice(stmts, doc, slice.chunks, activeSpaceId))
        totals.chunks += written.chunks
        totals.embeddings += written.embeddings
        totals.truncated = totals.truncated || written.truncated
      }
      if (slice.done) break
    }
  }

  // 3. OCR pages, byte-bounded
  if (stmts.insertOcrPage) {
    let afterPage = -1
    for (;;) {
      const slice = nextOcrSlice(sourceDb, doc.path, afterPage, maxSliceBytes)
      afterPage = slice.lastPage
      if (slice.rows.length > 0) {
        inSlice(slice.bytes, () => writeOcrPages(stmts, slice.rows))
        totals.truncated = totals.truncated || slice.truncated
      }
      if (slice.done) break
    }
  }

  // 4. small side rows + final status / counter settlement
  inSlice(SMALL_STEP_BYTES, () => {
    copyOcrSideRows(sourceDb, doc.path, stmts)
    finalizeDocumentChunks(stmts, doc, activeSpaceId, totals)
  })
  return { chunks: totals.chunks, embeddings: totals.embeddings, slices }
}
