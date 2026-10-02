/** CPU extraction and real multilingual embeddings, isolated from Electron's UI thread. */
import { indexingWorkerData, postIndexMessage, onIndexRequest } from './runtime'
import { interruptBackgroundSleep, withBackgroundBudget } from './cpu-budget'
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { parseFileToText, pdfPageTexts } from '@genoffice/file-parse'
import { capChunks, chunkDocumentText, chunkTabularText } from './chunks'
import { DocumentMemoryStore } from './store'
import { embedTexts } from './embeddings'
import { renderPdfPagesForOcr, type OcrRenderRequest } from './agy-ocr-render'
import { ocrChunksFromPages, ocrDocumentHash, type OcrLookup } from './ocr-sidecar'
/** `ocr` finds text the scanned-PDF reader stored for a PDF that has no text layer of its own. */
/** A page with fewer characters than this has no usable text layer. */
const MIN_PAGE_TEXT_CHARS = 20

export async function extractDocument(path: string, ocr?: OcrLookup) {
  const before = await stat(path)
  if (before.size > 128 * 1024 * 1024) throw new Error('Document exceeds the 128 MB indexing limit')
  const bytes = await readFile(path)
  const isPdf = /\.pdf$/i.test(path)
  // PDFs are read page by page so pages without a text layer (scans inside an otherwise
  // digital file) can be told apart: those alone are OCR work, everything else stays local.
  const pdfPages = isPdf ? await pdfPageTexts(bytes).catch(() => null) : null
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
    : { ...capChunks(chunkDocumentText(text)), numeric: false }
  const numeric = base.numeric
  let chunks = base.chunks
  let truncated = base.truncated
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
            : 'No readable text; scanned documents need OCR',
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
async function pump(): Promise<void> {
  if (pumping) return
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
        if ((await Promise.race([task.run().then(() => 'done' as const), timedOut])) === 'timeout')
          task.onTimeout()
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
    interactive?: boolean
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
            ? await extractDocument(request.path, lookup)
            : await withBackgroundBudget(() => extractDocument(request.path, lookup))
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
        } else result = await embedTexts(request.texts, request.kind)
        postIndexMessage({ id: request.id, result })
      } catch (error) {
        postIndexMessage({
          id: request.id,
          error: error instanceof Error ? error.message : 'Indexing failed',
        })
      }
    }
    if (request.type === 'search') void execute()
    else
      schedule(
        {
          run: execute,
          onTimeout: () =>
            postIndexMessage({ id: request.id, error: 'Indexing step timed out and was skipped' }),
        },
        request.interactive === true || request.kind === 'query',
      )
  },
)
