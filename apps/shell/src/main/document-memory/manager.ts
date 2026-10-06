import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { DocumentIndexProgress } from '@genoffice/agent-core'
import type { FolderIndexProgress } from './folder-progress'
import type {
  DocumentIndexStorageDiagnostics,
  DocumentIndexMigrationDiagnostics,
  IndexingNow,
} from '../../shared/fork/document-index-api'
import type { DocumentMemoryStatus } from '../../shared/home-api'
import {
  DocumentMemoryStore,
  type DocumentMemoryHit,
  type DocumentMemoryStats,
  type FolderChunkProgress,
} from './store'
import {
  DEFAULT_EMBEDDING_PROFILE,
  type EmbeddingProfile,
  type EmbeddingProfileId,
} from './embedding-profiles'
import { createOcrHost } from './ocr-host'
import type { OcrJobHost } from './agy-ocr-job'
import { createYielder } from './yield-budget'
import { FileStabilityGate } from './file-stability'
import { BackgroundWorkGate } from './background-work-gate'
import { isIndexingPaused, subscribeIndexingPolicy } from '../fork/indexing-policy-bus'
import { ChunkUpgradeCoordinator, type DocumentNeedingUpgrade } from './chunk-upgrade'
import { EmbeddingMigration } from './embedding-migration'
import { SearchService, type FreshDocumentMemoryHit } from './runtime/search-service'
import { FreshnessCoordinator } from './runtime/freshness-coordinator'
import { ExtractionCoordinator } from './runtime/extraction-coordinator'
import { EmbeddingCoordinator } from './runtime/embedding-coordinator'
import { MaintenanceScheduler } from './runtime/maintenance-scheduler'
import { LegacyChunkMigrator } from './runtime/legacy-chunk-migrator'

export type { FreshDocumentMemoryHit }

export type WorkerReply =
  | { type: 'model'; state: 'not-loaded' | 'downloading' | 'ready' | 'error'; progress?: number; error?: string }
  | { id: number; result: unknown }
  | { id: number; error: string; restartRequired?: boolean }

export type WorkerRequest =
  | { type: 'extract'; path: string; interactive?: boolean; maxPdfPages?: number }
  | { type: 'embed'; texts: string[]; kind: 'query' | 'passage' }
  | { type: 'ocr-render'; path: string; ocr: any }
  | { type: 'search'; query: string; vector: number[] | null; limit: number; embeddingModel: string }
  | { type: 'ann-sync'; embeddingSpaceId: string }
  | { type: 'ann-rebuild'; embeddingSpaceId: string }

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Document memory operation failed.'
}

export interface DocumentMemoryManagerOptions {
  pathToWorker?: string
  workerFactory?: (script: string, env: Record<string, string>) => Worker
  workerTimeoutMs?: number
  dbDir?: string
  cacheDir?: string
  settingsDir?: string
  tombstoneGraceMs?: number
  externalNames?: (query: string, limit: number) => Promise<Array<{ path: string; name: string }>>
}

/** Central coordinator for background document extraction, vector indexing, and search. */
export class DocumentMemoryManager {
  readonly store: DocumentMemoryStore
  private readonly searchService: SearchService
  private readonly freshnessCoord: FreshnessCoordinator
  private readonly extractionCoord: ExtractionCoordinator
  private readonly embeddingCoord: EmbeddingCoordinator
  private readonly maintScheduler: MaintenanceScheduler
  private readonly legacyMigrator: LegacyChunkMigrator

  private readonly pathToWorker: string
  private readonly workerFactory: (script: string, env: Record<string, string>) => Worker
  private readonly workerTimeoutMs: number
  private readonly cacheDir: string
  private readonly settingsDir: string
  readonly dbPath: string

  private worker: Worker | null = null
  private nextRequestId = 1
  private readonly waiting = new Map<number, { resolve: (reply: WorkerReply | null) => void; timer: NodeJS.Timeout }>()

  private stopped = false
  private enabled = true
  private modelState: 'not-loaded' | 'downloading' | 'ready' | 'blocked' | 'error' = 'not-loaded'
  private lastError: string | undefined
  private pendingCount = 0
  private epoch = 0

  private readonly queue: string[] = []
  private readonly queued = new Set<string>()
  private readonly urgent = new Set<string>()
  private readonly deferred = new Set<string>()
  private readonly activeExtractions = new Set<string>()
  private readonly activeSince = new Map<string, number>()
  private readonly pathGeneration = new Map<string, number>()
  private readonly skippedMigrationDocs = new Set<number>()
  private migrationTimer: NodeJS.Timeout | null = null

  private readonly stabilityGate: FileStabilityGate
  private readonly backgroundGate: BackgroundWorkGate
  private readonly chunkUpgrade: ChunkUpgradeCoordinator
  private readonly embeddingMigration: EmbeddingMigration
  private pollTimer: NodeJS.Timeout | null = null
  private stopPolicyWatch: () => void

  ocrHost(): OcrJobHost {
    return createOcrHost({
      store: this.store,
      isEnabled: () => this.isEnabled(),
      renderInWorker: async (path, ocr): Promise<any> => {
        const reply = await this.ask({ type: 'ocr-render', path, ocr }, this.workerTimeoutMs)
        return reply && 'result' in reply ? reply.result : { ok: false, code: 'render', message: 'error' in (reply ?? {}) && typeof (reply as any).error === 'string' ? (reply as any).error : 'Render failed' }
      },
      reindex: (path) => this.enqueue(resolve(path), true),
    })
  }

  get lastIndexError(): string | undefined { return this.lastError }
  get countersReady(): Promise<void> { return Promise.resolve() }

  constructor(userDataDir: string, options: DocumentMemoryManagerOptions = {}) {
    const dbDir = options.dbDir ?? userDataDir
    this.dbPath = join(dbDir, 'document-memory.db')
    this.cacheDir = options.cacheDir ?? join(userDataDir, 'models')
    this.settingsDir = options.settingsDir ?? userDataDir
    this.pathToWorker = options.pathToWorker ?? resolve(__dirname, 'worker.js')
    this.workerFactory = options.workerFactory ?? ((script, env) => new Worker(script, { workerData: env }))
    this.workerTimeoutMs = options.workerTimeoutMs ?? 60_000

    mkdirSync(dbDir, { recursive: true })
    this.store = new DocumentMemoryStore(this.dbPath, { role: 'search' })

    this.searchService = new SearchService({
      store: this.store,
      externalNames: options.externalNames,
      askEmbed: async (text) => {
        const reply = await this.ask({ type: 'embed', texts: [text], kind: 'query' }, this.workerTimeoutMs)
        if (reply && 'result' in reply && Array.isArray(reply.result)) return reply.result[0] as number[]
        return null
      },
      annotateFreshness: async (hits) => {
        return hits.map((h) => ({ ...h, stale: false, missing: false }))
      },
    })

    this.freshnessCoord = new FreshnessCoordinator({
      store: this.store,
      tombstoneGraceMs: options.tombstoneGraceMs,
      onEnqueue: (p, prior) => this.enqueue(p, prior),
      onTombstone: async (p) => { await this.store.tombstoneSliced(p) },
    })

    this.extractionCoord = new ExtractionCoordinator({ store: this.store, workerTimeoutMs: this.workerTimeoutMs })
    this.embeddingCoord = new EmbeddingCoordinator({ store: this.store, settingsPath: join(this.settingsDir, 'embedding-settings.json') })
    this.maintScheduler = new MaintenanceScheduler({ store: this.store })

    this.chunkUpgrade = new ChunkUpgradeCoordinator(this.store)
    this.legacyMigrator = new LegacyChunkMigrator({
      store: this.store,
      freshnessCoord: this.freshnessCoord,
      extractionCoord: this.extractionCoord,
      maintScheduler: this.maintScheduler,
      chunkUpgrade: this.chunkUpgrade,
      askExtract: (path) => this.ask({ type: 'extract', path, maxPdfPages: this.extractionCoord.getPdfMaxPages() }, this.workerTimeoutMs),
      enqueue: (path, prior) => this.enqueue(path, prior),
      currentGeneration: (path) => this.currentGeneration(path),
      isCurrent: (path, gen, ep) => this.isCurrent(path, gen, ep),
      getEpoch: () => this.epoch,
      isStoppedOrPaused: () => this.stopped || !this.enabled || isIndexingPaused(),
    })
    this.embeddingMigration = new EmbeddingMigration(this.store.rawDb)
    this.embeddingMigration.setTarget(this.embeddingCoord.currentProfile.embeddingId)
    this.stabilityGate = new FileStabilityGate()
    this.backgroundGate = new BackgroundWorkGate()

    this.stopPolicyWatch = subscribeIndexingPolicy(() => {
      if (!isIndexingPaused() && this.enabled && !this.stopped) this.drain()
    })

    this.pollTimer = setInterval(() => void this.poll(), 60_000)
    this.pollTimer.unref?.()
  }

  nowStatus(): IndexingNow {
    const active = this.activeExtractions.values().next().value ?? null
    return {
      extracting: active ? [{ path: active, since: Date.now() }] : [],
      embedding: {},
      positions: {},
      pages: {},
      queued: this.queue.length + this.pendingCount,
      paused: isIndexingPaused(),
    }
  }

  remember(path: string): void {
    this.store.remember(path)
    this.enqueue(resolve(path), true)
  }

  indexDiscoveredFile(path: string, meta: { mtimeMs: number; sizeBytes: number }): boolean {
    return this.freshnessCoord.indexDiscoveredFile(path, meta)
  }

  isEnabled(): boolean { return this.enabled }
  retryDocument(id: number) { return this.extractionCoord.retryDocument(id) }
  deferDocument(path: string) { this.deferred.add(resolve(path)) }
  async stopDocument(path: string): Promise<boolean> {
    const p = resolve(path)
    this.queued.delete(p)
    const idx = this.queue.indexOf(p)
    if (idx >= 0) this.queue.splice(idx, 1)
    return true
  }

  indexDocumentPath(id: number): string | null {
    const document = this.store.documentById(id)
    return document && document.status !== 'excluded' ? document.path : null
  }

  move(oldPath: string, newPath: string): void {
    this.store.move(oldPath, newPath)
  }

  legacyPaths(extensions: readonly string[], limit: number): string[] {
    return this.store.legacyPaths(extensions, limit)
  }
  listPaths(): string[] { return this.store.listPaths() }
  getDocumentIndexProgress(path: string): DocumentIndexProgress { return this.maintScheduler.getDocumentIndexProgress(path) }
  getFolderIndexProgress(folder?: string): FolderIndexProgress { return this.maintScheduler.getFolderIndexProgress(folder, this.embeddingCoord.currentProfile.embeddingId) }
  getFolderIndexCounts(folder?: string): FolderChunkProgress { return this.maintScheduler.getFolderIndexCounts(folder) }
  getLibraryIndexCounts(): FolderChunkProgress { return this.maintScheduler.getLibraryIndexCounts() }
  prioritizeFolder(folder: string): number { return this.freshnessCoord.prioritizeFolder(folder) }
  status(): DocumentMemoryStatus {
    const stats = this.store.stats()
    const files = this.store.recentDocuments(20).map(({ id, path, name, status }) => ({ id, path, name, status }))
    return {
      enabled: this.enabled, modelState: this.modelState, documents: stats.docs, chunks: stats.chunks,
      vectors: stats.vectors, pending: this.pendingCount + this.queue.length, errors: stats.errors,
      dbPath: this.dbPath, ...(this.lastError ? { lastError: this.lastError } : {}), files,
    }
  }
  indexingActivityStatus() {
    return { mode: 'balanced', activity: this.nowStatus() }
  }
  embeddingSettings() {
    return this.embeddingCoord.getEmbeddingSettings()
  }
  setEmbeddingProfile(id: EmbeddingProfileId) {
    const res = this.embeddingCoord.setEmbeddingProfile(id)
    if (res.changed) this.recycleWorker('Embedding profile changed')
    return res
  }
  recycleEmbeddingWorker(): void { this.recycleWorker('Recycle worker requested') }
  getPdfMaxPages(): number { return this.extractionCoord.getPdfMaxPages() }
  setPdfMaxPages(pages: number) { return this.extractionCoord.setPdfMaxPages(pages) }
  getStorageDiagnostics(backupPath?: string): DocumentIndexStorageDiagnostics { return this.store.getStorageDiagnostics(backupPath) }
  getMigrationDiagnostics(): DocumentIndexMigrationDiagnostics {
    const migration = this.embeddingMigration.progress()
    return { activeEmbeddingSpace: this.embeddingCoord.currentProfile.embeddingId, state: migration.state, completedChunks: migration.completedChunks, totalChunks: migration.totalChunks }
  }
  setEnabled(enabled: boolean): DocumentMemoryStats {
    this.enabled = enabled
    if (enabled) this.drain()
    return this.store.stats()
  }
  exclude(path: string): void { this.store.exclude(path) }
  clear(): void { this.store.clear(); this.queue.length = 0; this.queued.clear() }

  async search(query: string, limit = 8): Promise<{ hits: FreshDocumentMemoryHit[]; pending: number; errors: number; modelState: string }> {
    const hits = await this.searchService.searchProgressive(query, limit, undefined, this.embeddingCoord.currentProfile.embeddingId)
    return { hits, pending: this.queue.length + this.pendingCount, errors: this.store.errorCount(), modelState: this.modelState }
  }

  async read(chunkId: number) {
    const chunk = this.store.readChunk(chunkId)
    if (!chunk) return { path: '', name: '', location: '', text: '', verified: false, error: 'Chunk unavailable' }
    return { path: chunk.path, name: chunk.name, location: chunk.location, text: chunk.text, verified: true }
  }

  searchExternal(query: string, limit: number) { return this.searchService.searchExternal(query, limit) }
  openOffered(path: string): string | null { return this.searchService.openOffered(path) }
  open(documentId: number): string | null { return this.searchService.open(documentId) }

  async handleFileEvents(paths: string[]): Promise<void> {
    for (const raw of paths) {
      const path = resolve(raw)
      const st = await this.freshnessCoord.statOutcome(path)
      if (st.kind === 'gone') this.freshnessCoord.markMissing(path)
      else if (st.kind === 'file') {
        this.freshnessCoord.indexDiscoveredFile(path, { mtimeMs: st.mtimeMs, sizeBytes: st.sizeBytes })
        this.enqueue(path, true)
      }
    }
  }

  async reconcileFolder(_folder: string) { return { added: 0, changed: 0, moved: 0, removed: 0 } }
  async readNowDocument(path: string) { this.remember(resolve(path)); return { ok: true } }
  async triggerAnnSync(spaceId?: string) { return this.store.syncAnnIndex(spaceId ?? this.embeddingCoord.currentProfile.embeddingId) }

  currentGeneration(path: string): number {
    return this.pathGeneration.get(resolve(path)) ?? 0
  }

  isCurrent(path: string, generation: number, epoch: number): boolean {
    return !this.stopped && this.epoch === epoch && this.currentGeneration(path) === generation
  }

  async sourceUnavailable(path: string): Promise<boolean> {
    return this.freshnessCoord.sourceUnavailable(path)
  }

  async migrateLegacyDocument(doc: DocumentNeedingUpgrade): Promise<boolean> {
    return this.legacyMigrator.migrate(doc, this.skippedMigrationDocs)
  }

  scheduleMigrationStep(delayMs = 1000): void {
    if (this.stopped || !this.enabled || isIndexingPaused()) return
    if (this.migrationTimer) clearTimeout(this.migrationTimer)
    this.migrationTimer = setTimeout(() => void this.runMigrationStep(), delayMs)
    this.migrationTimer.unref?.()
  }

  private async runMigrationStep(): Promise<void> {
    if (this.stopped || !this.enabled || isIndexingPaused()) return
    if (this.queue.length > 0 || this.activeExtractions.size > 0) {
      this.scheduleMigrationStep(1000)
      return
    }
    const needing = this.chunkUpgrade.getDocumentsNeedingUpgrade(1, this.skippedMigrationDocs)
    if (needing.length > 0) {
      await this.migrateLegacyDocument(needing[0]!)
      this.scheduleMigrationStep(500)
    }
  }

  close(): void {
    if (this.stopped) return
    this.stopped = true
    this.stopPolicyWatch()
    this.epoch++
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.migrationTimer) clearTimeout(this.migrationTimer)
    this.maintScheduler.dispose()
    this.freshnessCoord.clearMissing()
    this.skippedMigrationDocs.clear()
    this.queue.length = 0
    this.queued.clear()
    const worker = this.worker
    this.worker = null
    if (worker) void worker.terminate()
    this.store.close()
  }

  private enqueue(path: string, prioritize = false): void {
    if (this.stopped || !this.enabled) return
    const p = resolve(path)
    this.pathGeneration.set(p, (this.pathGeneration.get(p) ?? 0) + 1)
    if (this.queued.has(p)) return
    this.queued.add(p)
    if (prioritize) this.queue.unshift(p)
    else this.queue.push(p)
    void this.drain()
  }

  private drain(): void {
    if (this.stopped || !this.enabled || isIndexingPaused()) return
    if (this.queue.length > 0 && this.activeExtractions.size === 0) {
      const next = this.queue.shift()!
      this.queued.delete(next)
      this.activeExtractions.add(next)
      this.activeSince.set(next, Date.now())
      this.pendingCount++
      void this.ask({ type: 'extract', path: next, interactive: false, maxPdfPages: this.extractionCoord.getPdfMaxPages() }, this.workerTimeoutMs)
        .then((reply) => {
          if (reply && 'result' in reply && reply.result && typeof reply.result === 'object') {
            const ext = reply.result as any
            this.store.replaceDocument(next, {
              hash: ext.hash,
              mtimeMs: ext.mtimeMs,
              sizeBytes: ext.sizeBytes,
              chunks: ext.chunks ?? [],
              embeddingModel: this.embeddingCoord.currentProfile.embeddingId,
              status: ext.status ?? 'ready',
              error: ext.error,
              truncated: ext.truncated,
            })
          }
        })
        .finally(() => {
          this.activeExtractions.delete(next)
          this.activeSince.delete(next)
          this.pendingCount--
          this.drain()
        })
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.enabled || isIndexingPaused()) return
    this.skippedMigrationDocs.clear()
    this.scheduleMigrationStep(1000)
    this.drain()
  }

  private recycleWorker(reason: string): void {
    const worker = this.worker
    if (!worker) return
    this.worker = null
    this.lastError = reason
    void worker.terminate()
    for (const [id, pending] of this.waiting) {
      clearTimeout(pending.timer)
      pending.resolve({ id, error: reason })
      this.waiting.delete(id)
    }
  }

  private ask(request: WorkerRequest, timeoutMs: number): Promise<WorkerReply | null> {
    if (this.stopped) return Promise.resolve(null)
    const id = this.nextRequestId++
    return new Promise((resolveReply) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        resolveReply(null)
      }, timeoutMs)
      this.waiting.set(id, { resolve: resolveReply, timer })
      try {
        this.ensureWorker().postMessage({ ...request, id })
      } catch (error) {
        clearTimeout(timer)
        this.waiting.delete(id)
        resolveReply({ id, error: safeError(error) })
      }
    })
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    mkdirSync(this.cacheDir, { recursive: true })
    const worker = this.workerFactory(this.pathToWorker, {
      cacheDir: this.cacheDir,
      dbPath: this.dbPath,
      embeddingProfile: this.embeddingCoord.currentProfile.embeddingId,
    })
    worker.on('message', (message: WorkerReply) => {
      if (this.worker !== worker) return
      if ('type' in message && message.type === 'model') {
        this.modelState = message.state
        if (message.error) this.lastError = message.error
        else if (message.state === 'ready') this.lastError = undefined
        return
      }
      if (!('id' in message)) return
      const pending = this.waiting.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.waiting.delete(message.id)
      pending.resolve(message)
    })
    this.worker = worker
    return worker
  }
}
