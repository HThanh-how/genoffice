import type { ExtractResult } from './runtime/extraction-coordinator'
import type { DocumentMemoryHit } from './store'
import type { OcrRenderRequest } from './agy-ocr-render'
import type { DocumentIndexStorageDiagnostics } from '../../shared/fork/document-index-api'
import type { DocumentIndexStorageBudget } from './storage-budget'

import type { AnnPreauthorizedPermit } from './ann-index'
import type { CompactionWorkerRequest } from './runtime/worker-compaction-types'

export interface StorageBudgetWorkerRequest {
  /** Set storage budget without restart */
  type: 'set-storage-budget'
  budget: DocumentIndexStorageBudget
  configVersion: number
  epoch?: number
}

export interface StorageBudgetWorkerResult {
  ok: boolean
  appliedVersion: number | null
  desiredVersion: number
  appliedBudgetBytes?: number
  /** Grace-zone overshoot the worker applied (absent = default OVERSHOOT_RATIO); main verifies it matches. */
  appliedOvershootRatio?: number
  error?: string
}

export type WorkerRequest =
  | { type: 'extract'; path: string; interactive?: boolean; sliceMs?: number; maxPdfPages?: number }
  | { type: 'embed'; texts: string[]; kind: 'query' | 'passage' }
  | { type: 'ocr-render'; path: string; ocr: OcrRenderRequest }
  | { type: 'ocr-prepare'; bytes: Uint8Array; dpi: number }
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
      embeddingSpaceId?: string
      spaceId?: string
      hostPermit?: AnnPreauthorizedPermit
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
      /** One bounded slice of the one-time junk purge (see runtime/junk-purge.ts) */
      type: 'junk-purge-step'
    }
  | {
      /** Execute storage diagnostics off the main thread inside the indexing worker */
      type: 'storage-diagnostics'
      backupPath?: string
      budget?: DocumentIndexStorageBudget
    }
  | StorageBudgetWorkerRequest
  | {
      /** Run backup retention policy off the main thread */
      type: 'backup-retention'
      dbPath: string
    }
  /** Storage compaction lane ('run-retention' | 'free-space' | 'optimize-fts' | 'redundancy-analyze' | 'cancel-compaction') */
  | CompactionWorkerRequest

export type DocumentMemoryWorkerRequest = WorkerRequest

export interface AnnRebuildWorkerResult {
  ok: boolean
  count: number
  error?: string
}

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
        | StorageBudgetWorkerResult
        | DocumentIndexStorageDiagnostics
        | AnnRebuildWorkerResult
        | unknown
    }
  | { id: number; error: string; restartRequired?: boolean }
  | {
      type: 'model'
      state: 'downloading' | 'ready' | 'blocked' | 'error'
      /** whole percent of the model download while state is 'downloading' */
      progress?: number
      /** host the download is coming from, and its byte counts */
      source?: string
      doneBytes?: number
      totalBytes?: number
      error?: string
    }

export type DocumentMemoryWorkerReply = WorkerReply
