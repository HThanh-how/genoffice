import type { ExtractResult } from './runtime/extraction-coordinator'
import type { DocumentMemoryHit } from './store'
import type { OcrRenderRequest } from './agy-ocr-render'
import type { DocumentIndexStorageDiagnostics } from '../../shared/fork/document-index-api'

export type WorkerRequest =
  | { type: 'extract'; path: string; interactive?: boolean; sliceMs?: number; maxPdfPages?: number }
  | { type: 'embed'; texts: string[]; kind: 'query' | 'passage' }
  | { type: 'ocr-render'; path: string; ocr: OcrRenderRequest }
  | {
      type: 'search'
      query: string
      vector: number[] | null
      limit: number
      embeddingModel: string
    }
  | {
      type: 'search-lexical'
      query: string
      limit: number
    }
  | {
      type: 'search-semantic'
      vector: number[]
      limit: number
      embeddingSpaceId: string
    }
  | {
      type: 'ann-rebuild' | 'ann-sync'
      embeddingSpaceId: string
    }
  | {
      type: 'fts-maintenance-step'
    }
  | {
      type: 'gc-step'
    }
  | {
      type: 'vacuum-step'
    }
  | {
      /** Execute storage diagnostics off the main thread inside the indexing worker */
      type: 'storage-diagnostics'
      backupPath?: string
    }
  | {
      /** Run backup retention policy off the main thread */
      type: 'backup-retention'
      dbPath: string
    }

export type DocumentMemoryWorkerRequest = WorkerRequest

export type WorkerReply =
  | {
      id: number
      result:
        | ExtractResult
        | number[][]
        | DocumentMemoryHit[]
        | { more: boolean; durationMs: number }
        | { freedBytes?: number }
        | { purgedCount: number }
        | DocumentIndexStorageDiagnostics
        | unknown
    }
  | { id: number; error: string; restartRequired?: boolean }
  | {
      type: 'model'
      state: 'downloading' | 'ready' | 'blocked' | 'error'
      progress?: number
      error?: string
    }

export type DocumentMemoryWorkerReply = WorkerReply
