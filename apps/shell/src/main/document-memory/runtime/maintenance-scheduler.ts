import type { DocumentMemoryStore, FolderChunkProgress } from '../store'
import type { DocumentIndexProgress } from '@genoffice/agent-core'
import { foldFolderProgress, type FolderIndexProgress } from '../folder-progress'
import { isIndexingPaused } from '../../fork/indexing-policy-bus'
import type { BackgroundWorkGate } from '../background-work-gate'
import type { WorkerRequest, WorkerReply } from '../worker-types'

export const FTS_MERGE_PAGES = 8
export const VACUUM_STEP_MAX_PAGES = 256

export interface MaintenanceSchedulerOptions {
  store: DocumentMemoryStore
  onFtsStep?: (pages: number) => boolean
  askWorker?: (request: WorkerRequest) => Promise<WorkerReply | null>
  backgroundGate?: BackgroundWorkGate
  isPaused?: () => boolean
  isStopped?: () => boolean
  isQueued?: (path: string) => boolean
  isExtracting?: (path: string) => boolean
}

export class MaintenanceScheduler {
  private ftsTimer: NodeJS.Timeout | null = null
  private gcTimer: NodeJS.Timeout | null = null
  private vacuumTimer: NodeJS.Timeout | null = null
  private periodicTimer: NodeJS.Timeout | null = null

  private ftsRunning = false
  private gcRunning = false
  private vacuumRunning = false
  private periodicRunning = false
  private disposed = false

  constructor(private readonly options: MaintenanceSchedulerOptions) {}

  get store(): DocumentMemoryStore {
    return this.options.store
  }

  private isStopped(): boolean {
    return this.disposed || (this.options.isStopped ? this.options.isStopped() : false)
  }

  private isPaused(): boolean {
    if (this.options.isPaused) return this.options.isPaused()
    return isIndexingPaused()
  }

  scheduleFtsMaintenance(delayMs = 250): void {
    if (this.isStopped() || this.ftsTimer) return
    this.ftsTimer = setTimeout(() => {
      this.ftsTimer = null
      void this.runFtsMaintenance()
    }, delayMs)
    this.ftsTimer.unref?.()
  }

  async runFtsMaintenance(): Promise<void> {
    if (this.isStopped() || this.ftsRunning) return
    if (this.isPaused()) return
    if (this.options.backgroundGate && !this.options.backgroundGate.canRun('fts-maintenance-step')) {
      return
    }

    this.ftsRunning = true
    try {
      if (this.options.backgroundGate) {
        await this.options.backgroundGate.enqueue('fts-maintenance-step', async (signal) => {
          if (signal.aborted || this.isStopped()) return
          await this.executeFtsStep()
        })
      } else {
        await this.executeFtsStep()
      }
    } catch {
      // Ignored if cancelled / rejected
    } finally {
      this.ftsRunning = false
    }
  }

  private async executeFtsStep(): Promise<void> {
    if (this.isStopped()) return
    if (this.options.askWorker) {
      const reply = await this.options.askWorker({ type: 'fts-maintenance-step' })
      if (this.isStopped()) return
      if (
        reply &&
        'result' in reply &&
        reply.result &&
        typeof reply.result === 'object' &&
        'more' in reply.result
      ) {
        const { more } = reply.result as { more: boolean; durationMs?: number }
        if (more && !this.isStopped() && !this.isPaused()) {
          this.scheduleFtsMaintenance(250)
        }
      }
    }
  }

  scheduleGcStep(delayMs = 1000): void {
    if (this.isStopped() || this.gcTimer) return
    this.gcTimer = setTimeout(() => {
      this.gcTimer = null
      void this.runGcStep()
    }, delayMs)
    this.gcTimer.unref?.()
  }

  async runGcStep(): Promise<void> {
    if (this.isStopped() || this.gcRunning) return
    if (this.isPaused()) return
    if (this.options.backgroundGate && !this.options.backgroundGate.canRun('gc-step')) {
      return
    }

    this.gcRunning = true
    try {
      if (this.options.backgroundGate) {
        await this.options.backgroundGate.enqueue('gc-step', async (signal) => {
          if (signal.aborted || this.isStopped()) return
          await this.executeGcStep()
        })
      } else {
        await this.executeGcStep()
      }
    } catch {
      // Ignored if cancelled
    } finally {
      this.gcRunning = false
    }
  }

  private async executeGcStep(): Promise<void> {
    if (this.isStopped() || !this.options.askWorker) return
    await this.options.askWorker({ type: 'gc-step' })
  }

  scheduleVacuumStep(delayMs = 1000): void {
    if (this.isStopped() || this.vacuumTimer) return
    this.vacuumTimer = setTimeout(() => {
      this.vacuumTimer = null
      void this.runVacuumStep()
    }, delayMs)
    this.vacuumTimer.unref?.()
  }

  async runVacuumStep(): Promise<void> {
    if (this.isStopped() || this.vacuumRunning) return
    if (this.isPaused()) return
    if (this.options.backgroundGate && !this.options.backgroundGate.canRun('vacuum-step')) {
      return
    }

    this.vacuumRunning = true
    try {
      if (this.options.backgroundGate) {
        await this.options.backgroundGate.enqueue('vacuum-step', async (signal) => {
          if (signal.aborted || this.isStopped()) return
          await this.executeVacuumStep()
        })
      } else {
        await this.executeVacuumStep()
      }
    } catch {
      // Ignored if cancelled
    } finally {
      this.vacuumRunning = false
    }
  }

  private async executeVacuumStep(): Promise<void> {
    if (this.isStopped() || !this.options.askWorker) return
    await this.options.askWorker({ type: 'vacuum-step' })
  }

  schedulePeriodicMaintenance(delayMs = 5000): void {
    if (this.isStopped() || this.periodicTimer) return
    this.periodicTimer = setTimeout(() => {
      this.periodicTimer = null
      void this.runPeriodicMaintenance()
    }, delayMs)
    this.periodicTimer.unref?.()
  }

  async runPeriodicMaintenance(): Promise<void> {
    if (this.isStopped() || this.periodicRunning || this.isPaused()) return
    this.periodicRunning = true
    try {
      await this.runFtsMaintenance()
      if (this.isStopped() || this.isPaused()) return
      await this.runGcStep()
      if (this.isStopped() || this.isPaused()) return
      await this.runVacuumStep()
    } finally {
      this.periodicRunning = false
    }
  }

  getDocumentIndexProgress(path: string, activeSpaceId: string): DocumentIndexProgress {
    const progress = this.store.chunkProgress(path, activeSpaceId)
    const doc = progress.document ?? this.store.documentByPath(path)
    if (!doc) {
      return { state: 'idle', percent: null, completedChunks: 0, totalChunks: 0 }
    }
    const totalChunks = Math.max(0, progress.totalChunks)
    const completedChunks = Math.min(Math.max(0, progress.completedChunks), totalChunks)
    const base = {
      path: doc.path,
      name: doc.name,
      completedChunks,
      totalChunks,
      truncated: doc.truncated,
    }
    const pct = totalChunks > 0 ? Math.min(100, Math.floor((completedChunks / totalChunks) * 100)) : null
    const paused = this.isPaused()

    if (doc.status === 'excluded') return { ...base, state: 'excluded', percent: null }

    const awaitingSnapshot = { ...base, completedChunks: 0, totalChunks: 0, percent: null }
    if (this.options.isExtracting?.(doc.path)) return { ...awaitingSnapshot, state: 'extracting' }
    if (this.options.isQueued?.(doc.path)) return { ...awaitingSnapshot, state: paused ? 'paused' : 'queued' }

    if (doc.status === 'empty') return { ...base, state: 'empty', percent: 100 }
    if (doc.status === 'ready') {
      const isComplete = totalChunks === 0 || completedChunks >= totalChunks
      return {
        ...base,
        state: isComplete ? 'ready' : (paused ? 'paused' : 'indexing'),
        percent: isComplete ? 100 : pct,
      }
    }
    if (doc.status === 'error') {
      return {
        ...base,
        state: 'error',
        percent: pct,
        ...(doc.error ? { error: doc.error } : {}),
      }
    }
    if (doc.status === 'text-only') {
      const isComplete = totalChunks > 0 && completedChunks >= totalChunks
      return {
        ...base,
        state: isComplete ? 'ready' : (paused ? 'paused' : 'indexing'),
        percent: pct,
      }
    }
    return { ...base, state: paused ? 'paused' : 'queued', percent: null }
  }

  getFolderIndexProgress(
    folder?: string,
    discoveryCompleteOrSpace?: boolean | string,
    scanErrorsOrSpace: number | string = 0,
    activeSpaceId?: string,
  ): FolderIndexProgress {
    let discoveryComplete = true
    let scanErrors = 0
    let spaceId: string | undefined

    if (typeof discoveryCompleteOrSpace === 'string') {
      spaceId = discoveryCompleteOrSpace
    } else if (typeof discoveryCompleteOrSpace === 'boolean') {
      discoveryComplete = discoveryCompleteOrSpace
      if (typeof scanErrorsOrSpace === 'string') {
        spaceId = scanErrorsOrSpace
      } else {
        scanErrors = typeof scanErrorsOrSpace === 'number' ? scanErrorsOrSpace : 0
        spaceId = activeSpaceId
      }
    } else if (typeof activeSpaceId === 'string') {
      spaceId = activeSpaceId
    }
    const raw = this.store.folderChunkProgress(folder, spaceId)
    return foldFolderProgress(raw, discoveryComplete, scanErrors)
  }

  getFolderIndexCounts(folder?: string, activeEmbeddingSpace?: string): FolderChunkProgress {
    return this.store.folderChunkProgress(folder, activeEmbeddingSpace)
  }

  getLibraryIndexCounts(activeEmbeddingSpace?: string): FolderChunkProgress {
    return this.store.folderChunkProgress(undefined, activeEmbeddingSpace)
  }

  dispose(): void {
    this.disposed = true
    if (this.ftsTimer) {
      clearTimeout(this.ftsTimer)
      this.ftsTimer = null
    }
    if (this.gcTimer) {
      clearTimeout(this.gcTimer)
      this.gcTimer = null
    }
    if (this.vacuumTimer) {
      clearTimeout(this.vacuumTimer)
      this.vacuumTimer = null
    }
    if (this.periodicTimer) {
      clearTimeout(this.periodicTimer)
      this.periodicTimer = null
    }
  }
}
