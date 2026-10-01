/** CPU extraction and real multilingual embeddings, isolated from Electron's UI thread. */
import { indexingWorkerData, postIndexMessage, onIndexRequest } from './runtime'
import { interruptBackgroundSleep, withBackgroundBudget } from './cpu-budget'
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { parseFileToText } from '@genoffice/file-parse'
import { capChunks, chunkDocumentText, chunkTabularText } from './chunks'
import { DocumentMemoryStore } from './store'
import { embedTexts } from './embeddings'
export async function extractDocument(path: string) {
  const before = await stat(path)
  if (before.size > 128 * 1024 * 1024) throw new Error('Document exceeds the 128 MB indexing limit')
  const bytes = await readFile(path)
  const parsed = await parseFileToText(path)
  if (!parsed.ok || parsed.kind !== 'text')
    throw new Error(parsed.error || 'Cannot extract text from this document')
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
  const tabular = /^\.(csv|tsv)$/.test(extname(path).toLowerCase())
  const { chunks, truncated, numeric } = tabular
    ? chunkTabularText(text)
    : { ...capChunks(chunkDocumentText(text)), numeric: false }
  return {
    hash: createHash('sha256').update(bytes).digest('hex'),
    mtimeMs: after.mtimeMs,
    sizeBytes: after.size,
    chunks,
    status: chunks.length ? 'text-only' : 'empty',
    ...(truncated ? { truncated: true } : {}),
    // Numeric tables stay searchable through FTS; vectors for digits are wasted work.
    ...(numeric && chunks.length ? { skipEmbeddings: true } : {}),
    ...(chunks.length ? {} : { error: 'No readable text; scanned documents need OCR' }),
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
  }) => {
    const execute = async () => {
      try {
        let result: unknown
        if (request.type === 'extract')
          result = request.interactive
            ? await extractDocument(request.path)
            : await withBackgroundBudget(() => extractDocument(request.path))
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
