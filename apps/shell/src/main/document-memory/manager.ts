import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Worker } from 'node:worker_threads'
import type { DocumentIndexProgress } from '@genoffice/agent-core'
import type { FolderIndexProgress } from './folder-progress'
import type { DocumentIndexStorageDiagnostics, DocumentIndexMigrationDiagnostics, IndexingNow } from '../../shared/fork/document-index-api'
import type { DocumentMemoryStatus } from '../../shared/home-api'
import { DocumentMemoryStore, type DocumentMemoryStats, type FolderChunkProgress } from './store'
import type { EmbeddingProfileId } from './embedding-profiles'
import { createOcrHost } from './ocr-host'
import type { OcrJobHost } from './agy-ocr-job'
import { FileStabilityGate } from './file-stability'
import { BackgroundWorkGate, isIndexingPaused, onIndexingPolicyChange } from './background-work-gate'
import { ChunkUpgradeCoordinator, type DocumentNeedingUpgrade } from './chunk-upgrade'
import { EmbeddingMigration } from './embedding-migration'
import { SearchService, type FreshDocumentMemoryHit } from './runtime/search-service'
import { FreshnessCoordinator } from './runtime/freshness-coordinator'
import {
  ExtractionCoordinator, statMeta, extractedStatus, isPartialExtract,
  isExtractResult, readOutcome, READ_NOW_ATTEMPTS, INTERRUPTED_FOR_USER,
  MAX_PENDING_EMBED_DOCUMENTS, PDF_SLICE_MS,
} from './runtime/extraction-coordinator'
import { EmbeddingCoordinator } from './runtime/embedding-coordinator'
import { MaintenanceScheduler } from './runtime/maintenance-scheduler'; import { LegacyChunkMigrator } from './runtime/legacy-chunk-migrator'
import { readActiveEmbeddingConfig } from './storage/embedding-settings'
import { createIndexProcess } from './process-worker'
import workerPath from './worker?modulePath'
import { safeError } from './issues'
import { orderQueue, weightOf } from './queue-order'
import type { WorkerRequest, WorkerReply } from './worker-types'
export type { FreshDocumentMemoryHit }
function readEnabled(p: string): boolean {
  try { return JSON.parse(readFileSync(p, 'utf8'))?.enabled !== false } catch { return true }
}
function saveEnabled(p: string, enabled: boolean): void {
  try { writeFileSync(p, JSON.stringify({ enabled }), { mode: 0o600 }) } catch {}
}
export interface DocumentMemoryManagerOptions {
  pathToWorker?: string; workerPath?: string
  workerFactory?: (script: string, env: Record<string, string>) => Worker
  workerTimeoutMs?: number; dbDir?: string; cacheDir?: string; settingsDir?: string
  tombstoneGraceMs?: number; pollIntervalMs?: number; autoDeferAfterMs?: number
  initialEnabled?: boolean; externalNames?: (query: string, limit: number) => Promise<Array<{ path: string; name: string }>>
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
  private readonly autoDeferAfterMs: number
  private readonly cacheDir: string
  private readonly settingsDir: string
  private readonly enabledSettingsPath: string
  readonly dbPath: string
  private worker: Worker | null = null
  private nextRequestId = 1
  private readonly waiting = new Map<number, { resolve: (reply: WorkerReply | null) => void; timer: NodeJS.Timeout }>()
  private stopped = false
  private enabled = true
  private modelState: 'not-loaded' | 'downloading' | 'ready' | 'blocked' | 'error' = 'not-loaded'
  private modelProgress?: number
  private lastError: string | undefined
  private pendingCount = 0
  private epoch = 0
  private extracting = false
  private readonly queue: string[] = []
  private readonly queued = new Set<string>(); private readonly urgent = new Set<string>(); private readonly deferred = new Set<string>(); private readonly slicing = new Set<string>()
  private readonly activeBytes = new Map<string, number>(); private readonly activeExtractions = new Set<string>(); private readonly activeSince = new Map<string, number>()
  private readonly activeGeneration = new Map<string, number>(); private readonly pathGeneration = new Map<string, number>(); private readonly readProgress = new Map<string, { done: number; total: number }>()
  private readonly skippedMigrationDocs = new Set<number>()
  private readonly enabledListeners = new Set<() => void>()
  private readonly clearedListeners = new Set<() => void>()
  private migrationTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private readonly stopPolicyWatch: () => void
  private readonly stabilityGate: FileStabilityGate
  private readonly backgroundGate: BackgroundWorkGate
  private readonly chunkUpgrade: ChunkUpgradeCoordinator
  private readonly embeddingMigration: EmbeddingMigration
  ocrHost(): OcrJobHost {
    return createOcrHost({
      store: this.store,
      isEnabled: () => this.isEnabled(),
      renderInWorker: async (path, ocr): Promise<any> => {
        const reply = await this.ask({ type: 'ocr-render', path, ocr } as any, this.workerTimeoutMs)
        return reply && 'result' in reply ? reply.result : { ok: false, code: 'render', message: 'error' in (reply ?? {}) && typeof (reply as any).error === 'string' ? (reply as any).error : 'Render failed' }
      },
      reindex: (path) => this.enqueue(resolve(path), true),
    })
  }
  get lastIndexError(): string | undefined { return this.lastError }
  get countersReady(): Promise<void> { return Promise.resolve() }
  constructor(userDataDir: string, options: DocumentMemoryManagerOptions = {}) {
    const dbDir = options.dbDir ?? userDataDir; this.dbPath = join(dbDir, 'document-memory.db')
    this.cacheDir = options.cacheDir ?? join(userDataDir, 'document-memory-models'); this.settingsDir = options.settingsDir ?? userDataDir
    this.enabledSettingsPath = join(this.settingsDir, 'enabled.json'); this.pathToWorker = options.pathToWorker ?? options.workerPath ?? workerPath
    this.workerFactory = options.workerFactory ?? ((s, env) => createIndexProcess(s, env as any)); this.workerTimeoutMs = options.workerTimeoutMs ?? 60_000
    this.autoDeferAfterMs = options.autoDeferAfterMs ?? 30_000; this.enabled = options.initialEnabled ?? readEnabled(this.enabledSettingsPath)
    mkdirSync(dbDir, { recursive: true })
    this.store = new DocumentMemoryStore(this.dbPath, { role: 'search' })
    this.freshnessCoord = new FreshnessCoordinator({
      store: this.store, tombstoneGraceMs: options.tombstoneGraceMs,
      onEnqueue: (p, prior, bytes) => this.enqueue(p, prior, bytes), onTombstone: async (p) => { await this.store.tombstoneSliced(p) },
      onInvalidatePath: (p) => this.invalidatePath(p), isStopped: () => this.stopped, isEnabled: () => this.enabled,
    })
    const embeddingConfig = readActiveEmbeddingConfig(this.settingsDir)
    this.embeddingCoord = new EmbeddingCoordinator({
      store: this.store, settingsDir: this.settingsDir, initialProfileId: embeddingConfig.profileId,
      workerTimeoutMs: this.workerTimeoutMs, isStoppedOrPaused: () => this.stopped || !this.enabled || isIndexingPaused(),
      isCurrent: (p, gen, ep) => this.isCurrent(p, gen, ep), onDrainNeeded: () => this.drain(),
      onEnqueueExtract: (p) => this.enqueue(p), onError: (err) => { this.lastError = err },
    })
    this.searchService = new SearchService({
      store: this.store, externalNames: options.externalNames,
      askEmbed: async (t) => {
        if (this.modelState === 'downloading' || this.modelState === 'error') return null
        const r = await this.ask({ type: 'embed', texts: [t], kind: 'query' }, this.workerTimeoutMs)
        return r && 'result' in r && Array.isArray(r.result) ? (r.result[0] as number[]) : null
      },
      askSemantic: async (v, lim, sp) => { const r = await this.ask({ type: 'search-semantic', vector: v, limit: lim, embeddingSpaceId: sp }, 30_000); return r && 'result' in r && Array.isArray(r.result) ? (r.result as any) : null },
      annotateFreshness: (hits) => this.freshnessCoord.annotateFreshness(hits),
    })
    this.stabilityGate = new FileStabilityGate()
    this.backgroundGate = new BackgroundWorkGate()

    this.extractionCoord = new ExtractionCoordinator({ store: this.store, workerTimeoutMs: this.workerTimeoutMs, pdfPagesPath: join(this.settingsDir, 'document-memory-pdf.json') })
    this.maintScheduler = new MaintenanceScheduler({
      store: this.store, backgroundGate: this.backgroundGate, askWorker: (req) => this.ask(req, 30_000),
      isPaused: () => !this.enabled || isIndexingPaused(), isStopped: () => this.stopped,
      isQueued: (p) => this.queued.has(p), isExtracting: (p) => this.activeExtractions.has(p),
    })
    this.chunkUpgrade = new ChunkUpgradeCoordinator(this.store)
    this.legacyMigrator = new LegacyChunkMigrator({
      store: this.store, freshnessCoord: this.freshnessCoord, extractionCoord: this.extractionCoord,
      maintScheduler: this.maintScheduler, chunkUpgrade: this.chunkUpgrade,
      askExtract: (p) => this.ask({ type: 'extract', path: p, maxPdfPages: this.extractionCoord.getPdfMaxPages() }, this.workerTimeoutMs),
      enqueue: (p, prior) => this.enqueue(p, prior), currentGeneration: (p) => this.currentGeneration(p),
      isCurrent: (p, gen, ep) => this.isCurrent(p, gen, ep), getEpoch: () => this.epoch,
      isStoppedOrPaused: () => this.stopped || !this.enabled || isIndexingPaused(),
    })
    this.embeddingMigration = new EmbeddingMigration(this.store.rawDb); this.embeddingMigration.setTarget(this.embeddingCoord.currentProfile.embeddingId)

    this.stopPolicyWatch = onIndexingPolicyChange((policy) => {
      if (this.modelState === 'blocked' && (policy as any).allowHeavyEmbedding !== false) { this.modelState = 'not-loaded'; this.lastError = undefined }
      if (!policy.paused && this.enabled && !this.stopped) { this.drain(); this.maintScheduler.scheduleFtsMaintenance() }
    })

    const pollInterval = options.pollIntervalMs ?? 60_000
    this.pollTimer = setInterval(() => void this.poll(), pollInterval)
    this.pollTimer.unref?.()
    if (this.enabled) void this.poll()
  }
  onEnabledChange(l: () => void): () => void { this.enabledListeners.add(l); return () => this.enabledListeners.delete(l) }
  onCleared(l: () => void): () => void { this.clearedListeners.add(l); return () => this.clearedListeners.delete(l) }
  nowStatus(): IndexingNow {
    const active = this.activeExtractions.values().next().value ?? null
    const positions: Record<string, number> = {}
    orderQueue(this.queue, { urgent: this.urgent, deferred: this.deferred, bytes: this.activeBytes }).slice(0, 400).forEach((p, i) => { positions[p] = i + 1 })
    const pages: Record<string, { done: number; total: number }> = {}
    for (const [p, prog] of this.readProgress) pages[p] = prog
    return {
      extracting: active ? [{ path: active, since: this.activeSince.get(active) ?? Date.now() }] : [],
      embedding: this.embeddingCoord.getEmbeddingProgress(), positions, pages, queued: this.queue.length + this.pendingCount + this.embeddingCoord.getQueueLength(), paused: isIndexingPaused(),
    }
  }
  remember(path: string): void { this.store.remember(path); this.enqueue(resolve(path), true) }
  indexDiscoveredFile(p: string, meta?: { mtimeMs: number; sizeBytes: number }) { return this.freshnessCoord.indexDiscoveredFile(p, meta) }
  isEnabled(): boolean { return this.enabled }
  retryDocument(id: number, opts: { now?: boolean; prioritize?: boolean } = {}): { ok: boolean; error?: string } {
    if (!this.enabled || this.stopped) return { ok: false, error: 'paused' }
    const p = this.store.retryDocument(id); if (!p) return { ok: false, error: 'unavailable' }
    if (opts.prioritize !== false || opts.now) { this.deferred.delete(p); this.urgent.add(p) }
    if (this.activeExtractions.has(p)) return { ok: true }
    if (this.embeddingCoord.promotePath(p)) { this.drain(); return { ok: true } }
    if (opts.now) {
      const blk = [...this.activeExtractions].filter((o) => o !== p && !this.slicing.has(o))
      for (const o of blk) { this.invalidatePath(o); this.enqueue(o, false, this.activeBytes.get(o)) }
      if (blk.length) this.recycleWorker(INTERRUPTED_FOR_USER)
    }
    this.enqueue(p, opts.prioritize !== false || opts.now); return { ok: true }
  }
  deferDocument(idOrPath: number | string): { ok: boolean; error?: string } {
    const doc = typeof idOrPath === 'number' ? this.store.documentById(idOrPath) : this.store.documentByPath(resolve(idOrPath))
    if (!doc || !['pending', 'text-only'].includes(doc.status)) return { ok: false, error: 'unavailable' }
    const p = doc.path; this.deferred.add(p); this.urgent.delete(p)
    const reading = this.activeExtractions.has(p); this.invalidatePath(p)
    if (reading && !this.slicing.has(p)) { this.enqueue(p, false, this.activeBytes.get(p)); this.recycleWorker(INTERRUPTED_FOR_USER) }
    return { ok: true }
  }
  async stopDocument(idOrPath: number | string): Promise<{ ok: boolean; error?: string }> {
    const doc = typeof idOrPath === 'number' ? this.store.documentById(idOrPath) : this.store.documentByPath(resolve(idOrPath))
    if (!doc || !['pending', 'text-only'].includes(doc.status)) return { ok: false, error: 'unavailable' }
    const p = doc.path; this.invalidatePath(p)
    if (this.activeExtractions.has(p) || this.embeddingCoord.isEmbeddingPath(p)) this.recycleWorker('Stopped by you.')
    await this.store.markErrorSliced(p, 'Stopped by you.', await statMeta(p)); return { ok: true }
  }
  indexDocumentPath(id: number): string | null {
    const d = this.store.documentById(id); return d && d.status !== 'excluded' ? d.path : null
  }
  move(oldPath: string, newPath: string): void {
    const oldR = resolve(oldPath); const newR = resolve(newPath)
    this.invalidatePath(oldR); if (!this.store.documentByPath(oldR)) return
    try { this.store.move(oldR, newR) } catch (err) {
      if (!this.store.documentByPath(newR)) throw err
      this.store.markError(oldR, 'Document moved to an already remembered path.', null)
    }
    if (this.enabled && this.store.documentByPath(newR)?.status !== 'excluded') this.enqueue(newR)
  }
  // Scoped progress APIs to active embedding space (BEH-20)
  legacyPaths(ext: readonly string[], lim: number) { return this.store.legacyPaths(ext, lim) }; listPaths() { return this.store.listPaths() }; getDocumentIndexProgress(p: string, activeSpaceId = this.embeddingCoord.currentProfile.embeddingId): DocumentIndexProgress { return this.maintScheduler.getDocumentIndexProgress(p, activeSpaceId) }
  getFolderIndexProgress(f?: string, d?: boolean | string, e?: number, activeSpaceId = this.embeddingCoord.currentProfile.embeddingId): FolderIndexProgress { return this.maintScheduler.getFolderIndexProgress(f, d, e, activeSpaceId) }
  getFolderIndexCounts(f?: string, s = this.embeddingCoord.currentProfile.embeddingId): FolderChunkProgress { return this.maintScheduler.getFolderIndexCounts(f, s) }; getLibraryIndexCounts(s = this.embeddingCoord.currentProfile.embeddingId): FolderChunkProgress { return this.maintScheduler.getLibraryIndexCounts(s) }; prioritizeFolder(folder: string): number { return this.freshnessCoord.prioritizeFolder(folder) }
  runFtsMaintenance(): Promise<void> { return this.maintScheduler.runFtsMaintenance() }; scheduleFtsMaintenance(delayMs?: number): void { this.maintScheduler.scheduleFtsMaintenance(delayMs) }
  runGcStep(): Promise<void> { return this.maintScheduler.runGcStep() }; runVacuumStep(): Promise<void> { return this.maintScheduler.runVacuumStep() }; runPeriodicMaintenance(): Promise<void> { return this.maintScheduler.runPeriodicMaintenance() }; statOutcome(p: string, t?: number) { return this.freshnessCoord.statOutcome(p, t) }; finalizeMissing(p: string) { return this.freshnessCoord.finalizeMissing(p) }
  status(activeSpaceId = this.embeddingCoord.currentProfile.embeddingId): DocumentMemoryStatus {
    const stats = this.store.stats(activeSpaceId); const files = this.store.recentDocuments(20).map(({ id, path, name, status }) => ({ id, path, name, status }))
    return { enabled: this.enabled, modelState: this.modelState, documents: stats.docs, chunks: stats.chunks, vectors: Math.min(stats.vectors, stats.chunks), pending: this.pendingCount + this.queue.length + this.embeddingCoord.getQueueLength(), errors: stats.errors, dbPath: this.dbPath, ...(this.lastError ? { lastError: this.lastError } : {}), files }
  }
  indexingActivityStatus(activeSpaceId = this.embeddingCoord.currentProfile.embeddingId) {
    const act = this.nowStatus(); const stats = this.store.stats(activeSpaceId); const migration = this.embeddingMigration.progress()
    return { enabled: this.enabled, modelState: this.modelState, ...(this.modelProgress === undefined ? {} : { modelProgress: this.modelProgress }), pending: this.pendingCount + this.queue.length + this.embeddingCoord.getQueueLength(), errors: stats.errors, mode: 'balanced', activity: act, activeEmbeddingSpace: activeSpaceId, semanticCoverage: stats.semanticCoverage, migrationState: migration.state }
  }
  embeddingSettings() { return this.embeddingCoord.getEmbeddingSettings() }; setEmbeddingProfile(id: EmbeddingProfileId) { const res = this.embeddingCoord.setEmbeddingProfile(id); if (res.changed) this.recycleWorker('Embedding profile changed'); return res }
  recycleEmbeddingWorker(reason = 'Recycle worker requested'): void { this.recycleWorker(reason) }
  async getStorageDiagnosticsAsync(backupPath?: string): Promise<DocumentIndexStorageDiagnostics | null> {
    const reply = await this.ask({ type: 'storage-diagnostics', backupPath }, this.workerTimeoutMs)
    return reply && 'result' in reply ? (reply.result as DocumentIndexStorageDiagnostics) : null
  }
  getPdfMaxPages(): number { return this.extractionCoord.getPdfMaxPages() }; setPdfMaxPages(pages: number) { return this.extractionCoord.setPdfMaxPages(pages, join(this.settingsDir, 'document-memory-pdf.json')) }; getMigrationDiagnostics(): DocumentIndexMigrationDiagnostics { const m = this.embeddingMigration.progress(); return { activeEmbeddingSpace: this.embeddingCoord.currentProfile.embeddingId, state: m.state, completedChunks: m.completedChunks, totalChunks: m.totalChunks } }
  setEnabled(enabled: boolean): DocumentMemoryStatus {
    const changed = this.enabled !== enabled; this.enabled = enabled; saveEnabled(this.enabledSettingsPath, enabled)
    if (!enabled) { this.epoch++; this.queue.length = 0; this.queued.clear(); this.embeddingCoord.clearQueue() }
    if (changed) for (const fn of this.enabledListeners) try { fn() } catch {}
    if (enabled) void this.poll(); return this.status()
  }
  exclude(path: string): void { this.store.exclude(path) }
  clear(): void {
    this.store.clear(); this.queue.length = 0; this.queued.clear(); this.urgent.clear(); this.deferred.clear(); this.embeddingCoord.clearQueue()
    for (const fn of this.clearedListeners) try { fn() } catch {}
  }
  async search(query: string, limit = 8): Promise<{ hits: FreshDocumentMemoryHit[]; pending: number; errors: number; modelState: string }> {
    const hits = await this.searchService.searchProgressive(query, limit, undefined, this.embeddingCoord.currentProfile.embeddingId)
    return { hits, pending: this.queue.length + this.pendingCount + this.embeddingCoord.getQueueLength(), errors: this.store.errorCount(), modelState: this.modelState }
  }
  searchProgressive(query: string, limit = 8, callbacks?: any) {
    return this.searchService.searchProgressive(query, limit, callbacks, this.embeddingCoord.currentProfile.embeddingId)
  }
  async read(chunkId: number): Promise<{ path: string; name: string; location: string; text: string; verified: boolean; error?: string }> {
    const hit = this.store.readChunk(chunkId); if (!hit) return { path: '', name: '', location: '', text: '', verified: false, error: 'The indexed chunk is no longer available.' }
    const generation = this.currentGeneration(hit.path); const epoch = this.epoch
    if ((await this.statOutcome(hit.path)).kind === 'gone') {
      this.freshnessCoord.markMissing(hit.path); return { path: hit.path, name: hit.name, location: hit.location, text: '', verified: false, error: 'The source file is temporarily unavailable.' }
    }
    const reply = await this.ask({ type: 'extract', path: hit.path, interactive: true, maxPdfPages: this.extractionCoord.getPdfMaxPages() }, this.workerTimeoutMs)
    if (!reply || !('result' in reply) || !isExtractResult(reply.result)) return { path: hit.path, name: hit.name, location: hit.location, text: '', verified: false, error: (reply && 'error' in reply && typeof reply.error === 'string') ? reply.error : 'Document verification timed out.' }
    const fresh = reply.result
    if (this.stopped || generation !== this.currentGeneration(hit.path) || epoch !== this.epoch || !this.store.documentByPath(hit.path) || this.store.documentByPath(hit.path)?.status === 'excluded') {
      return { path: hit.path, name: hit.name, location: hit.location, text: '', verified: false, error: 'Document memory changed during verification.' }
    }
    const after = await statMeta(hit.path)
    if (!after || after.mtimeMs !== fresh.mtimeMs || after.sizeBytes !== fresh.sizeBytes || fresh.hash !== hit.hash) {
      this.invalidatePath(hit.path); return { path: hit.path, name: hit.name, location: hit.location, text: '', verified: false, error: 'The source file has changed since it was indexed.' }
    }
    return { path: hit.path, name: hit.name, location: hit.location, text: hit.text, verified: true }
  }
  searchExternal(q: string, l: number) { return this.searchService.searchExternal(q, l) }; openOffered(p: string) { return this.searchService.openOffered(p) }; open(id: number) { return this.searchService.open(id) }
  async handleFileEvents(paths: string[]): Promise<void> {
    return this.freshnessCoord.handleFileEvents(paths, this.stabilityGate)
  }
  async reconcileFolder(root: string, files: Map<string, { mtimeMs: number; sizeBytes: number }>) {
    return this.freshnessCoord.reconcileFolder(root, files)
  }
  async readNowDocument(idOrPath: number | string): Promise<{ ok: boolean; error?: string; empty?: boolean }> {
    if (!this.enabled || this.stopped) return { ok: false, error: 'paused' }
    const path = typeof idOrPath === 'number' ? this.store.retryDocument(idOrPath) : resolve(idOrPath)
    if (!path) return { ok: false, error: 'unavailable' }
    if (typeof idOrPath === 'string') this.remember(path)
    if (this.activeExtractions.has(path)) {
      this.deferred.delete(path); this.urgent.add(path); await this.waitUntilRead(path)
      if (this.store.documentByPath(path)?.status !== 'pending') return readOutcome(this.store.documentByPath(path))
    }
    const blocking = [...this.activeExtractions].filter((o) => !this.slicing.has(o) && weightOf(this.activeBytes.get(o) ?? 0) >= 3)
    for (const o of blocking) { this.invalidatePath(o); this.enqueue(o) }
    if (blocking.length) this.recycleWorker(INTERRUPTED_FOR_USER)
    for (let attempt = 0; attempt < READ_NOW_ATTEMPTS; attempt++) {
      this.invalidatePath(path); this.urgent.delete(path); this.deferred.delete(path); await this.readOnce(path)
      if (this.store.documentByPath(path)?.status !== 'pending') break
    }
    return readOutcome(this.store.documentByPath(path))
  }
  private async waitUntilRead(path: string): Promise<void> {
    const deadline = Date.now() + this.workerTimeoutMs * 2
    while (!this.stopped && Date.now() < deadline && (this.activeExtractions.has(path) || this.queued.has(path)))
      await new Promise((r) => setTimeout(r, 20))
  }
  private async readOnce(path: string): Promise<void> {
    const generation = this.currentGeneration(path); const epoch = this.epoch
    this.activeGeneration.set(path, generation); this.activeExtractions.add(path)
    this.activeSince.set(path, Date.now()); this.pendingCount++
    try {
      const reply = await this.ask({ type: 'extract', path, interactive: true, maxPdfPages: this.extractionCoord.getPdfMaxPages() }, this.workerTimeoutMs, true)
      await this.applyExtractReply(path, reply, generation, epoch)
    } catch (error) {
      if (this.isCurrent(path, generation, epoch) && !(await this.sourceUnavailable(path))) {
        const msg = safeError(error)
        await this.store.markErrorSliced(path, msg, await statMeta(path), { shouldContinue: () => this.isCurrent(path, generation, epoch) }).catch(() => undefined)
        this.lastError = msg
      }
    } finally {
      if (this.activeGeneration.get(path) === generation) this.activeGeneration.delete(path)
      this.activeExtractions.delete(path); this.activeSince.delete(path); this.pendingCount--
    }
  }
  async triggerAnnSync(spaceId?: string) { return this.store.syncAnnIndex(spaceId ?? this.embeddingCoord.currentProfile.embeddingId) }
  currentGeneration(path: string): number { return this.pathGeneration.get(resolve(path)) ?? 0 }
  isCurrent(path: string, generation: number, epoch: number): boolean {
    if (this.stopped || !this.enabled || epoch !== this.epoch || generation !== this.currentGeneration(path)) return false
    const doc = this.store.documentByPath(path); return !!doc && doc.status !== 'excluded'
  }
  async sourceUnavailable(path: string): Promise<boolean> { return this.freshnessCoord.sourceUnavailable(path) }
  async migrateLegacyDocument(doc: DocumentNeedingUpgrade): Promise<boolean> { return this.legacyMigrator.migrate(doc, this.skippedMigrationDocs) }
  scheduleMigrationStep(delayMs = 1000): void {
    if (this.stopped || !this.enabled || isIndexingPaused()) return
    if (this.migrationTimer) clearTimeout(this.migrationTimer)
    this.migrationTimer = setTimeout(() => void this.runMigrationStep(), delayMs)
    this.migrationTimer.unref?.()
  }
  private async runMigrationStep(): Promise<void> {
    if (this.stopped || !this.enabled || isIndexingPaused()) return
    if (this.queue.length > 0 || this.activeExtractions.size > 0) { this.scheduleMigrationStep(1000); return }
    const needing = this.chunkUpgrade.getDocumentsNeedingUpgrade(1, this.skippedMigrationDocs)
    if (needing.length > 0) { await this.migrateLegacyDocument(needing[0]!); this.scheduleMigrationStep(500) }
  }
  close(): void {
    if (this.stopped) return
    this.stopped = true; this.stopPolicyWatch(); this.epoch++
    if (this.pollTimer) clearInterval(this.pollTimer); if (this.migrationTimer) clearTimeout(this.migrationTimer)
    this.maintScheduler.dispose(); this.freshnessCoord.clearMissing(); this.embeddingCoord.clearQueue(); this.skippedMigrationDocs.clear()
    this.queue.length = 0; this.queued.clear(); this.urgent.clear(); this.deferred.clear()
    const worker = this.worker; this.worker = null; if (worker && typeof (worker as any).terminate === 'function') void worker.terminate()
    this.store.close()
  }
  private enqueue(path: string, prioritize = false, bytes?: number): void {
    if (this.stopped || !this.enabled) return
    const p = resolve(path)
    if (this.activeGeneration.get(p) === this.currentGeneration(p)) return
    if (this.queued.has(p)) {
      if (prioritize) { const idx = this.queue.indexOf(p); if (idx > 0) { this.queue.splice(idx, 1); this.queue.unshift(p) } }
      return
    }
    const doc = this.store.documentByPath(p)
    if (!doc || doc.status === 'excluded') return
    this.pathGeneration.set(p, this.currentGeneration(p) + 1)
    const size = bytes ?? doc.sizeBytes ?? undefined
    if (size !== undefined) this.activeBytes.set(p, size)
    this.queued.add(p)
    if (prioritize) this.queue.unshift(p)
    else this.queue.push(p)
    void this.drain()
  }
  private takeNext(): string {
    const ordered = orderQueue(this.queue, { urgent: this.urgent, deferred: this.deferred, bytes: this.activeBytes })
    const path = ordered[0]!; const idx = this.queue.indexOf(path); if (idx >= 0) this.queue.splice(idx, 1)
    this.urgent.delete(path); return path
  }
  private makeWayForLightFiles(path: string, generation: number): void {
    if (this.stopped || !this.enabled) return
    if (!this.activeExtractions.has(path) || this.activeGeneration.get(path) !== generation) return
    const hasWaiting = this.queue.some((p) => !this.deferred.has(p) && weightOf(this.activeBytes.get(p) ?? 0) <= 2)
    if (hasWaiting) {
      this.deferred.add(path); this.invalidatePath(path); this.enqueue(path, false, this.activeBytes.get(path))
      this.recycleWorker('Made way for lighter documents')
    }
  }
  private drain(): void {
    if (this.stopped || !this.enabled || isIndexingPaused()) return
    if (!this.extracting && !this.embeddingCoord.isEmbedding() && this.queue.length > 0 && this.embeddingCoord.getQueueLength() < MAX_PENDING_EMBED_DOCUMENTS) void this.drainExtractions()
    if (!this.embeddingCoord.isEmbedding() && !this.extracting && this.embeddingCoord.getQueueLength() > 0 && !this.embeddingCoord.isRetryPending() && (this.queue.length === 0 || this.embeddingCoord.getQueueLength() >= MAX_PENDING_EMBED_DOCUMENTS)) void this.embeddingCoord.drainEmbeddings((req, timeout) => this.ask(req, timeout, true) as any)
  }
  private async drainExtractions(): Promise<void> {
    if (this.extracting || this.stopped) return
    this.extracting = true
    try {
      while (!this.stopped && this.enabled && !isIndexingPaused() && this.queue.length > 0 && this.embeddingCoord.getQueueLength() < MAX_PENDING_EMBED_DOCUMENTS) {
        const path = this.takeNext(); this.queued.delete(path); this.activeExtractions.add(path)
        this.activeSince.set(path, Date.now()); const generation = this.currentGeneration(path)
        const epoch = this.epoch; this.activeGeneration.set(path, generation); this.pendingCount++
        if (!this.activeBytes.has(path)) { const doc = this.store.documentByPath(path); if (doc?.sizeBytes) this.activeBytes.set(path, doc.sizeBytes) }
        const heavyWatch = setTimeout(() => this.makeWayForLightFiles(path, generation), this.autoDeferAfterMs)
        try {
          const sliceMs = /\.pdf$/i.test(path) && weightOf(this.activeBytes.get(path) ?? 0) >= 2 ? PDF_SLICE_MS : undefined
          if (sliceMs) this.slicing.add(path)
          const reply = await this.ask({ type: 'extract', path, maxPdfPages: this.extractionCoord.getPdfMaxPages(), ...(sliceMs ? { sliceMs } : {}) }, this.workerTimeoutMs, true)
          await this.applyExtractReply(path, reply, generation, epoch)
        } finally {
          clearTimeout(heavyWatch); this.slicing.delete(path)
          if (!this.queued.has(path)) this.activeBytes.delete(path)
          if (this.activeGeneration.get(path) === generation) this.activeGeneration.delete(path)
          this.activeExtractions.delete(path); this.activeSince.delete(path); this.pendingCount--
        }
      }
    } finally {
      this.extracting = false
      if (!this.stopped && this.enabled) this.drain()
    }
  }
  private async applyExtractReply(path: string, reply: WorkerReply | null, generation: number, epoch: number): Promise<void> {
    if (!this.isCurrent(path, generation, epoch)) return
    if (reply && 'result' in reply && isPartialExtract(reply.result)) {
      this.readProgress.set(path, { done: reply.result.pagesDone, total: reply.result.totalPages })
      this.activeGeneration.delete(path); this.enqueue(path, false, this.activeBytes.get(path)); return
    }
    if (!reply || !('result' in reply) || !isExtractResult(reply.result)) {
      if (await this.sourceUnavailable(path)) return
      const err = reply && 'error' in reply && typeof reply.error === 'string' ? reply.error : 'Document extraction timed out.'
      await this.store.markErrorSliced(path, err, await statMeta(path), { shouldContinue: () => this.isCurrent(path, generation, epoch) })
      this.lastError = err; return
    }
    const ext = reply.result; this.readProgress.delete(path); const prev = this.store.documentByPath(path); const lexicalOnly = !!ext.skipEmbeddings && ext.chunks.length > 0
    const resumeOffset = !lexicalOnly && prev?.mtimeMs === ext.mtimeMs && prev?.sizeBytes === ext.sizeBytes ? this.store.resumeVectorOffset(path, ext.hash, this.embeddingCoord.currentProfile.embeddingId) : null
    if (resumeOffset === null) {
      const written = await this.store.replaceDocumentSliced(path, {
        hash: ext.hash, mtimeMs: ext.mtimeMs, sizeBytes: ext.sizeBytes, chunks: ext.chunks,
        embeddingModel: null, status: extractedStatus(ext), error: ext.error, truncated: ext.truncated, truncatedReason: ext.truncatedReason ?? null,
      }, { shouldContinue: () => this.isCurrent(path, generation, epoch) })
      if (!written) return
      this.extractionCoord.recordScanInfo(path, ext as any); this.maintScheduler.scheduleFtsMaintenance()
    }
    this.lastError = undefined
    if (ext.chunks.length && !lexicalOnly) {
      this.embeddingCoord.enqueueEmbed({
        path, generation, epoch, hash: ext.hash, mtimeMs: ext.mtimeMs, sizeBytes: ext.sizeBytes,
        chunks: ext.chunks, startOffset: resumeOffset ?? 0,
      })
      this.drain()
    }
  }
  private invalidatePath(path: string): void {
    this.pathGeneration.set(path, this.currentGeneration(path) + 1)
    this.queued.delete(path); this.activeBytes.delete(path)
    const idx = this.queue.indexOf(path); if (idx >= 0) this.queue.splice(idx, 1)
    this.embeddingCoord.removePath(path)
  }
  private async poll(): Promise<void> {
    if (this.stopped || !this.enabled || isIndexingPaused()) return
    for (const p of this.store.incompletePaths()) this.enqueue(p)
    this.skippedMigrationDocs.clear(); this.scheduleMigrationStep(1000)
    this.drain()
  }
  private recycleWorker(reason: string): void {
    const worker = this.worker; if (!worker) return; this.worker = null; this.lastError = reason; if (typeof (worker as any).terminate === 'function') void worker.terminate()
    for (const [id, pending] of this.waiting) { clearTimeout(pending.timer); pending.resolve({ id, error: reason }); this.waiting.delete(id) }
  }
  private ask(request: WorkerRequest, timeoutMs: number, recycleOnTimeout = false): Promise<WorkerReply | null> {
    if (this.stopped) return Promise.resolve(null)
    const id = this.nextRequestId++
    return new Promise((resolveReply) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id); resolveReply(null)
        if (recycleOnTimeout && !this.stopped) this.recycleWorker('Indexing stalled and was restarted.')
      }, timeoutMs)
      this.waiting.set(id, { resolve: resolveReply, timer })
      try { this.ensureWorker().postMessage({ ...request, id }) } catch (error) {
        clearTimeout(timer); this.waiting.delete(id); resolveReply({ id, error: safeError(error) })
      }
    })
  }
  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    mkdirSync(this.cacheDir, { recursive: true })
    const worker = this.workerFactory(this.pathToWorker, { cacheDir: this.cacheDir, dbPath: this.dbPath, embeddingProfile: this.embeddingCoord.currentProfile.embeddingId } as any)
    worker.on('message', (msg: WorkerReply) => {
      if (this.worker !== worker) return
      if ('type' in msg && msg.type === 'model') {
        this.modelState = msg.state as any; this.modelProgress = (msg as any).progress
        if (msg.error) this.lastError = msg.error; else if (msg.state === 'ready') this.lastError = undefined
        return
      }
      if (!('id' in msg)) return
      const p = this.waiting.get(msg.id); if (!p) return
      clearTimeout(p.timer); this.waiting.delete(msg.id); p.resolve(msg)
      if ('error' in msg && msg.restartRequired === true) this.recycleWorker(msg.error)
    })
    const fail = (error: string) => {
      if (this.worker !== worker) return
      this.worker = null; this.modelState = 'error'; this.lastError = error
      for (const [id, p] of this.waiting) { clearTimeout(p.timer); p.resolve({ id, error }); this.waiting.delete(id) }
    }
    worker.on('error', (e) => fail(safeError(e))); worker.on('exit', () => { if (!this.stopped && this.worker === worker) fail('Document memory worker exited unexpectedly.') })
    this.worker = worker; return worker
  }
}
