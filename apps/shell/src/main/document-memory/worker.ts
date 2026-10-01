/** CPU extraction and real multilingual embeddings, isolated from Electron's UI thread. */
import { indexingWorkerData, postIndexMessage, onIndexRequest } from './runtime'
import { withBackgroundBudget } from './cpu-budget'
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { parseFileToText } from '@genoffice/file-parse'
import { chunkDocumentText } from './chunks'
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
  const chunks = chunkDocumentText(text)
  return {
    hash: createHash('sha256').update(bytes).digest('hex'),
    mtimeMs: after.mtimeMs,
    sizeBytes: after.size,
    chunks,
    status: chunks.length ? 'text-only' : 'empty',
    ...(chunks.length ? {} : { error: 'No readable text; scanned documents need OCR' }),
  }
}

// Serialize requests so concurrent searches cannot race model initialization or extraction.
let queue = Promise.resolve()
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
  }) => {
    const execute = async () => {
      try {
        let result: unknown
        if (request.type === 'extract')
          result = await withBackgroundBudget(() => extractDocument(request.path))
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
    if (request.type === 'extract' || request.type === 'search') void execute()
    else queue = queue.then(execute)
  },
)
