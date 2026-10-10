import { startJunkPurge } from './runtime/junk-purge'; import { enqueueIncompletePaged } from './runtime/poll-intake'; import { appendBootstrapLog } from './bootstrap-log'; import { currentIndexingPolicy } from '../fork/indexing-policy-bus'; import { WorkerHost } from './runtime/worker-host'; import { VectorGate } from './runtime/vector-gate'; import { QueueLanes, EXTRACT_SLICE_MS, EMBED_SLICE_MS } from './runtime/queue-lanes'; import { QueueWatchdog, blockedReasonOf, type QueueProbe } from './runtime/queue-health'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { writeExtractedContentSliced, getValidatedFreeDiskBytes } from './runtime/content-write-budget'
import type { Worker } from 'node:worker_threads'
import type { DocumentIndexProgress } from '@genoffice/agent-core'; import type { FolderIndexProgress } from './folder-progress'
import type { DocumentIndexStorageDiagnostics, DocumentIndexMigrationDiagnostics, IndexingBlockReason, IndexingNow } from '../../shared/fork/document-index-api'
import type { DocumentMemoryStatus } from '../../shared/home-api'; import { DocumentMemoryStore, type FolderChunkProgress, type DocumentMemoryStats } from './store'; import { StatusAggregates, createThreadFetcher } from './runtime/status-aggregates'
import type { EmbeddingProfileId, MachineSpec } from './embedding-profiles'; import { resolveStartupEmbeddingProfile } from './embedding/initial-profile'; import { modelFilesCached } from './embedding/model-files'; import { createOcrHost, type OcrHostInput } from './ocr-host'; import type { OcrJobHost } from './agy-ocr-job'; import { createLocalOcrWiring, type LocalOcrWiring, type LocalOcrWiringDeps } from './runtime/local-ocr-wiring'; import type { LocalOcrGate } from './local-ocr/local-ocr-job'; import type { LocalOcrSettings } from '../../shared/fork/agy-ocr'
import { FileStabilityGate, type FileStabilityGateOptions } from './file-stability'; import { BackgroundWorkGate, isIndexingPaused, onIndexingPolicyChange } from './background-work-gate'
import { ChunkUpgradeCoordinator, type DocumentNeedingUpgrade } from './chunk-upgrade'; import { EmbeddingMigration } from './embedding-migration'
import { SearchService, type FreshDocumentMemoryHit } from './runtime/search-service'; import { FreshnessCoordinator } from './runtime/freshness-coordinator'; import type { PendingMetadataIntake } from './runtime/pending-metadata-intake'; import { createPendingIntake } from './runtime/pending-intake-wiring'; import { createCompactionWiring } from './runtime/compaction-wiring'
import { ExtractionCoordinator, statMeta, isPartialExtract, isExtractResult, readOutcome, READ_NOW_ATTEMPTS, INTERRUPTED_FOR_USER, PDF_SLICE_MS } from './runtime/extraction-coordinator'
import { EmbeddingCoordinator } from './runtime/embedding-coordinator'; import { reserveExtractionLease } from './runtime/extraction-lease'
import { MaintenanceScheduler, INITIAL_MAINTENANCE_DELAY_MS } from './runtime/maintenance-scheduler'; import { LegacyChunkMigrator } from './runtime/legacy-chunk-migrator'; import { AdmissionRetry } from './runtime/admission-retry'
import { readActiveEmbeddingConfig } from './storage/embedding-settings'; import { StorageAdmissionController } from './runtime/storage-admission'; import { AnnHostAdmissionCoordinator } from './runtime/ann-host-admission'; import { SyncMetadataAdmissionCoordinator } from './runtime/sync-metadata-admission'
import { StorageBudgetCoordinator } from './runtime/storage-budget-coordinator'; import type { StorageBudgetConfig, StorageBudgetPreset } from './storage/storage-settings'
import { createStorageBudget, type DocumentIndexStorageBudget, type StorageBudgetSnapshot } from './storage-budget'
import { createIndexProcess } from './process-worker'; import workerPath from './worker?modulePath'
import { safeError } from './issues'; import { orderQueue, nextInOrder, weightOf } from './queue-order'; import type { WorkerRequest, WorkerReply } from './worker-types'
export type { FreshDocumentMemoryHit }
function readEnabled(p: string): boolean { try { return JSON.parse(readFileSync(p, 'utf8'))?.enabled !== false } catch { return true } }
function saveEnabled(p: string, enabled: boolean): void { try { writeFileSync(p, JSON.stringify({ enabled }), { mode: 0o600 }) } catch {} }
export interface DocumentMemoryManagerOptions {
  pathToWorker?: string; junkPurgeDelayMs?: number /* delay before the one-time junk purge starts asking the worker (default 8 s) */; workerPath?: string; workerFactory?: (script: string, env: Record<string, string>) => Worker
  workerTimeoutMs?: number; dbDir?: string; cacheDir?: string; settingsDir?: string; budget?: DocumentIndexStorageBudget
  tombstoneGraceMs?: number; pollIntervalMs?: number; autoDeferAfterMs?: number; initialEnabled?: boolean; externalNames?: (query: string, limit: number) => Promise<Array<{ path: string; name: string }>>; backupRetentionRunner?: any
  stabilityRetryScheduleMs?: number[]; stabilityGateOptions?: FileStabilityGateOptions
  /** Production passes the machine: a fresh install (no saved model, no index) then starts on the tier that fits it. Omitted = legacy default. */
  machineSpec?: MachineSpec
}
/** Central coordinator for background document extraction, vector indexing, and search. */
export class DocumentMemoryManager {
  readonly store: DocumentMemoryStore; readonly admission = new StorageAdmissionController(); private readonly syncAdmissionCoord: SyncMetadataAdmissionCoordinator
  private readonly searchService: SearchService; private readonly freshnessCoord: FreshnessCoordinator; private readonly pendingIntake: PendingMetadataIntake
  private readonly extractionCoord: ExtractionCoordinator; private readonly embeddingCoord: EmbeddingCoordinator
  private readonly maintScheduler: MaintenanceScheduler; private readonly legacyMigrator: LegacyChunkMigrator
  private readonly pathToWorker: string; private readonly workerFactory: (script: string, env: Record<string, string>) => Worker
  private readonly workerTimeoutMs: number; private readonly autoDeferAfterMs: number
  private readonly cacheDir: string; private readonly settingsDir: string; private readonly enabledSettingsPath: string
  readonly dbPath: string; private readonly budgetCoord: StorageBudgetCoordinator
  private readonly host = new WorkerHost({
    factory: (s, env) => this.workerFactory(s, env), script: () => this.pathToWorker, cacheDir: () => this.cacheDir, isStopped: () => this.stopped, defaultTimeoutMs: () => this.workerTimeoutMs, isWriteReady: () => this.budgetCoord.isWriteReady(), recover: () => void this.budgetCoord.recover(),
    env: () => { const cfg = this.budgetCoord.getConfig(); return { cacheDir: this.cacheDir, dbPath: this.dbPath, embeddingProfile: this.embeddingCoord.currentProfile.id, storageBudget: this.maintScheduler.budget, configVersion: cfg.version, GENOFFICE_STORAGE_BUDGET: JSON.stringify(this.maintScheduler.budget), GENOFFICE_STORAGE_CONFIG_VERSION: String(cfg.version) } },
    spawned: () => void this.budgetCoord.onWorkerSpawned(), recycled: (reason) => this.budgetCoord.onWorkerRecycled(reason), releaseReservations: () => this.releaseWorkerReservations(),
    onModel: (msg) => { this.modelState = msg.state as any; this.modelProgress = (msg as any).progress; if (msg.error) this.lastError = msg.error; else if (msg.state === 'ready') this.lastError = undefined },
    onFailure: (error, fatal) => { if (fatal) this.modelState = 'error'; this.lastError = error },
  })
  private stopped = false; private stopJunkPurge: (() => void) | null = null; private statusAgg: StatusAggregates | null = null; private enabled = true; private localOcrWiring?: LocalOcrWiring
  private modelState: 'not-loaded' | 'downloading' | 'ready' | 'blocked' | 'error' = 'not-loaded'; private modelProgress?: number; private lastError: string | undefined
  private pendingCount = 0; private epoch = 0; private extracting = false; private readonly queue: string[] = []
  private readonly gate = new VectorGate(() => this.embeddingCoord.getQueueLength()); private readonly lanes = new QueueLanes(); private progressTicks = 0
  private readonly watchdog = new QueueWatchdog((line) => appendBootstrapLog(this.settingsDir, 'warn', line))
  private readonly queued = new Set<string>(); private readonly urgent = new Set<string>(); private readonly deferred = new Set<string>(); private readonly slicing = new Set<string>()
  private readonly activeBytes = new Map<string, number>(); private readonly activeExtractions = new Set<string>(); private readonly activeSince = new Map<string, number>()
  private readonly activeGeneration = new Map<string, number>(); private readonly pathGeneration = new Map<string, number>(); private readonly readProgress = new Map<string, { done: number; total: number }>()
  private readonly skippedMigrationDocs = new Set<number>(); private readonly enabledListeners = new Set<() => void>(); private readonly clearedListeners = new Set<() => void>()
  private readonly counterBackfill: Promise<void>; private migrationTimer: NodeJS.Timeout | null = null; private pollTimer: NodeJS.Timeout | null = null; private shutdownPromise: Promise<void> | null = null
  private readonly stopPolicyWatch: () => void; private readonly stabilityGate: FileStabilityGate; private readonly backgroundGate: BackgroundWorkGate
  private readonly chunkUpgrade: ChunkUpgradeCoordinator; private readonly embeddingMigration: EmbeddingMigration
  private readonly admissionRetry = new AdmissionRetry({ refresh: async () => { const s = await this.maintScheduler.refreshAccountingAsync(); return s.measurementStatus === 'fresh' && !s.isDegraded }, resume: () => void this.poll(), isActive: () => this.enabled && !this.stopped && !isIndexingPaused() })
  private async runCounterBackfill(): Promise<void> {
    try { await new Promise<void>((r) => setImmediate(r)); while (!this.stopped && this.store.backfillCounters()) { await new Promise<void>((r) => setImmediate(r)) } } catch { /* ignore */ }
  }
  private ocrHostInput(): OcrHostInput {
    return { store: this.store, isEnabled: () => this.isEnabled(), isStopped: () => this.stopped, admission: this.admission, maintScheduler: this.maintScheduler, budgetCoord: this.budgetCoord, dbDir: dirname(this.dbPath), workerTimeoutMs: this.workerTimeoutMs, askWorker: (req, timeout) => this.ask(req as any, timeout), reindex: (path) => this.enqueue(resolve(path), true) }
  }
  ocrHost(): OcrJobHost { return createOcrHost(this.ocrHostInput()) }
  /** Local OCR pass + the cloud host that waits for it; one per manager. The OCR scheduler tick calls `.runner.tick()`. */
  localOcr(settings: () => LocalOcrSettings, gate: () => LocalOcrGate, seams: Partial<LocalOcrWiringDeps> = {}): LocalOcrWiring {
    return (this.localOcrWiring ??= createLocalOcrWiring({ hostInput: this.ocrHostInput(), db: this.store.rawDb, ask: (r, t) => this.ask(r as any, t), settings, gate, isActive: () => this.enabled && !this.stopped, epoch: () => this.epoch, canWork: () => !this.maintScheduler.isCompactionRunning() && this.maintScheduler.checkStorageBudget().limitState !== 'full', ...seams }))
  }
  get lastIndexError(): string | undefined { return this.lastError }; countersReady(): Promise<void> { return this.counterBackfill }
  constructor(userDataDir: string, options: DocumentMemoryManagerOptions = {}) {
    const dbDir = options.dbDir ?? userDataDir; this.dbPath = join(dbDir, 'document-memory.db')
    this.cacheDir = options.cacheDir ?? join(userDataDir, 'document-memory-models'); this.settingsDir = options.settingsDir ?? userDataDir
    this.enabledSettingsPath = join(this.settingsDir, 'enabled.json'); this.pathToWorker = options.pathToWorker ?? options.workerPath ?? workerPath
    this.workerFactory = options.workerFactory ?? ((s, env) => createIndexProcess(s, env as any)); this.workerTimeoutMs = options.workerTimeoutMs ?? 60_000
    this.autoDeferAfterMs = options.autoDeferAfterMs ?? 30_000; this.enabled = options.initialEnabled ?? readEnabled(this.enabledSettingsPath)
    mkdirSync(dbDir, { recursive: true }); if (options.machineSpec) resolveStartupEmbeddingProfile({ settingsDir: this.settingsDir, dbPath: this.dbPath, spec: options.machineSpec })
    let initialBudget: DocumentIndexStorageBudget = options.budget ?? createStorageBudget()
    const wiring = createCompactionWiring({ getScheduler: () => this.maintScheduler, triggerAnnSync: (sp) => this.triggerAnnSync(sp), poll: () => this.poll(), replayIntake: () => this.pendingIntake.triggerReplay(), isActive: () => this.enabled && !this.stopped, importanceOf: (p) => this.store.getImportance(p)?.effective })
    this.syncAdmissionCoord = new SyncMetadataAdmissionCoordinator({
      admission: this.admission, getStorageBudget: () => this.maintScheduler?.budget ?? initialBudget,
      isWriteReady: () => Boolean(this.budgetCoord?.isWriteReady()),
      refreshAccountingAsync: () => this.maintScheduler ? this.maintScheduler.refreshAccountingAsync() : Promise.resolve(null),
      getStorageBudgetSnapshot: () => this.maintScheduler?.checkStorageBudget(),
      getFreeDiskBytes: () => getValidatedFreeDiskBytes(dirname(this.dbPath)),
      isStopped: () => this.stopped || !this.enabled, dbPath: this.dbPath, onQuotaPressure: wiring.onSyncQuotaPressure,
    })
    this.store = new DocumentMemoryStore(this.dbPath, { role: 'search', syncAdmission: this.syncAdmissionCoord })
    this.counterBackfill = this.runCounterBackfill()
    try { this.store.repairInvalidCanonicalEmbeddings() } catch (err) { console.warn('[DocumentMemoryManager] Canonical embedding repair failed:', err) }
    this.pendingIntake = createPendingIntake({ store: this.store, isWriteReady: () => Boolean(this.budgetCoord?.isWriteReady()), getMaintScheduler: () => this.maintScheduler, getSyncAdmission: () => this.syncAdmissionCoord, getFreshness: () => this.freshnessCoord, isStopped: () => this.stopped, isEnabled: () => this.enabled, enqueue: (p, prioritize) => this.enqueue(p, prioritize), setLastError: (err) => { this.lastError = err } })
    this.freshnessCoord = new FreshnessCoordinator({
      store: this.store, tombstoneGraceMs: options.tombstoneGraceMs, stabilityRetryScheduleMs: options.stabilityRetryScheduleMs,
      onEnqueue: (p, prior, bytes) => this.enqueue(p, prior, bytes), onTombstone: async (p) => { this.pendingIntake.remove(p); await this.store.tombstoneSliced(p) },
      onInvalidatePath: (p) => this.invalidatePath(p), isStopped: () => this.stopped, isEnabled: () => this.enabled, intakeAdapter: this.pendingIntake.getAdapter(),
    })
    const embeddingConfig = readActiveEmbeddingConfig(this.settingsDir)
    this.budgetCoord = new StorageBudgetCoordinator({
      settingsDir: this.settingsDir, getMaintBudget: () => this.maintScheduler.budget, setMaintBudget: (b) => this.maintScheduler.setBudget(b),
      askWorker: (req, timeout) => this.ask(req, timeout, false), isStopped: () => this.stopped, workerTimeoutMs: this.workerTimeoutMs,
      onWriteReady: () => { if (this.enabled && !this.stopped) { this.drain(); void this.pendingIntake.triggerReplay() } },
      onHandshakeFailure: (err) => { if (!this.stopped && this.host.isUp) this.recycleWorker(`Handshake failed: ${err}`) },
    })
    initialBudget = options.budget ?? createStorageBudget(this.budgetCoord.getConfig().maxDatabaseBytes)
    this.embeddingCoord = new EmbeddingCoordinator({
      store: this.store, settingsDir: this.settingsDir, initialProfileId: embeddingConfig.profileId,
      workerTimeoutMs: this.workerTimeoutMs, isStopped: () => this.stopped || !this.enabled, isStoppedOrPaused: () => this.stopped || !this.enabled || isIndexingPaused(),
      isCurrent: (p, gen, ep) => this.isCurrent(p, gen, ep), onDrainNeeded: () => this.drain(), onEnqueueExtract: (p) => this.enqueue(p), onError: (err) => { this.lastError = err },
      canAcceptExpensiveWork: () => this.maintScheduler.refreshCanAcceptExpensiveWork(), admission: this.admission, getStorageBudget: () => this.maintScheduler.budget, makeRoom: wiring.embeddingMakeRoom,
      getCurrentUsage: () => { const s = this.maintScheduler.checkStorageBudget(); return s.totalManagedBytes ?? s.databaseBytes },
      isDegraded: () => Boolean(this.maintScheduler.checkStorageBudget().isDegraded), refreshUsage: () => this.maintScheduler.refreshAccountingAsync(), isWriteReady: () => this.budgetCoord.isWriteReady(),
      getFreeDiskBytes: () => getValidatedFreeDiskBytes(dirname(this.dbPath)), invalidateAccounting: (reason) => { this.maintScheduler.invalidateAccounting(reason) },
      onAdmission: (blocked, accounting) => { if (blocked) this.admissionRetry.request(accounting); else this.admissionRetry.succeeded() },
    })
    this.searchService = new SearchService({
      store: this.store, externalNames: options.externalNames, onSkeletonOpened: (id) => { this.retryDocument(id) },
      askEmbed: async (t) => {
        if (this.modelState === 'downloading' || this.modelState === 'error' || this.modelState === 'blocked') return null
        const r = await this.ask({ type: 'embed', texts: [t], kind: 'query' }, this.workerTimeoutMs); return r && 'result' in r && Array.isArray(r.result) ? (r.result[0] as number[]) : null
      },
      askSemantic: async (v, lim, sp) => { const r = await this.ask({ type: 'search-semantic', vector: v, limit: lim, embeddingSpaceId: sp }, 30_000); return r && 'result' in r && Array.isArray(r.result) ? (r.result as any) : null },
      annotateFreshness: (hits) => this.freshnessCoord.annotateFreshness(hits),
    })
    this.stabilityGate = new FileStabilityGate(options.stabilityGateOptions); this.backgroundGate = new BackgroundWorkGate()
    this.extractionCoord = new ExtractionCoordinator({ store: this.store, workerTimeoutMs: this.workerTimeoutMs, pdfPagesPath: join(this.settingsDir, 'document-memory-pdf.json') })
    this.maintScheduler = new MaintenanceScheduler({
      store: this.store, backgroundGate: this.backgroundGate, askWorker: (req, t) => this.ask(req, t ?? 30_000), onCompactionReleased: wiring.onReleased, onAnnRebuildRequests: wiring.onAnnRebuildRequests,
      isPaused: () => !this.enabled || isIndexingPaused(), isStopped: () => this.stopped,
      isQueued: (p) => this.queued.has(p), isExtracting: (p) => this.activeExtractions.has(p),
      isWriteReady: () => this.budgetCoord.isWriteReady(), admission: this.admission, getFreeDiskBytes: () => getValidatedFreeDiskBytes(dirname(this.dbPath)),
      onBudgetStateChange: (state) => { if (state !== 'full' && this.enabled && !this.stopped) { void this.poll(); void this.pendingIntake.triggerReplay() } }, budget: initialBudget, backupRetentionRunner: (options as any).backupRetentionRunner,
    })
    this.chunkUpgrade = new ChunkUpgradeCoordinator(this.store)
    this.legacyMigrator = new LegacyChunkMigrator({
      store: this.store, freshnessCoord: this.freshnessCoord, extractionCoord: this.extractionCoord, maintScheduler: this.maintScheduler, chunkUpgrade: this.chunkUpgrade,
      askExtract: (p) => this.ask({ type: 'extract', path: p, maxPdfPages: this.extractionCoord.getPdfMaxPages() }, this.workerTimeoutMs),
      enqueue: (p, prior) => this.enqueue(p, prior), currentGeneration: (p) => this.currentGeneration(p), isCurrent: (p, gen, ep) => this.isCurrent(p, gen, ep), getEpoch: () => this.epoch, isStoppedOrPaused: () => this.stopped || !this.enabled || isIndexingPaused(),
    })
    this.embeddingMigration = new EmbeddingMigration(this.store.rawDb); this.embeddingMigration.setTarget(this.embeddingCoord.currentProfile.embeddingId)
    this.stopPolicyWatch = onIndexingPolicyChange((policy) => {
      if (this.modelState === 'blocked' && (policy as any).allowHeavyEmbedding !== false) { this.modelState = 'not-loaded'; this.lastError = undefined }
      if (!policy.paused && this.enabled && !this.stopped) { void this.poll(); this.drain(); this.maintScheduler.scheduleFtsMaintenance() } else if (policy.paused) this.maintScheduler.cancelCompaction()
    })
    const pollInterval = options.pollIntervalMs ?? 60_000; this.pollTimer = setInterval(() => void this.poll(), pollInterval); this.pollTimer.unref?.()
    if (this.enabled) { void this.poll(); this.ensureWorker() }; this.maintScheduler.schedulePeriodicMaintenance(INITIAL_MAINTENANCE_DELAY_MS)
    setTimeout(() => { if (!this.stopped) this.stopJunkPurge = startJunkPurge({ store: this.store, ask: (r, t) => this.ask(r, t), isActive: () => this.enabled && !this.stopped, onRemoved: () => this.store.invalidateAnnInMemory(this.embeddingCoord.currentProfile.embeddingId) }) }, options.junkPurgeDelayMs ?? 8000).unref?.()
  }
  onEnabledChange(l: () => void): () => void { this.enabledListeners.add(l); return () => this.enabledListeners.delete(l) }
  onCleared(l: () => void): () => void { this.clearedListeners.add(l); return () => this.clearedListeners.delete(l) }
  nowStatus(): IndexingNow {
    const active = this.activeExtractions.values().next().value ?? null
    const positions: Record<string, number> = {}
    orderQueue(this.queue, { urgent: this.urgent, deferred: this.deferred, bytes: this.activeBytes, prioritize: (p) => this.maintScheduler.isRecentUnderQuotaPressure(p) }).slice(0, 400).forEach((p, i) => { positions[p] = i + 1 })
    const pages = Object.fromEntries(this.readProgress); const blocked = this.blockedReason()
    return {
      extracting: active ? [{ path: active, since: this.activeSince.get(active) ?? Date.now() }] : [],
      embedding: this.embeddingCoord.getEmbeddingProgress(), positions, pages, queued: this.queue.length + this.pendingCount + this.embeddingCoord.getQueueLength() + this.gate.parked, paused: isIndexingPaused(),
      ...(blocked ? { blocked } : {}),
    }
  }
  remember(path: string): void {
    const p = resolve(path); if (this.stopped) return
    if (!this.enabled || !this.budgetCoord.isWriteReady() || !this.syncAdmissionCoord.isReady()) {
      const res = this.pendingIntake.enqueue(p, 'remember'); const r = this.syncAdmissionCoord.getLastRejectionReason() ?? res.reason; if (r) this.lastError = r; return
    }
    const admitted = this.store.remember(p)
    if (!admitted) {
      const r = this.syncAdmissionCoord.getLastRejectionReason(); const res = this.pendingIntake.enqueue(p, 'remember', undefined, r); if (r || res.reason) this.lastError = r ?? res.reason; return
    }
    this.pendingIntake.remove(p); this.enqueue(p, true)
  }
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
    const p = doc.path; this.deferred.add(p); this.urgent.delete(p); const reading = this.activeExtractions.has(p); this.invalidatePath(p)
    if (reading && !this.slicing.has(p)) { this.enqueue(p, false, this.activeBytes.get(p)); this.recycleWorker(INTERRUPTED_FOR_USER) }
    return { ok: true }
  }
  async stopDocument(idOrPath: number | string): Promise<{ ok: boolean; error?: string }> {
    const doc = typeof idOrPath === 'number' ? this.store.documentById(idOrPath) : this.store.documentByPath(resolve(idOrPath))
    if (!doc || !['pending', 'text-only'].includes(doc.status)) return { ok: false, error: 'unavailable' }
    const p = doc.path; this.pendingIntake.remove(p); this.invalidatePath(p)
    if (this.activeExtractions.has(p) || this.embeddingCoord.isEmbeddingPath(p)) this.recycleWorker('Stopped by you.')
    await this.store.markErrorSliced(p, 'Stopped by you.', await statMeta(p)); return { ok: true }
  }
  indexDocumentPath(id: number): string | null { const d = this.store.documentById(id); return d && d.status !== 'excluded' ? d.path : null }
  move(oldPath: string, newPath: string): void {
    const oldR = resolve(oldPath); const newR = resolve(newPath)
    this.pendingIntake.transfer(oldR, newR); this.invalidatePath(oldR); if (!this.store.documentByPath(oldR)) return
    try { this.store.move(oldR, newR) } catch (err) {
      if (!this.store.documentByPath(newR)) throw err
      this.store.markError(oldR, 'Document moved to an already remembered path.', null)
    }
    if (this.enabled && this.store.documentByPath(newR)?.status !== 'excluded') this.enqueue(newR)
  }
  // Scoped progress APIs to active embedding space (BEH-20)
  legacyPaths(ext: readonly string[], lim: number) { return this.store.legacyPaths(ext, lim) }; listPaths() { return this.store.listPaths() }; getDocumentIndexProgress(p: string, activeSpaceId = this.embeddingCoord.currentProfile.embeddingId): DocumentIndexProgress { const pr = this.maintScheduler.getDocumentIndexProgress(p, activeSpaceId); return (this.store.documentByPath(resolve(p))?.status === 'ready' && pr.state === 'indexing') ? { ...pr, state: 'ready', percent: 100 } : pr }
  getFolderIndexProgress(f?: string, d?: boolean | string, e?: number, activeSpaceId = this.embeddingCoord.currentProfile.embeddingId): FolderIndexProgress { return this.maintScheduler.getFolderIndexProgress(f, d, e, activeSpaceId) }
  getFolderIndexCounts(f?: string, s = this.embeddingCoord.currentProfile.embeddingId): FolderChunkProgress { return this.maintScheduler.getFolderIndexCounts(f, s) }; getLibraryIndexCounts(s = this.embeddingCoord.currentProfile.embeddingId): FolderChunkProgress { return this.maintScheduler.getLibraryIndexCounts(s) }; prioritizeFolder(folder: string): number { return this.freshnessCoord.prioritizeFolder(folder) }
  runFtsMaintenance(): Promise<void> { return this.maintScheduler.runFtsMaintenance() }; scheduleFtsMaintenance(delayMs?: number): void { this.maintScheduler.scheduleFtsMaintenance(delayMs) }
  runGcStep(): Promise<void> { return this.maintScheduler.runGcStep() }; runVacuumStep(): Promise<void> { return this.maintScheduler.runVacuumStep() }; runPeriodicMaintenance(): Promise<void> { return this.maintScheduler.runPeriodicMaintenance() }; runNameProjectionBackfill(b?: number, m?: number): Promise<void> { return this.maintScheduler.runNameProjectionBackfill(b, m) }; statOutcome(p: string, t?: number) { return this.freshnessCoord.statOutcome(p, t) }; finalizeMissing(p: string) { return this.freshnessCoord.finalizeMissing(p) }
  /** Dashboard aggregates computed in a reader thread (stale-while-revalidate): what IPC pollers read; `status()` and `indexingActivityStatus()` stay exact and synchronous for callers that need that. */
  get aggregates(): StatusAggregates { return (this.statusAgg ??= new StatusAggregates(createThreadFetcher(this.dbPath), { activeSpace: () => this.embeddingCoord.currentProfile.embeddingId })) }
  status(activeSpaceId = this.embeddingCoord.currentProfile.embeddingId, stats: DocumentMemoryStats = this.store.stats(activeSpaceId)): DocumentMemoryStatus {
    const files = this.store.recentDocuments(20).map(({ id, path, name, status }) => ({ id, path, name, status }))
    return { enabled: this.enabled, modelState: this.modelState, documents: stats.docs, chunks: stats.chunks, vectors: Math.min(stats.vectors, stats.chunks), pending: this.pendingCount + this.queue.length + this.embeddingCoord.getQueueLength() + this.gate.parked + this.pendingIntake.size, errors: stats.errors, dbPath: this.dbPath, ...(this.lastError ? { lastError: this.lastError } : {}), files }
  }
  indexingActivityStatus(activeSpaceId = this.embeddingCoord.currentProfile.embeddingId, stats: DocumentMemoryStats = this.store.stats(activeSpaceId)) {
    const act = this.nowStatus(); const migration = this.embeddingMigration.progress()
    return { enabled: this.enabled, modelState: this.modelState, ...(this.modelProgress === undefined ? {} : { modelProgress: this.modelProgress }), pending: this.pendingCount + this.queue.length + this.embeddingCoord.getQueueLength() + this.gate.parked, errors: stats.errors, mode: 'balanced', activity: act, activeEmbeddingSpace: activeSpaceId, semanticCoverage: stats.semanticCoverage, migrationState: migration.state }
  }
  embeddingSettings() { return this.embeddingCoord.getEmbeddingSettings() }; embeddingModelCached(): boolean { return modelFilesCached(this.cacheDir, this.embeddingCoord.currentProfile) }; recycleEmbeddingWorker(reason = 'Recycle worker requested'): void { this.recycleWorker(reason) }
  setEmbeddingProfile(id: EmbeddingProfileId) {
    const res = this.embeddingCoord.setEmbeddingProfile(id)
    if (res.changed) { this.epoch++; this.recycleWorker('Embedding profile changed'); this.embeddingMigration.setTarget(this.embeddingCoord.currentProfile.embeddingId) }
    return res
  }
  async getStorageDiagnosticsAsync(backupPath?: string): Promise<DocumentIndexStorageDiagnostics | null> {
    const reply = await this.ask({ type: 'storage-diagnostics', backupPath, budget: this.maintScheduler.budget }, this.workerTimeoutMs); return reply && 'result' in reply ? { ...(reply.result as DocumentIndexStorageDiagnostics), ...(this.maintScheduler.getLastCompactionOutcome() ? { lastCompaction: this.maintScheduler.getLastCompactionOutcome() as unknown as Record<string, unknown> } : {}) } : null
  }
  getStorageBudget(): DocumentIndexStorageBudget { return this.maintScheduler.budget }; getStorageBudgetSnapshot(): StorageBudgetSnapshot { return this.maintScheduler.getStorageBudgetSnapshot() }; getStorageBudgetConfig(): StorageBudgetConfig { return this.budgetCoord.getConfig() }
  setStorageBudget(input: StorageBudgetConfig | { maxDatabaseBytes?: number; preset?: StorageBudgetPreset; version?: number } | number): Promise<StorageBudgetConfig> { return this.budgetCoord.setStorageBudget(input) }; runBackupRetentionMaintenance(): Promise<{ purgedCount: number }> { return this.maintScheduler.runBackupRetentionMaintenance() }
  getPdfMaxPages(): number { return this.extractionCoord.getPdfMaxPages() }; setPdfMaxPages(pages: number) { return this.extractionCoord.setPdfMaxPages(pages, join(this.settingsDir, 'document-memory-pdf.json')) }; getMigrationDiagnostics(): DocumentIndexMigrationDiagnostics { const m = this.embeddingMigration.progress(); return { activeEmbeddingSpace: this.embeddingCoord.currentProfile.embeddingId, state: m.state, completedChunks: m.completedChunks, totalChunks: m.totalChunks } }
  setEnabled(enabled: boolean): DocumentMemoryStatus {
    const changed = this.enabled !== enabled; this.enabled = enabled; saveEnabled(this.enabledSettingsPath, enabled)
    if (!enabled) { this.epoch++; this.queue.length = 0; this.queued.clear(); this.gate.clear(); this.embeddingCoord.clearQueue(); this.maintScheduler.cancelCompaction(); this.localOcrWiring?.runner.cancel() }
    if (changed) for (const fn of this.enabledListeners) try { fn() } catch {}
    if (enabled) { if (!this.stopped) this.ensureWorker(); void this.poll(); void this.pendingIntake.triggerReplay() }; return this.status()
  }
  exclude(path: string): void { this.pendingIntake.remove(resolve(path)); this.store.exclude(path) }
  clear(): void {
    this.store.clear(); this.queue.length = 0; this.queued.clear(); this.gate.clear(); this.urgent.clear(); this.deferred.clear(); this.embeddingCoord.clearQueue(); this.pendingIntake.clear()
    for (const fn of this.clearedListeners) try { fn() } catch {}
  }
  async search(query: string, limit = 8): Promise<{ hits: FreshDocumentMemoryHit[]; pending: number; errors: number; modelState: string }> {
    const hits = await this.searchService.searchProgressive(query, limit, undefined, this.embeddingCoord.currentProfile.embeddingId)
    return { hits, pending: this.queue.length + this.pendingCount + this.embeddingCoord.getQueueLength() + this.gate.parked, errors: this.store.errorCount(), modelState: this.modelState }
  }
  searchProgressive(query: string, limit = 8, callbacks?: any) { return this.searchService.searchProgressive(query, limit, callbacks, this.embeddingCoord.currentProfile.embeddingId) }
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
  handleFileEvents(paths: string[]): Promise<void> { return this.freshnessCoord.handleFileEvents(paths, this.stabilityGate) }; reconcileFolder(root: string, files: Map<string, { mtimeMs: number; sizeBytes: number }>) { return this.freshnessCoord.reconcileFolder(root, files) }
  async readNowDocument(idOrPath: number | string): Promise<{ ok: boolean; error?: string; empty?: boolean }> {
    if (!this.enabled || this.stopped) return { ok: false, error: 'paused' }
    const path = typeof idOrPath === 'number' ? this.store.retryDocument(idOrPath) : resolve(idOrPath)
    if (!path) return { ok: false, error: 'unavailable' }
    if (typeof idOrPath === 'string') this.remember(path)
    if (this.activeExtractions.has(path)) {
      this.deferred.delete(path); this.urgent.add(path); await this.waitUntilRead(path)
      if (this.store.documentByPath(path)?.error || this.store.documentByPath(path)?.status !== 'pending') return readOutcome(this.store.documentByPath(path))
    }
    const blocking = [...this.activeExtractions].filter((o) => !this.slicing.has(o) && weightOf(this.activeBytes.get(o) ?? 0) >= 3)
    for (const o of blocking) { this.invalidatePath(o); this.enqueue(o) }
    if (blocking.length) this.recycleWorker(INTERRUPTED_FOR_USER)
    for (let attempt = 0; attempt < READ_NOW_ATTEMPTS; attempt++) {
      this.invalidatePath(path); this.urgent.delete(path); this.deferred.delete(path); await this.readOnce(path)
      if (this.store.documentByPath(path)?.error || this.store.documentByPath(path)?.status !== 'pending') break
    }
    return readOutcome(this.store.documentByPath(path))
  }
  private async waitUntilRead(path: string): Promise<void> {
    const dl = Date.now() + this.workerTimeoutMs * 2; while (!this.stopped && Date.now() < dl && (this.activeExtractions.has(path) || this.queued.has(path))) await new Promise((r) => setTimeout(r, 20))
  }
  private async readOnce(path: string): Promise<void> {
    const generation = this.currentGeneration(path); const epoch = this.epoch
    this.activeGeneration.set(path, generation); this.activeExtractions.add(path); this.activeSince.set(path, Date.now()); this.pendingCount++
    try {
      const reply = await this.ask({ type: 'extract', path, interactive: true, maxPdfPages: this.extractionCoord.getPdfMaxPages() }, this.workerTimeoutMs, true)
      await this.applyExtractReply(path, reply, generation, epoch)
    } catch (error) {
      if (this.isCurrent(path, generation, epoch) && !(await this.sourceUnavailable(path))) {
        const msg = safeError(error); this.lastError = msg; await this.recordTransientSafe(path, msg, generation, epoch)
      }
    } finally {
      if (this.activeGeneration.get(path) === generation) this.activeGeneration.delete(path)
      this.activeExtractions.delete(path); this.activeSince.delete(path); this.pendingCount--
    }
  }
  private async recordTransientSafe(p: string, err: string, gen: number, ep: number): Promise<void> {
    const meta = await statMeta(p); if (!this.stopped && !this.budgetCoord.isWriteReady()) { try { this.ensureWorker() } catch { /* next poll retries */ } await this.budgetCoord.waitForWriteReady(Math.min(this.workerTimeoutMs, 10_000)) } // a stall recycle revokes write-ready; keep the failure instead of dropping it
    if (!this.stopped && this.budgetCoord.isWriteReady() && this.isCurrent(p, gen, ep)) this.store.recordTransientError(p, err, meta)
  }
  async triggerAnnSync(spaceId?: string) { const sp = spaceId ?? this.embeddingCoord.currentProfile.embeddingId; const meta = this.store.getAnnCanonicalMeta(sp); return AnnHostAdmissionCoordinator.dispatchAnnRebuild({ admission: this.admission, maintScheduler: this.maintScheduler, budgetCoord: this.budgetCoord, askWorker: (req, t) => this.ask(req, t, true), spaceId: sp, dimensions: this.embeddingCoord.currentProfile.dimensions, vectorCount: meta.canonicalCount, targetGeneration: meta.desiredGeneration, workerTimeoutMs: this.workerTimeoutMs, isStopped: () => this.stopped }) }
  currentGeneration(path: string): number { return this.pathGeneration.get(resolve(path)) ?? 0 }
  isCurrent(path: string, generation: number, epoch: number): boolean {
    if (this.stopped || !this.enabled || epoch !== this.epoch || generation !== this.currentGeneration(path)) return false
    const doc = this.store.documentByPath(path); return !!doc && doc.status !== 'excluded'
  }
  sourceUnavailable(path: string): Promise<boolean> { return this.freshnessCoord.sourceUnavailable(path) }; migrateLegacyDocument(doc: DocumentNeedingUpgrade): Promise<boolean> { if (!this.maintScheduler.canAcceptExpensiveWork()) return Promise.resolve(false); return this.legacyMigrator.migrate(doc, this.skippedMigrationDocs) }
  scheduleMigrationStep(delayMs = 1000): void {
    if (this.stopped || !this.enabled || isIndexingPaused()) return
    if (this.migrationTimer) clearTimeout(this.migrationTimer)
    this.migrationTimer = setTimeout(() => void this.runMigrationStep(), delayMs); this.migrationTimer.unref?.()
  }
  private async runMigrationStep(): Promise<void> {
    if (this.stopped || !this.enabled || isIndexingPaused()) return
    if (this.queue.length > 0 || this.activeExtractions.size > 0) { this.scheduleMigrationStep(1000); return }
    const needing = this.chunkUpgrade.getDocumentsNeedingUpgrade(1, this.skippedMigrationDocs)
    if (needing.length > 0) { await this.migrateLegacyDocument(needing[0]!); this.scheduleMigrationStep(500) }
  }
  close(): void { void this.closeAsync() }; closeAsync(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.stopped = true; this.stopJunkPurge?.(); this.statusAgg?.close(); this.stopPolicyWatch(); this.epoch++
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }; this.admissionRetry.dispose()
    if (this.migrationTimer) { clearTimeout(this.migrationTimer); this.migrationTimer = null }
    this.syncAdmissionCoord.close(); this.budgetCoord.close(); this.maintScheduler.dispose(); this.freshnessCoord.clearMissing(); this.embeddingCoord.clearQueue(); this.skippedMigrationDocs.clear(); this.admission.clear(); this.pendingIntake.close()
    this.queue.length = 0; this.queued.clear(); this.gate.clear(); this.urgent.clear(); this.deferred.clear()
    this.shutdownPromise = (async () => {
      try {
        await this.localOcrWiring?.dispose().catch(() => undefined); await this.host.terminate()
      } finally { this.store.close() }
    })()
    return this.shutdownPromise
  }
  private enqueue(path: string, prioritize = false, bytes?: number): void {
    if (this.stopped || !this.enabled) return; const p = resolve(path); if (this.activeGeneration.get(p) === this.currentGeneration(p)) return
    if (this.queued.has(p)) { if (prioritize) { const idx = this.queue.indexOf(p); if (idx > 0) { this.queue.splice(idx, 1); this.queue.unshift(p) } }; return }
    const doc = this.store.documentByPath(p); if (!doc || doc.status === 'excluded') return
    this.pathGeneration.set(p, this.currentGeneration(p) + 1); const size = bytes ?? doc.sizeBytes ?? undefined
    if (size !== undefined) this.activeBytes.set(p, size); this.queued.add(p); this.gate.queued(p, doc.status)
    if (prioritize) this.queue.unshift(p); else this.queue.push(p); void this.drain()
  }
  private takeNext(): string {
    const info = { urgent: this.urgent, deferred: this.deferred, bytes: this.activeBytes, prioritize: (p: string) => this.maintScheduler.isRecentUnderQuotaPressure(p) }
    const path = (nextInOrder(this.queue, info, this.gate.skip(this.urgent)) ?? nextInOrder(this.queue, info))!
    const idx = this.queue.indexOf(path); if (idx >= 0) this.queue.splice(idx, 1); this.urgent.delete(path); return path
  }
  private makeWayForLightFiles(path: string, generation: number): void {
    if (this.stopped || !this.enabled || !this.activeExtractions.has(path) || this.activeGeneration.get(path) !== generation) return
    if (this.queue.some((p) => !this.deferred.has(p) && weightOf(this.activeBytes.get(p) ?? 0) <= 2)) {
      this.deferred.add(path); this.invalidatePath(path); this.enqueue(path, false, this.activeBytes.get(path)); this.recycleWorker('Made way for lighter documents')
    }
  }
  /** Gives a taken path's active slot back; `requeue` puts it at the head again (the queue must not lose work to a refusal). */
  private releaseSlot(path: string, requeue = false, wasTextOnly = false): void {
    if (requeue) { this.queue.unshift(path); this.queued.add(path); if (wasTextOnly) this.gate.textOnly.add(path) }
    this.activeExtractions.delete(path); this.activeSince.delete(path); this.activeGeneration.delete(path); this.pendingCount--
  }
  private drain(): void {
    if (this.stopped || !this.enabled || isIndexingPaused()) return
    if (!this.budgetCoord.isWriteReady()) {
      if (this.queue.length > 0 || this.embeddingCoord.getQueueLength() > 0) { this.ensureWorker(); void this.budgetCoord.recover() }
      return
    }
    if (this.gate.parked > 0) for (const p of this.gate.release()) this.enqueue(p)
    if (this.extracting || this.embeddingCoord.isEmbedding()) return
    const lane = this.lanes.next(this.gate.extractable(this.queue.length, this.urgent), this.embeddingCoord.getQueueLength() > 0 && !this.embeddingCoord.isRetryPending())
    if (lane === 'extract') void this.drainExtractions(); else if (lane === 'embed') void this.runEmbedPass()
  }
  private async runEmbedPass(): Promise<void> {
    const startedAt = Date.now()
    try { await this.embeddingCoord.drainEmbeddings((req, timeout) => this.ask(req, timeout, true) as any, () => { this.progressTicks++ }, EMBED_SLICE_MS) } finally { this.lanes.add('embed', Date.now() - startedAt); if (!this.stopped && this.enabled) this.drain() }
  }
  private async drainExtractions(): Promise<void> {
    if (this.extracting || this.stopped) return
    this.extracting = true; let refused = false; const sliceStart = Date.now()
    try {
      while (!this.stopped && this.enabled && !isIndexingPaused() && this.budgetCoord.isWriteReady() && this.gate.extractable(this.queue.length, this.urgent)) {
        // vectors are waiting and this lane has had its share of the process for now: the other lane goes next
        if (Date.now() - sliceStart >= EXTRACT_SLICE_MS && this.embeddingCoord.getQueueLength() > 0 && !this.embeddingCoord.isRetryPending()) break
        const path = this.takeNext(); const wasTextOnly = this.gate.taken(path); this.queued.delete(path); this.activeExtractions.add(path)
        this.activeSince.set(path, Date.now()); const generation = this.currentGeneration(path)
        const epoch = this.epoch; this.activeGeneration.set(path, generation); this.pendingCount++
        if (!this.activeBytes.has(path)) { const doc = this.store.documentByPath(path); if (doc?.sizeBytes) this.activeBytes.set(path, doc.sizeBytes) }
        const existingDoc = this.store.documentByPath(path)
        if (existingDoc?.status === 'text-only' && !this.maintScheduler.canAcceptExpensiveWork()) {
          const meta = await statMeta(path)
          if (meta && existingDoc.mtimeMs === meta.mtimeMs && existingDoc.sizeBytes === meta.sizeBytes) {
            this.releaseSlot(path); this.admissionRetry.request(); continue
          }
        }
        if (!this.budgetCoord.isWriteReady()) { this.releaseSlot(path, true, wasTextOnly); break }
        const reserveId = `extract:${path}`; const extractToken = `drain:${path}:${Date.now()}:${Math.random().toString(36).slice(2)}`
        const estBytes = Math.max(32 * 1024, Math.min(this.activeBytes.get(path) ?? 64 * 1024, 2 * 1024 * 1024))
        const dec = await reserveExtractionLease({ admission: this.admission, maintScheduler: this.maintScheduler, reserveId, estBytes, extractToken, isAlive: () => !this.stopped, importance: this.store.getImportance(path)?.effective })
        if (!dec.admitted) {
          // Transient refusal: keep the file queued (quota refusals let lighter ones go first) and retry with backoff after a re-measure, not at the next poll.
          const unmeasured = dec.reason === 'accounting-unknown'; if (!unmeasured) this.deferred.add(path); this.releaseSlot(path, true, wasTextOnly); refused = true; this.admissionRetry.request(unmeasured); break
        }
        this.admissionRetry.succeeded()
        if (!this.budgetCoord.isWriteReady()) {
          const cur = this.admission.listReservations().find((r) => r.id === reserveId); if (cur && (!cur.ownerId || cur.ownerId === extractToken)) this.admission.release(reserveId)
          this.releaseSlot(path, true, wasTextOnly); break
        }
        const heavyWatch = setTimeout(() => this.makeWayForLightFiles(path, generation), this.autoDeferAfterMs)
        try {
          const sliceMs = /\.pdf$/i.test(path) && weightOf(this.activeBytes.get(path) ?? 0) >= 2 ? PDF_SLICE_MS : undefined
          if (sliceMs) this.slicing.add(path)
          const reply = await this.ask({ type: 'extract', path, maxPdfPages: this.extractionCoord.getPdfMaxPages(), ...(sliceMs ? { sliceMs } : {}) }, this.workerTimeoutMs, true)
          await this.applyExtractReply(path, reply, generation, epoch)
        } finally {
          const cur = this.admission.listReservations().find((r) => r.id === reserveId); if (cur && (!cur.ownerId || cur.ownerId === extractToken)) this.admission.release(reserveId)
          clearTimeout(heavyWatch); this.slicing.delete(path)
          if (!this.queued.has(path)) this.activeBytes.delete(path)
          if (this.activeGeneration.get(path) === generation) this.activeGeneration.delete(path)
          this.activeExtractions.delete(path); this.activeSince.delete(path); this.pendingCount--
        }
      }
    } finally {
      this.lanes.add('extract', Date.now() - sliceStart); this.extracting = false; if (!this.stopped && this.enabled && !refused) this.drain()
    }
  }
  private async applyExtractReply(path: string, reply: WorkerReply | null, generation: number, epoch: number): Promise<void> {
    if (!this.isCurrent(path, generation, epoch)) return
    if (reply && 'result' in reply && isPartialExtract(reply.result)) {
      this.readProgress.set(path, { done: reply.result.pagesDone, total: reply.result.totalPages })
      this.activeGeneration.delete(path); this.enqueue(path, false, this.activeBytes.get(path)); return
    }
    if (!reply || !('result' in reply) || !isExtractResult(reply.result)) {
      if ((await this.sourceUnavailable(path)) || this.stopped || !this.isCurrent(path, generation, epoch)) return
      const err = reply && 'error' in reply && typeof reply.error === 'string' ? reply.error : 'Document extraction timed out.'
      this.lastError = err; await this.recordTransientSafe(path, err, generation, epoch); return
    }
    const ext = reply.result; this.readProgress.delete(path); const prev = this.store.documentByPath(path); const lexicalOnly = !!ext.skipEmbeddings && ext.chunks.length > 0
    if (!(await this.freshnessCoord.handleExtractedFreshness(path, ext)) || !this.isCurrent(path, generation, epoch)) return
    const resumeOffset = !lexicalOnly && prev?.mtimeMs === ext.mtimeMs && prev?.sizeBytes === ext.sizeBytes ? this.store.resumeVectorOffset(path, ext.hash, this.embeddingCoord.currentProfile.embeddingId) : null
    if (resumeOffset === null) {
      const res = await writeExtractedContentSliced({
        store: this.store, admission: this.admission, maintScheduler: this.maintScheduler, budgetCoord: this.budgetCoord,
        dbDir: dirname(this.dbPath), path, ext, isCurrent: () => this.isCurrent(path, generation, epoch),
      })
      if (!res.written) {
        if (this.stopped || !this.isCurrent(path, generation, epoch)) return
        if (res.error) { this.lastError = res.error; if (res.reason === 'accounting-unknown') this.admissionRetry.request(); else if (!res.deferred) await this.recordTransientSafe(path, res.error, generation, epoch) } // an unmeasured quota is not the file's fault: it stays pending and is retried after a re-measure
        else if (res.deferred) this.admissionRetry.request()
        return
      }
      if (!this.stopped) { this.extractionCoord.recordScanInfo(path, ext as any); this.maintScheduler.scheduleFtsMaintenance() }
    }
    this.lastError = undefined; this.progressTicks++
    if (ext.chunks.length && !lexicalOnly && this.maintScheduler.canAcceptExpensiveWork()) {
      // The text is stored and searchable by now. A full vector line must not hold up reading the files behind this one: the file
      // keeps its place in the database as text-only and re-enters the line, to be read once more, when the vector line has room.
      if (this.gate.room()) { this.embeddingCoord.enqueueEmbed({ path, generation, epoch, hash: ext.hash, mtimeMs: ext.mtimeMs, sizeBytes: ext.sizeBytes, chunks: ext.chunks, startOffset: resumeOffset ?? 0 }); this.drain() }
      else this.gate.park(path)
    }
  }
  private invalidatePath(path: string): void {
    this.pathGeneration.set(path, this.currentGeneration(path) + 1); this.queued.delete(path); this.activeBytes.delete(path); this.gate.forget(path)
    const idx = this.queue.indexOf(path); if (idx >= 0) this.queue.splice(idx, 1)
    this.embeddingCoord.removePath(path)
  }
  private polling = false
  private async poll(): Promise<void> {
    if (this.stopped || !this.enabled || isIndexingPaused() || this.polling) return
    this.polling = true
    // Every incomplete file is offered on every poll, however many wait: a path that fell out of the in-memory line (a refusal, a restarted worker, a changed file) only comes back through here.
    try { await enqueueIncompletePaged({ readPage: (after, limit) => this.store.incompletePathsPage(after, limit), isBusy: (p) => this.queued.has(p) || this.gate.isParked(p) || this.activeExtractions.has(p) || this.embeddingCoord.isEmbeddingPath(p) || this.embeddingCoord.embedsQueue.some((j) => j.path === p), enqueue: (p) => this.enqueue(p), isStopped: () => this.stopped || !this.enabled }) } finally { this.polling = false }
    this.skippedMigrationDocs.clear(); this.scheduleMigrationStep(1000); this.drain(); const probe = this.probe(); if (!this.stopped && this.enabled) this.watchdog.observe(this.progressTicks, probe, probe.pausedBy, blockedReasonOf(probe))
  }
  private probe(): QueueProbe {
    const since = this.activeSince.values().next().value as number | undefined; const embedQ = this.embeddingCoord.getQueueLength()
    return { waiting: this.queue.length + embedQ + this.gate.parked, line: this.queue.length, textOnlyInLine: this.gate.textOnly.size, vectorLine: embedQ, vectorWait: this.gate.parked, extracting: this.extracting, extractingForSeconds: since === undefined ? 0 : Math.round((Date.now() - since) / 1000), inFlightAsks: this.host.inFlight, embedding: this.embeddingCoord.isEmbedding(), extractable: this.gate.extractable(this.queue.length, this.urgent), writeReady: this.budgetCoord.isWriteReady(), accountingOk: this.maintScheduler.canAcceptExpensiveWork(), admissionRetryArmed: this.admissionRetry.isArmed(), vectorRetryPending: this.embeddingCoord.isRetryPending(), model: this.modelState, workerUp: this.host.isUp, lastError: this.lastError, pausedBy: isIndexingPaused() ? (currentIndexingPolicy()?.pauseReason ?? 'unknown') : undefined }
  }
  /** Why files wait while nothing runs (see queue-health.ts); the Index screen shows it. */
  private blockedReason(): IndexingBlockReason | undefined { return this.stopped || !this.enabled ? undefined : blockedReasonOf(this.probe()) }
  private releaseWorkerReservations(): void {
    for (const r of this.admission.listReservations()) if (r.id.startsWith('extract:') || r.id.startsWith('embed:') || r.id.startsWith('ocr:') || r.id.startsWith('worker:') || r.id.startsWith('ann:')) this.admission.release(r.id)
  }
  private recycleWorker(reason: string): void { this.host.recycle(reason) }
  private ask(request: WorkerRequest, timeoutMs?: number, recycleOnTimeout = false): Promise<WorkerReply | null> { return this.host.ask(request, timeoutMs, recycleOnTimeout) }
  private ensureWorker(): Worker { return this.host.ensure() }
}
