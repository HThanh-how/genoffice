import type { Extracted } from './extract'
import type { ScannedFile } from './scan'
import { FileIndexStore } from './store'

/**
 * Writes the file index runs in the extraction worker thread instead of on Electron's main thread.
 *
 * Indexing a parsed document means tokenizing its text (up to a million characters) and inserting it into two
 * full-text columns sets: 100-300 ms of synchronous work per large file, repeated for every file of a drive, each time
 * a stall for every window of the app. The worker thread already holds the parsed text, so it writes it too, through
 * its own connection; the main thread keeps only reads (search, listing) and sends batches of names.
 */
export type WriterRequest =
  | { id: number; type: 'pending'; files: ScannedFile[] }
  | { id: number; type: 'remove'; paths: string[] }
  /** Parse the file in the worker and write the result there: the text never travels to the main thread. */
  | { id: number; type: 'index'; file: ScannedFile; preserve: boolean }
  /** The parse timed out or the worker died: record the failure (unless a cached body must survive). */
  | { id: number; type: 'index-error'; file: ScannedFile; preserve: boolean; error: string }

export type WriterResponse = {
  id: number
  type: 'written'
  error?: string
  status?: Extracted['kind']
}

export function isWriterRequest(req: { type?: string }): req is WriterRequest {
  return (
    req.type === 'pending' ||
    req.type === 'remove' ||
    req.type === 'index' ||
    req.type === 'index-error'
  )
}

/** What `FileIndexer.apply` did on the main thread, as one function the worker (and the tests) can call. */
export function applyExtracted(
  store: Pick<FileIndexStore, 'upsert'>,
  file: ScannedFile,
  result: Extracted,
  preserve: boolean,
): void {
  if (result.kind === 'text') store.upsert(file, result.text, 'ok')
  else if (result.kind === 'name-only') store.upsert(file, null, 'name-only')
  else if (!preserve) store.upsert(file, null, 'error')
}

export async function handleWriterRequest(
  store: FileIndexStore,
  req: WriterRequest,
  extract: (path: string) => Promise<Extracted>,
): Promise<WriterResponse> {
  try {
    if (req.type === 'pending') store.upsertPendingBatch(req.files)
    else if (req.type === 'remove') store.remove(req.paths)
    else if (req.type === 'index-error')
      applyExtracted(store, req.file, { kind: 'error', error: req.error }, req.preserve)
    else {
      const result = await extract(req.file.path)
      applyExtracted(store, req.file, result, req.preserve)
      return { id: req.id, type: 'written', status: result.kind }
    }
    return { id: req.id, type: 'written' }
  } catch (error) {
    // a corrupt row must not stall the queue; the next scan retries it
    return {
      id: req.id,
      type: 'written',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
