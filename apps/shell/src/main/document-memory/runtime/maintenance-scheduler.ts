import type { DocumentMemoryStore, FolderChunkProgress } from '../store'
import type { DocumentIndexProgress } from '@genoffice/agent-core'
import type { FolderIndexProgress } from '../folder-progress'

export interface MaintenanceSchedulerOptions {
  store: DocumentMemoryStore
  onFtsStep?: (pages: number) => boolean
}

export class MaintenanceScheduler {
  private ftsTimer: NodeJS.Timeout | null = null

  constructor(private readonly options: MaintenanceSchedulerOptions) {}

  get store(): DocumentMemoryStore {
    return this.options.store
  }

  scheduleFtsMaintenance(delayMs = 250): void {
    if (this.ftsTimer) return
    this.ftsTimer = setTimeout(() => {
      this.ftsTimer = null
      try {
        this.store.mergeFtsStep(8)
      } catch {
        // Ignored if store/db is already closed
      }
    }, delayMs)
    this.ftsTimer.unref?.()
  }

  getDocumentIndexProgress(path: string): DocumentIndexProgress {
    const progress = this.store.chunkProgress(path)
    const doc = progress.document ?? this.store.documentByPath(path)
    if (!doc) {
      return { state: 'idle', percent: null, completedChunks: 0, totalChunks: 0 }
    }
    const base = {
      path: doc.path,
      name: doc.name,
      completedChunks: progress.completedChunks,
      totalChunks: progress.totalChunks,
      truncated: doc.truncated,
    }
    const pct = progress.totalChunks > 0 ? Math.floor((progress.completedChunks / progress.totalChunks) * 100) : null

    if (doc.status === 'excluded') return { ...base, state: 'excluded', percent: null }
    if (doc.status === 'empty') return { ...base, state: 'empty', percent: 100 }
    if (doc.status === 'ready') return { ...base, state: 'ready', percent: 100 }
    if (doc.status === 'error') {
      return {
        ...base,
        state: 'error',
        percent: pct,
        ...(doc.error ? { error: doc.error } : {}),
      }
    }
    if (doc.status === 'text-only') {
      return {
        ...base,
        state: 'indexing',
        percent: pct,
      }
    }
    return { ...base, state: 'queued', percent: null }
  }

  getFolderIndexProgress(folder?: string, activeEmbeddingSpace?: string): FolderIndexProgress {
    const raw = this.store.folderChunkProgress(folder)
    return {
      ...raw,
      percent: raw.totalChunks > 0 ? Math.floor((raw.completedChunks / raw.totalChunks) * 100) : 100,
    }
  }

  getFolderIndexCounts(folder?: string): FolderChunkProgress {
    return this.store.folderChunkProgress(folder)
  }

  getLibraryIndexCounts(): FolderChunkProgress {
    return this.store.folderChunkProgress()
  }

  dispose(): void {
    if (this.ftsTimer) {
      clearTimeout(this.ftsTimer)
      this.ftsTimer = null
    }
  }
}
