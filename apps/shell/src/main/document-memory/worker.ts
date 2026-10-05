/** CPU extraction and real multilingual embeddings, isolated from Electron's UI thread. */
import { indexingWorkerData, postIndexMessage, onIndexRequest } from './runtime'
import { interruptBackgroundSleep, withBackgroundBudget } from './cpu-budget'
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { parseFileToText, pdfPageTextsSlice } from '@genoffice/file-parse'
import {
  capChunks,
  chunkDocumentTextV1,
  chunkDocumentTextV2,
  chunkTabularText,
  clampPdfPages,
  CHUNKER_VERSION,
  DEFAULT_PDF_PAGES,
} from './chunks'
import { DocumentMemoryStore } from './store'
import { embedTexts } from './embeddings'
import { renderPdfPagesForOcr, type OcrRenderRequest } from './agy-ocr-render'
import { ocrChunksFromPages, ocrDocumentHash, type OcrLookup } from './ocr-sidecar'
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
  if (before.size > 128 * 1024 * 1024) throw new Error('Document exceeds the 128 MB indexing limit')
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
  let truncated = base.truncated || pagesLeftOut
  const fileHash = createHash('sha256').update(bytes).digest('hex')
  let hash = fileHash
  let ocrRead = false
  if (scannedPages.length && ocr && isPdf) {
    // pages the user let Antigravity read: their transcription is added to whatever text the
    // PDF has itself (all of it for a pure scan, the missing pages for a mixed file)
    const stored = ocr(path, fileHash)
    const pages = stored?.pages.filter((page) => scannedPages.includes(page.page)) ?? []
    if (stored && pages.length) {
      ocrRead = true
      const fromOcr = ocrChunksFromPages({ totalPages: scannedPages.length, pages })
      chunks = capChunks([...chunks, ...fromOcr.chunks]).chunks
      truncated = truncated || fromOcr.truncated
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
    ...(truncated ? { truncated: true } : {}),
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
    interactive?: boolean
    sliceMs?: number
    maxPdfPages?: number
    ocr?: OcrRenderRequest
  }) => {
    const execute = async () => {
      try {
        let result: unknown
        const lookup: OcrLookup = (path, hash) =>
          (searchStore ??= new DocumentMemoryStore(indexingWorkerData.dbPath!)).ocr.pages(
            path,
            hash,
          )
        if (request.type === 'extract')
          result = request.interactive
            ? await extractDocument(request.path, lookup, request.maxPdfPages)
            : await withBackgroundBudget(() =>
                extractDocumentSliced(request.path, lookup, request.sliceMs, request.maxPdfPages),
              )
        else if (request.type === 'ocr-render')
          result = await withBackgroundBudget(() =>
            renderPdfPagesForOcr(request.path, request.ocr!),
          )
        else if (request.type === 'search') {
          searchStore ??= new DocumentMemoryStore(indexingWorkerData.dbPath!)
          result = searchStore.search(
            request.query,
            request.vector,
            request.limit,
            request.embeddingModel,
          )
        } else if (request.type === 'search-lexical') {
          searchStore ??= new DocumentMemoryStore(indexingWorkerData.dbPath!)
          result = searchStore.searchLexical(request.query, request.limit)
        } else if (request.type === 'search-semantic') {
          searchStore ??= new DocumentMemoryStore(indexingWorkerData.dbPath!)
          result = searchStore.searchSemantic(
            request.vector!,
            request.limit,
            request.embeddingSpaceId ?? request.embeddingModel,
          )
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
      request.type === 'search-semantic'
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
