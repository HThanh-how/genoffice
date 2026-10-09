/** CPU extraction and real multilingual embeddings, isolated from Electron's UI thread. */
export type {
  WorkerRequest,
  WorkerReply,
  DocumentMemoryWorkerRequest,
  DocumentMemoryWorkerReply,
} from './worker-types'
import { indexingWorkerData, postIndexMessage, onIndexRequest } from './runtime'
import { backgroundCoolDown, interruptBackgroundSleep, withBackgroundBudget } from './cpu-budget'
import { performance } from 'node:perf_hooks'
import { handleCompactionRequest } from './runtime/worker-compaction'
import { isCompactionRequest, type CompactionWorkerRequest } from './runtime/worker-compaction-types'
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { parseFileToText, pdfPageTextsSlice } from '@genoffice/file-parse'
import {
  capChunks,
  chunkDocumentTextV2,
  chunkTabularText,
  clampPdfPages,
  CHUNKER_VERSION,
  DEFAULT_PDF_PAGES,
  type TruncatedReason,
} from './chunks'
import { DEFAULT_STORAGE_BUDGET, normalizeOvershootRatio, type DocumentIndexStorageBudget } from './storage-budget'

function isValidWorkerBudget(budget: unknown): budget is DocumentIndexStorageBudget {
  if (!budget || typeof budget !== 'object') return false
  const b = budget as Partial<DocumentIndexStorageBudget>
  return (
    typeof b.maxDatabaseBytes === 'number' &&
    Number.isFinite(b.maxDatabaseBytes) &&
    Number.isSafeInteger(b.maxDatabaseBytes) &&
    b.maxDatabaseBytes >= 500 * 1_000_000 &&
    b.maxDatabaseBytes <= 100 * 1_000_000_000
  )
}

function isValidWorkerVersion(version: unknown): version is number {
  return (
    typeof version === 'number' &&
    Number.isFinite(version) &&
    Number.isSafeInteger(version) &&
    version >= 0
  )
}

let workerStorageBudget: DocumentIndexStorageBudget =
  isValidWorkerBudget((indexingWorkerData as any)?.storageBudget)
    ? (indexingWorkerData as any).storageBudget
    : DEFAULT_STORAGE_BUDGET
let workerConfigVersion: number | null =
  isValidWorkerVersion((indexingWorkerData as any)?.configVersion)
    ? (indexingWorkerData as any).configVersion
    : null

export const MAX_INDEX_TEXT_CHARS = DEFAULT_STORAGE_BUDGET.maxExtractedCharactersPerFile
import { DocumentMemoryStore } from './store'
import { embedTexts } from './embeddings'
import { renderPdfPagesForOcr, type OcrRenderRequest } from './agy-ocr-render'
import { ocrChunksFromPages, ocrDocumentHash, type OcrLookup } from './ocr-sidecar'
import { extractImageOcrText } from './image-ocr-extract'
import { mediaKindOfPath } from './media/media-kinds'
import { prepareForTesseract } from './local-ocr/tesseract-prepare'
/** `ocr` finds text the scanned-PDF reader stored for a PDF that has no text layer of its own. */
/** A page with fewer characters than this has no usable text layer. */
const MIN_PAGE_TEXT_CHARS = 20

/** A PDF that is being read in turns: the pages read so far, kept until the file is finished. */
const partialPdfs = new Map<
  string,
  { mtimeMs: number; sizeBytes: number; pages: string[]; bytes: Buffer }
>()
// the file contents are kept too, so a turn does not read a big file again from a slow drive;
// a few files at most, since each is up to 128 MB
const MAX_PARTIAL_PDFS = 2

/** What one turn of reading a large PDF reports when the file is not finished yet. */
export interface PartialExtract {
  partial: true
  pagesDone: number
  totalPages: number
}

export async function extractDocument(path: string, ocr?: OcrLookup, maxPdfPages?: number) {
  const result = await extractDocumentSliced(path, ocr, undefined, maxPdfPages)
  if ('partial' in result) throw new Error('Document extraction stopped early')
  return result
}

/**
 * With `sliceMs`, a PDF is read for about that long and, if it is not finished, the pages read
 * so far are kept here and a partial result is returned; the next call for the same unchanged
 * file carries on after them. Without it the whole file is read at once.
 */
export async function extractDocumentSliced(
  path: string,
  ocr?: OcrLookup,
  sliceMs?: number,
  maxPdfPages = DEFAULT_PDF_PAGES,
) {
  const before = await stat(path)
  if (before.size > DEFAULT_STORAGE_BUDGET.maxFileBytes) throw new Error('Document exceeds the 128 MB indexing limit')
  // images: only the text the local OCR pass stored for them (media rows stay lean without it)
  if (mediaKindOfPath(path) === 'image') return extractImageOcrText(path, before, ocr)
  const kept = partialPdfs.get(path)
  const resumable = !!kept && kept.mtimeMs === before.mtimeMs && kept.sizeBytes === before.size
  const bytes = resumable ? kept.bytes : await readFile(path)
  const isPdf = /\.pdf$/i.test(path)
  // PDFs are read page by page so pages without a text layer (scans inside an otherwise
  // digital file) can be told apart: those alone are OCR work, everything else stays local.
  let pdfPages: string[] | null = null
  let pagesLeftOut = false
  if (isPdf) {
    const resumed = resumable ? kept.pages : []
    const slice = await pdfPageTextsSlice(bytes, {
      from: resumed.length,
      maxPages: clampPdfPages(maxPdfPages),
      ...(sliceMs ? { stopAt: Date.now() + sliceMs } : {}),
    }).catch(() => null)
    partialPdfs.delete(path)
    if (slice) {
      // pages kept from an earlier turn may be more than a limit that was lowered since
      pdfPages = [...resumed, ...slice.pages].slice(0, clampPdfPages(maxPdfPages))
      pagesLeftOut = slice.capped || slice.total > pdfPages.length
      if (!slice.done) {
        partialPdfs.set(path, {
          mtimeMs: before.mtimeMs,
          sizeBytes: before.size,
          pages: pdfPages,
          bytes,
        })
        while (partialPdfs.size > MAX_PARTIAL_PDFS)
          partialPdfs.delete(partialPdfs.keys().next().value!)
        return {
          partial: true,
          pagesDone: pdfPages.length,
          totalPages: slice.total,
        } satisfies PartialExtract
      }
    }
  }
  const parsed = pdfPages
    ? ({ ok: true, kind: 'text', text: pdfPages.join('\n\n') } as const)
    : await parseFileToText(path)
  if (!parsed.ok || parsed.kind !== 'text')
    throw new Error(parsed.error || 'Cannot extract text from this document')
  const scannedPages = pdfPages
    ? pdfPages.flatMap((text, index) =>
        text.trim().length < MIN_PAGE_TEXT_CHARS ? [index + 1] : [],
      )
    : []
  const after = await stat(path)
  if (before.mtimeMs !== after.mtimeMs || before.size !== after.size)
    throw new Error('Document changed during indexing; retry after saving')
  let text = parsed.text ?? ''
  if (/^\.(html|htm)$/.test(extname(path).toLowerCase())) {
    text = text
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
  }
  let contentTruncated = false
  if (text.length > MAX_INDEX_TEXT_CHARS) {
    text = text.slice(0, MAX_INDEX_TEXT_CHARS)
    contentTruncated = true
  }
  // Cost control: tabular exports index header + sampled rows; everything else is capped.
  const tabular = /^\.(csv|tsv|xls)$/.test(extname(path).toLowerCase())
  const base = tabular
    ? chunkTabularText(text)
    : {
        ...capChunks(
          chunkDocumentTextV2(text, {
            title: path.split(/[\\/]/).pop(),
          }),
        ),
        numeric: false,
      }
  const numeric = base.numeric
  let chunks = base.chunks
  let truncated = base.truncated || pagesLeftOut || contentTruncated
  let truncatedReason: TruncatedReason | undefined
  if (contentTruncated) {
    truncatedReason = 'content-limit'
  } else if (base.truncated) {
    truncatedReason = base.truncatedReason ?? (tabular ? 'tabular-sampling' : 'chunk-limit')
  } else if (pagesLeftOut) {
    truncatedReason = 'pdf-page-limit'
  }
  const fileHash = createHash('sha256').update(bytes).digest('hex')
  let hash = fileHash
  let ocrRead = false
  if (scannedPages.length && ocr && isPdf) {
    const pagesToOcr = scannedPages.slice(0, DEFAULT_STORAGE_BUDGET.maxOcrPagesPerFile)
    if (scannedPages.length > DEFAULT_STORAGE_BUDGET.maxOcrPagesPerFile) {
      truncated = true
      truncatedReason = truncatedReason ?? 'pdf-page-limit'
    }
    // pages the user let Antigravity read: their transcription is added to whatever text the
    // PDF has itself (all of it for a pure scan, the missing pages for a mixed file)
    const stored = ocr(path, fileHash)
    const pages = stored?.pages.filter((page) => pagesToOcr.includes(page.page)) ?? []
    if (stored && pages.length) {
      ocrRead = true
      const fromOcr = ocrChunksFromPages({ totalPages: scannedPages.length, pages })
      const capped = capChunks([...chunks, ...fromOcr.chunks])
      chunks = capped.chunks
      if (capped.truncated || fromOcr.truncated) {
        truncated = true
        truncatedReason = truncatedReason ?? 'chunk-limit'
      }
      hash = ocrDocumentHash(fileHash, pages)
    }
  }
  return {
    hash,
    mtimeMs: after.mtimeMs,
    sizeBytes: after.size,
    chunks,
    chunkerVersion: CHUNKER_VERSION,
    status: chunks.length ? 'text-only' : 'empty',
    ...(truncated ? { truncated: true, ...(truncatedReason ? { truncatedReason } : {}) } : {}),
    // Pages with no text layer, so the OCR reader knows which pages (and only those) to read.
    ...(pdfPages && scannedPages.length
      ? { scan: { totalPages: pdfPages.length, scannedPages } }
      : {}),
    // Numeric tables stay searchable through FTS; vectors for digits are wasted work.
    ...(numeric && chunks.length ? { skipEmbeddings: true } : {}),
    ...(chunks.length
      ? {}
      : {
          error: ocrRead
            ? 'No readable text; the scanned pages were read but contained no text'
            : isPdf
              ? 'No readable text; scanned documents need OCR'
              : 'No readable text in this file; there is nothing to search',
        }),
  }
}

// Serialize extraction and embedding on one queue so the background CPU budget really bounds
// the sustained load (they used to overlap). Interactive work (query embeddings, verification
// reads) goes first and wakes a budget sleep instead of waiting behind it.
interface QueuedTask {
  run: () => Promise<void>
  /** Reports a timeout to the requester; the queue then moves on without the stuck step. */
  onTimeout: () => void
}
// A step that never settles (a parser or native call that stalls without using CPU) must not
// block everything queued behind it. The requester gets an error and the queue continues.
const TASK_TIMEOUT_MS = 150_000
const urgent: QueuedTask[] = []
const background: QueuedTask[] = []
let pumping = false
let stalled = false
async function pump(): Promise<void> {
  if (pumping || stalled) return
  pumping = true
  try {
    for (;;) {
      const task = urgent.shift() ?? background.shift()
      if (!task) break
      let timer: NodeJS.Timeout | undefined
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), TASK_TIMEOUT_MS)
      })
      try {
        if (
          (await Promise.race([task.run().then(() => 'done' as const), timedOut])) === 'timeout'
        ) {
          // A timed-out native operation still owns this process. Starting another one can
          // overlap model sessions and exhaust memory; the manager replaces the stuck worker.
          stalled = true
          task.onTimeout()
          break
        }
      } finally {
        clearTimeout(timer)
      }
    }
  } finally {
    pumping = false
  }
}
function schedule(task: QueuedTask, interactive: boolean): void {
  if (interactive) {
    urgent.push(task)
    interruptBackgroundSleep()
  } else background.push(task)
  void pump()
}
let searchStore: DocumentMemoryStore | undefined
function getWorkerStore(): DocumentMemoryStore {
  return (searchStore ??= new DocumentMemoryStore(indexingWorkerData.dbPath!, {
    role: 'worker',
    getStorageBudget: () => workerStorageBudget,
    getConfigVersion: () => workerConfigVersion,
  }))
}

/**
 * Cooperative yield of the compaction lane between batches. Urgent (grace zone) runs only hand the event loop to
 * pending requests; background runs also honour the indexing duty cycle (cool-down proportional to active time).
 */
let lastCompactionYield = performance.now()
async function compactionYield(urgent: boolean): Promise<void> {
  const activeMs = Math.max(0, performance.now() - lastCompactionYield)
  if (urgent) await new Promise<void>((resolve) => setImmediate(resolve))
  else await backgroundCoolDown(activeMs)
  lastCompactionYield = performance.now()
}

/** Storage-compaction lane: its own single-flight, outside the extraction/embedding queue and its 150 s timeout. */
function runCompactionLane(request: CompactionWorkerRequest & { id: number }): void {
  lastCompactionYield = performance.now()
  void handleCompactionRequest(
    {
      store: getWorkerStore(),
      getBudget: () => workerStorageBudget,
      getConfigVersion: () => workerConfigVersion,
      yieldNow: compactionYield,
    },
    request,
  )
    .then((result) => postIndexMessage({ id: request.id, result }))
    .catch((error) =>
      postIndexMessage({ id: request.id, error: error instanceof Error ? error.message : 'Compaction failed' }),
    )
}

onIndexRequest(
  (request: {
    id: number
    type: string
    path: string
    texts: string[]
    kind: 'query' | 'passage'
    query: string
    vector: number[] | null
    limit: number
    embeddingModel: string
    embeddingSpaceId?: string
    spaceId?: string
    hostPermit?: any
    interactive?: boolean
    sliceMs?: number
    maxPdfPages?: number
    ocr?: OcrRenderRequest
    bytes?: Uint8Array
    dpi?: number
    backupPath?: string
    dbPath?: string
    budget?: DocumentIndexStorageBudget
    configVersion?: number
  }) => {
    if (isCompactionRequest(request)) {
      runCompactionLane(request as CompactionWorkerRequest & { id: number })
      return
    }
    const execute = async () => {
      try {
        let result: unknown
        const lookup: OcrLookup = (path, hash) => getWorkerStore().ocr.pages(path, hash)
        if (request.type === 'extract')
          result = request.interactive
            ? await extractDocument(request.path, lookup, request.maxPdfPages)
            : await withBackgroundBudget(() =>
                extractDocumentSliced(request.path, lookup, request.sliceMs, request.maxPdfPages),
              )
        else if (request.type === 'ocr-render')
          result = await withBackgroundBudget(() =>
            renderPdfPagesForOcr(
              request.path,
              request.ocr ?? { count: 1, maxPages: 1000, done: [] },
            ),
          )
        else if (request.type === 'ocr-prepare')
          // CPU-bound decode / shrink / flatten of an image for the Tesseract engine (kept off the main thread)
          result = await withBackgroundBudget(async () => prepareForTesseract(request.bytes!, request.dpi ?? 150))
        else if (request.type === 'search') {
          result = getWorkerStore().search(
            request.query,
            request.vector,
            request.limit,
            request.embeddingModel,
          )
        } else if (request.type === 'search-lexical') {
          result = getWorkerStore().searchLexical(request.query, request.limit)
        } else if (request.type === 'search-semantic') {
          result = getWorkerStore().searchSemantic(
            request.vector!,
            request.limit,
            request.embeddingSpaceId ?? request.embeddingModel,
          )
        } else if (request.type === 'ann-rebuild' || request.type === 'ann-sync') {
          const targetSpace = request.spaceId ?? request.embeddingSpaceId ?? request.embeddingModel
          result = await getWorkerStore().rebuildAnnIndex(
            targetSpace,
            request.hostPermit,
          )
        } else if (request.type === 'fts-maintenance-step') {
          const started = Date.now()
          const more = await withBackgroundBudget(async () => getWorkerStore().mergeFtsStep())
          result = { more: Boolean(more), durationMs: Date.now() - started }
        } else if (request.type === 'gc-step') {
          const started = Date.now()
          const gcStats = await withBackgroundBudget(async () => getWorkerStore().runMaintenanceGc())
          result = { gcStats, durationMs: Date.now() - started }
        } else if (request.type === 'vacuum-step') {
          const started = Date.now()
          const vacuumResult = await withBackgroundBudget(async () =>
            getWorkerStore().runIncrementalVacuum({ maxPages: 256, batchPages: 256 }),
          )
          result = { vacuumResult, durationMs: Date.now() - started }
        } else if (request.type === 'set-storage-budget') {
          const targetBudget = request.budget
          const targetVersion = request.configVersion

          if (!isValidWorkerBudget(targetBudget)) {
            result = {
              ok: false,
              appliedVersion: workerConfigVersion,
              desiredVersion: isValidWorkerVersion(targetVersion) ? targetVersion : -1,
              appliedBudgetBytes: workerStorageBudget.maxDatabaseBytes,
              error: 'Invalid storage budget: maxDatabaseBytes must be a safe integer between 500 MB and 100 GB',
            }
          } else if (!isValidWorkerVersion(targetVersion)) {
            result = {
              ok: false,
              appliedVersion: workerConfigVersion,
              desiredVersion: -1,
              appliedBudgetBytes: workerStorageBudget.maxDatabaseBytes,
              error: 'Invalid configVersion: must be a non-negative safe integer',
            }
          } else if (workerConfigVersion !== null && targetVersion < workerConfigVersion) {
            // Stale version rejected monotonically: reply truthfully with current applied version
            result = {
              ok: false,
              appliedVersion: workerConfigVersion,
              desiredVersion: targetVersion,
              appliedBudgetBytes: workerStorageBudget.maxDatabaseBytes,
              error: `Stale configVersion ${targetVersion} is less than currently applied ${workerConfigVersion}`,
            }
          } else {
            // Monotonic valid version application
            workerStorageBudget = targetBudget
            workerConfigVersion = targetVersion
            if (searchStore) {
              searchStore.setStorageBudget(workerStorageBudget)
            }
            result = {
              ok: true,
              appliedVersion: workerConfigVersion,
              desiredVersion: targetVersion,
              appliedBudgetBytes: workerStorageBudget.maxDatabaseBytes,
              appliedOvershootRatio: normalizeOvershootRatio(workerStorageBudget.overshootRatio),
            }
          }
        } else if (request.type === 'storage-diagnostics') {
          // Off-main storage diagnostics isolating heavy SQL and file inspection from UI thread
          const budget = (request as any).budget ?? workerStorageBudget
          result = getWorkerStore().getStorageDiagnostics(request.backupPath, budget)
        } else result = await embedTexts(request.texts, request.kind)
        postIndexMessage({ id: request.id, result })
      } catch (error) {
        postIndexMessage({
          id: request.id,
          error: error instanceof Error ? error.message : 'Indexing failed',
        })
      }
    }
    if (
      request.type === 'search' ||
      request.type === 'search-lexical' ||
      request.type === 'search-semantic' ||
      request.type === 'storage-diagnostics' ||
      request.type === 'set-storage-budget'
    )
      void execute()
    else
      schedule(
        {
          run: execute,
          onTimeout: () =>
            postIndexMessage({
              id: request.id,
              error: 'Indexing step timed out and was restarted',
              restartRequired: true,
            }),
        },
        request.interactive === true || request.kind === 'query',
      )
  },
)
