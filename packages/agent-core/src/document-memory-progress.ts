/** Durable indexing state for one document. Percent is null until chunk totals are known. */
export interface DocumentIndexProgress {
  path?: string
  name?: string
  state:
    | 'idle'
    | 'queued'
    | 'extracting'
    | 'indexing'
    | 'ready'
    | 'empty'
    | 'error'
    | 'excluded'
    | 'paused'
  percent: number | null
  completedChunks: number
  totalChunks: number
  error?: string
}
