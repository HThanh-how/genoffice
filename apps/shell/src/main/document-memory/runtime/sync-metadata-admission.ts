import type { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import {
  StorageAdmissionController,
  safeReleaseExactOwnerReservation,
  DEFAULT_RESERVATION_TTL_MS,
} from './storage-admission'
import {
  CACHE_RETENTION_HIGH_WATERMARK,
  hardCapBytes,
  type DocumentIndexStorageBudget,
  type StorageBudgetSnapshot,
} from '../storage-budget'
import {
  BASE_PROJECTION_METADATA_BYTES,
  setDbProjectionSyncGuard,
  clearDbProjectionSyncGuard,
  type NameProjectionSyncGuard,
} from '../name-search-projection'
import { getValidatedFreeDiskBytes } from './content-write-budget'

export type SyncMetadataRejectionReason =
  | 'ok'
  | 'budget-full'
  | 'disk-space-insufficient'
  | 'accounting-unknown'
  | 'not-ready'
  | 'stopped'
  | 'min-metadata-unfit'
  | 'reservation-exceeded'

export interface SyncMetadataAdmissionDecision {
  admitted: boolean
  reason: SyncMetadataRejectionReason
  estimatedBytes: number
  error?: string
  reservationId?: string
  ownerToken?: string
}

export interface SyncMetadataGuard extends NameProjectionSyncGuard {
  /**
   * `lowPriority` (images/videos) is admitted only below the cache-retention high watermark (90% of the soft
   * quota), so media can never push the index into compaction of document content nor into the grace zone;
   * documents are admitted up to the hard cap.
   */
  canAdmitNewDocument(
    doc: { name: string; path: string; lowPriority?: boolean },
    estimatedBytes: number,
  ): SyncMetadataAdmissionDecision
  settleCommit(reservationId: string, ownerToken?: string): void
  rollbackCommit(reservationId: string, ownerToken?: string): void
  isReady(): boolean
  getLastRejectionReason(): string | undefined
  close(): void
}

export interface SyncMetadataAdmissionCoordinatorOptions {
  admission: StorageAdmissionController
  getStorageBudget: () => DocumentIndexStorageBudget
  isWriteReady: () => boolean
  refreshAccountingAsync: () => Promise<StorageBudgetSnapshot | null>
  getStorageBudgetSnapshot?: () => StorageBudgetSnapshot | null | undefined
  getFreeDiskBytes?: () => Promise<number | null>
  isStopped?: () => boolean
  dbPath?: string
  maxInflightReservations?: number
  freeDiskHeadroomBytes?: number
  freeDiskTtlMs?: number
  /**
   * Called (fire and forget, never throws into the guard) when a new document is refused because the HARD cap has no
   * room for it. The owner may free space (admission by displacement) and replay the parked intake afterwards.
   * `neededBytes` is the exact shortfall.
   */
  onQuotaPressure?: (info: { neededBytes: number; reason: SyncMetadataRejectionReason; doc?: { name: string; path: string } }) => void
}

interface ActiveOwnedReservation {
  ownerToken: string
  bytes: number
  timestamp: number
}

export class SyncMetadataAdmissionCoordinator implements SyncMetadataGuard {
  private readonly admission: StorageAdmissionController
  private readonly getStorageBudget: () => DocumentIndexStorageBudget
  private readonly isWriteReadyOption: () => boolean
  private readonly refreshAccountingAsyncOption: () => Promise<StorageBudgetSnapshot | null>
  private readonly getStorageBudgetSnapshotOption?: () => StorageBudgetSnapshot | null | undefined
  private readonly getFreeDiskBytesOption?: () => Promise<number | null>
  private readonly isStoppedOption?: () => boolean
  private readonly dbPath?: string
  private readonly maxInflight: number
  private readonly headroomBytes: number
  private readonly freeDiskTtlMs: number
  private readonly onQuotaPressureOption?: (info: { neededBytes: number; reason: SyncMetadataRejectionReason; doc?: { name: string; path: string } }) => void

  private stopped = false
  private lastRejectionReason: string | undefined
  private readonly activeOwned = new Map<string, ActiveOwnedReservation>()
  private readonly committedReservations = new Map<string, string>() // reservationId -> ownerToken
  private cachedFreeDisk: { bytes: number; timestamp: number } | null = null
  private freeDiskRefreshing = false
  private refreshInFlight = false
  private refreshScheduled = false
  private retryCount = 0
  private lastAccountingFailed = false
  private static readonly MAX_SETTLE_RETRIES = 3
  private accountingRefreshTimer: NodeJS.Timeout | null = null

  constructor(options: SyncMetadataAdmissionCoordinatorOptions) {
    this.admission = options.admission
    this.getStorageBudget = options.getStorageBudget
    this.isWriteReadyOption = options.isWriteReady
    this.refreshAccountingAsyncOption = options.refreshAccountingAsync
    this.getStorageBudgetSnapshotOption = options.getStorageBudgetSnapshot
    this.getFreeDiskBytesOption = options.getFreeDiskBytes
    this.isStoppedOption = options.isStopped
    this.dbPath = options.dbPath
    this.maxInflight = options.maxInflightReservations ?? 500
    this.headroomBytes = options.freeDiskHeadroomBytes ?? 10 * 1024 * 1024
    this.freeDiskTtlMs = options.freeDiskTtlMs ?? 10_000
    this.onQuotaPressureOption = options.onQuotaPressure

    // Eagerly warm up free disk cache off-main without blocking
    this.triggerFreeDiskRefreshIfNeeded()
  }

  isReady(): boolean {
    if (this.stopped || (this.isStoppedOption && this.isStoppedOption())) return false
    if (!this.isWriteReadyOption()) return false
    if (this.lastAccountingFailed) return false
    const snap = this.getStorageBudgetSnapshotOption?.()
    if (!snap || snap.isDegraded || (snap.measurementStatus && snap.measurementStatus !== 'fresh')) return false
    return true
  }

  getLastRejectionReason(): string | undefined {
    return this.lastRejectionReason
  }

  private notifyQuotaPressure(neededBytes: number, reason: SyncMetadataRejectionReason, doc?: { name: string; path: string }): void {
    // low-priority rows (images / videos) are deliberately admitted only below 90%: they never displace content
    if (!this.onQuotaPressureOption || this.stopped || (doc as { lowPriority?: boolean } | undefined)?.lowPriority) return
    try {
      this.onQuotaPressureOption({ neededBytes: Math.max(1, Math.ceil(neededBytes)), reason, ...(doc ? { doc } : {}) })
    } catch {
      // displacement is an optimisation of admission; the refusal below stands either way
    }
  }

  canWriteProjection(
    doc: { id: number; name: string; path: string },
    estimatedBytes: number,
  ): boolean {
    if (this.stopped || (this.isStoppedOption && this.isStoppedOption())) return false
    if (!this.isWriteReadyOption()) return false

    const resId = `meta:${doc.path}`
    const owned = this.activeOwned.get(resId)
    if (owned) {
      // Recheck stopped/enabled/write-ready/live budget/accounting and exact central lease owner
      const budget = this.getStorageBudget()
      if (!Number.isFinite(budget.maxDatabaseBytes) || budget.maxDatabaseBytes <= 0) return false
      const snap = this.getStorageBudgetSnapshotOption?.()
      if (!snap || snap.isDegraded || (snap.measurementStatus && snap.measurementStatus !== 'fresh') || snap.limitState === 'full') {
        return false
      }
      // Grace zone: the lease was admitted against the hard cap; a hard stop reached since then refuses
      if ((snap.totalManagedBytes ?? snap.databaseBytes) >= hardCapBytes(budget)) return false
      // Recheck exact central lease owner in admission controller
      const central = this.admission.listReservations().find((r) => r.id === resId)
      if (!central || central.ownerId !== owned.ownerToken) {
        this.activeOwned.delete(resId)
        this.committedReservations.delete(resId)
        return false
      }
      return true
    }

    // Not pre-reserved: check capacity without creating an untracked/unsettled lease
    if (this.lastAccountingFailed) return false
    const budget = this.getStorageBudget()
    if (!Number.isFinite(budget.maxDatabaseBytes) || budget.maxDatabaseBytes <= 0) return false
    const snap = this.getStorageBudgetSnapshotOption?.()
    if (!snap || snap.isDegraded || (snap.measurementStatus && snap.measurementStatus !== 'fresh') || snap.limitState === 'full') {
      return false
    }
    const currentUsage = (snap.totalManagedBytes ?? snap.databaseBytes)
    if (!Number.isFinite(currentUsage) || currentUsage < 0) return false
    const reservedBytes = this.admission.getReservedBytes()
    // Grace zone: projection updates are admitted up to the HARD cap (soft quota + overshoot), never beyond
    const capBytes = hardCapBytes(budget)
    if (currentUsage + reservedBytes + estimatedBytes > capBytes) return false
    const headroom = capBytes - (currentUsage + reservedBytes)
    if (headroom < BASE_PROJECTION_METADATA_BYTES || headroom < estimatedBytes) return false

    const now = Date.now()
    if (
      !this.cachedFreeDisk ||
      !Number.isFinite(this.cachedFreeDisk.bytes) ||
      this.cachedFreeDisk.bytes <= 0 ||
      (now - this.cachedFreeDisk.timestamp) > this.freeDiskTtlMs
    ) {
      this.triggerFreeDiskRefreshIfNeeded()
      return false
    }
    if (this.cachedFreeDisk.bytes < this.headroomBytes + reservedBytes + estimatedBytes) return false
    return true
  }

  canAdmitNewDocument(
    doc: { name: string; path: string; lowPriority?: boolean },
    estimatedBytes: number,
  ): SyncMetadataAdmissionDecision {
    if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes <= 0) {
      this.lastRejectionReason = 'Invalid estimatedBytes: must be a positive safe integer'
      return { admitted: false, reason: 'min-metadata-unfit', estimatedBytes, error: this.lastRejectionReason }
    }

    if (this.stopped || (this.isStoppedOption && this.isStoppedOption())) {
      this.lastRejectionReason = 'Document memory manager is stopped or paused'
      return { admitted: false, reason: 'stopped', estimatedBytes, error: this.lastRejectionReason }
    }

    if (!this.isWriteReadyOption()) {
      this.lastRejectionReason = 'Write budget coordinator not ready or awaiting initial handshake'
      return { admitted: false, reason: 'not-ready', estimatedBytes, error: this.lastRejectionReason }
    }

    // maxInflight counts all owned entries, not only committed
    if (this.activeOwned.size >= this.maxInflight) {
      this.lastRejectionReason = `Inflight sync metadata reservations bounded limit reached (${this.activeOwned.size}/${this.maxInflight})`
      return { admitted: false, reason: 'reservation-exceeded', estimatedBytes, error: this.lastRejectionReason }
    }

    if (this.lastAccountingFailed) {
      this.lastRejectionReason = 'Storage accounting measurement failed or is unverified'
      return { admitted: false, reason: 'accounting-unknown', estimatedBytes, error: this.lastRejectionReason }
    }

    const budget = this.getStorageBudget()
    if (!Number.isFinite(budget.maxDatabaseBytes) || budget.maxDatabaseBytes <= 0) {
      this.lastRejectionReason = 'Live storage budget is zero or invalid'
      return { admitted: false, reason: 'budget-full', estimatedBytes, error: this.lastRejectionReason }
    }

    // Snapshot fresh / non-degraded; missing snapshot must not count as usage 0
    const snap = this.getStorageBudgetSnapshotOption?.()
    if (!snap) {
      this.lastRejectionReason = 'Storage accounting snapshot missing or uninitialized'
      return { admitted: false, reason: 'accounting-unknown', estimatedBytes, error: this.lastRejectionReason }
    }

    if (snap.isDegraded || (snap.measurementStatus && snap.measurementStatus !== 'fresh')) {
      this.lastRejectionReason = 'Storage accounting measurement is degraded, stale, or unverified'
      return { admitted: false, reason: 'accounting-unknown', estimatedBytes, error: this.lastRejectionReason }
    }

    if (snap.limitState === 'full') {
      this.lastRejectionReason = 'Storage limit state is full'
      const usedAtStop = snap.totalManagedBytes ?? snap.databaseBytes
      this.notifyQuotaPressure(usedAtStop + this.admission.getReservedBytes() + estimatedBytes - hardCapBytes(budget), 'budget-full', doc)
      return { admitted: false, reason: 'budget-full', estimatedBytes, error: this.lastRejectionReason }
    }

    const currentUsage = (snap.totalManagedBytes ?? snap.databaseBytes)
    if (!Number.isFinite(currentUsage) || currentUsage < 0) {
      this.lastRejectionReason = 'Storage usage measurement invalid'
      return { admitted: false, reason: 'accounting-unknown', estimatedBytes, error: this.lastRejectionReason }
    }

    // Grace zone: soft quota <= usage < hard cap still admits the lightweight name/identity row (every new file
    // stays findable); the projection and the reservation are checked against the HARD cap, never the soft quota.
    const maxDbBytes = doc.lowPriority
      ? Math.floor(budget.maxDatabaseBytes * CACHE_RETENTION_HIGH_WATERMARK)
      : hardCapBytes(budget)
    if (currentUsage >= maxDbBytes) {
      this.lastRejectionReason = 'Storage limit state is full'
      this.notifyQuotaPressure(currentUsage + this.admission.getReservedBytes() + estimatedBytes - maxDbBytes, 'budget-full', doc)
      return { admitted: false, reason: 'budget-full', estimatedBytes, error: this.lastRejectionReason }
    }

    const reservedBytes = this.admission.getReservedBytes()
    const prospectiveTotal = currentUsage + reservedBytes + estimatedBytes

    if (prospectiveTotal > maxDbBytes) {
      this.lastRejectionReason = `Storage budget full: projected ${prospectiveTotal} exceeds hard cap ${maxDbBytes}`
      this.notifyQuotaPressure(prospectiveTotal - maxDbBytes, 'budget-full', doc)
      return { admitted: false, reason: 'budget-full', estimatedBytes, error: this.lastRejectionReason }
    }

    const availableHeadroom = maxDbBytes - (currentUsage + reservedBytes)
    if (availableHeadroom < BASE_PROJECTION_METADATA_BYTES || availableHeadroom < estimatedBytes) {
      this.lastRejectionReason = `Minimum metadata unable to fit: available ${availableHeadroom} < required ${Math.max(BASE_PROJECTION_METADATA_BYTES, estimatedBytes)}`
      this.notifyQuotaPressure(Math.max(BASE_PROJECTION_METADATA_BYTES, estimatedBytes) - availableHeadroom, 'min-metadata-unfit', doc)
      return { admitted: false, reason: 'min-metadata-unfit', estimatedBytes, error: this.lastRejectionReason }
    }

    // Cached free disk TTL: trigger refresh but old cache must not be accepted when expired
    this.triggerFreeDiskRefreshIfNeeded()
    const now = Date.now()
    const isDiskStaleOrMissing =
      !this.cachedFreeDisk ||
      !Number.isFinite(this.cachedFreeDisk.bytes) ||
      this.cachedFreeDisk.bytes <= 0 ||
      (now - this.cachedFreeDisk.timestamp) > this.freeDiskTtlMs

    if (isDiskStaleOrMissing || !this.cachedFreeDisk) {
      this.lastRejectionReason = 'Free disk space measurement unknown, stale or pending async verification'
      return { admitted: false, reason: 'disk-space-insufficient', estimatedBytes, error: this.lastRejectionReason }
    }

    // Compare disk headroom against cumulative reserved bytes + proposed bytes, not only one write
    const requiredDiskBytes = this.headroomBytes + reservedBytes + estimatedBytes
    if (this.cachedFreeDisk.bytes < requiredDiskBytes) {
      this.lastRejectionReason = `Insufficient free disk space: available ${this.cachedFreeDisk.bytes} < required ${requiredDiskBytes} (headroom ${this.headroomBytes} + reserved ${reservedBytes} + proposed ${estimatedBytes})`
      return { admitted: false, reason: 'disk-space-insufficient', estimatedBytes, error: this.lastRejectionReason }
    }

    const reservationId = `meta:${doc.path}`
    const ownerToken = `meta_owner:${Date.now()}:${Math.random().toString(36).slice(2)}`

    const decision = this.admission.reserve(
      reservationId,
      'lexical',
      estimatedBytes,
      currentUsage,
      maxDbBytes,
      DEFAULT_RESERVATION_TTL_MS,
      {
        ownerId: ownerToken,
        holdUntilJobEnds: true,
        accountingDegraded: snap.isDegraded,
        freeDiskBytes: this.cachedFreeDisk.bytes,
        headroomBytes: this.headroomBytes,
      },
    )

    if (!decision.admitted) {
      this.lastRejectionReason = decision.error ?? decision.reason
      if (decision.reason === 'quota-exhausted' || decision.reason === 'hard-limit-exceeded') {
        this.notifyQuotaPressure(decision.projectedBytes - decision.budgetBytes, 'budget-full', doc)
      }
      return {
        admitted: false,
        reason: (decision.reason as SyncMetadataRejectionReason) ?? 'budget-full',
        estimatedBytes,
        error: this.lastRejectionReason,
      }
    }

    this.activeOwned.set(reservationId, {
      ownerToken,
      bytes: estimatedBytes,
      timestamp: Date.now(),
    })
    this.lastRejectionReason = undefined

    return {
      admitted: true,
      reason: 'ok',
      reservationId,
      ownerToken,
      estimatedBytes,
    }
  }

  settleCommit(reservationId: string, ownerToken?: string): void {
    if (!reservationId || !ownerToken) return
    const owned = this.activeOwned.get(reservationId)
    // Exact token required for settle; mismatch must leave actual entry/debt untouched
    if (!owned || owned.ownerToken !== ownerToken) return

    if (this.stopped || (this.isStoppedOption && this.isStoppedOption())) {
      safeReleaseExactOwnerReservation(this.admission, reservationId, ownerToken)
      this.activeOwned.delete(reservationId)
      this.committedReservations.delete(reservationId)
      return
    }

    this.committedReservations.set(reservationId, ownerToken)
    this.scheduleAccountingRefresh()
  }

  rollbackCommit(reservationId: string, ownerToken?: string): void {
    if (!reservationId || !ownerToken) return
    const owned = this.activeOwned.get(reservationId)
    // Exact token required for rollback; mismatch must leave actual entry/debt untouched. No unowned release.
    if (!owned || owned.ownerToken !== ownerToken) return

    safeReleaseExactOwnerReservation(this.admission, reservationId, ownerToken)
    this.activeOwned.delete(reservationId)
    this.committedReservations.delete(reservationId)
  }

  close(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.accountingRefreshTimer) {
      clearTimeout(this.accountingRefreshTimer)
      this.accountingRefreshTimer = null
    }
    this.refreshScheduled = false
    this.refreshInFlight = false
    for (const [resId, r] of this.activeOwned) {
      safeReleaseExactOwnerReservation(this.admission, resId, r.ownerToken)
    }
    this.activeOwned.clear()
    this.committedReservations.clear()
  }

  private scheduleAccountingRefresh(): void {
    if (this.stopped || (this.isStoppedOption && this.isStoppedOption())) return
    if (this.refreshScheduled) return
    if (this.refreshInFlight) {
      this.refreshScheduled = true
      return
    }
    this.refreshScheduled = true
    if (this.accountingRefreshTimer) {
      clearTimeout(this.accountingRefreshTimer)
    }
    this.accountingRefreshTimer = setTimeout(() => {
      this.accountingRefreshTimer = null
      this.refreshScheduled = false
      void this.runAccountingSettle()
    }, 50)
    this.accountingRefreshTimer.unref?.()
  }

  private async runAccountingSettle(): Promise<void> {
    if (this.stopped || (this.isStoppedOption && this.isStoppedOption())) return
    if (this.refreshInFlight) return
    if (this.committedReservations.size === 0) {
      this.retryCount = 0
      return
    }

    this.refreshInFlight = true
    // Capture exact reservation IDs AND owner tokens committed before measurement starts
    const snapshotToSettle = new Map(this.committedReservations)

    let snap: StorageBudgetSnapshot | null
    try {
      snap = await this.refreshAccountingAsyncOption()
    } catch {
      snap = null
    }

    // Callbacks after close must not restart timers or alter new owners
    if (this.stopped || (this.isStoppedOption && this.isStoppedOption())) {
      this.refreshInFlight = false
      return
    }

    const isFreshAndHealthy = Boolean(
      snap &&
      !snap.isDegraded &&
      snap.measurementStatus === 'fresh',
    )

    if (isFreshAndHealthy) {
      this.lastAccountingFailed = false
      this.retryCount = 0
      // Commits during the measurement request another turn, not another timer.
      this.refreshScheduled = false
      // Release only those exact reservation IDs and owner tokens covered by the measurement snapshot
      for (const [resId, token] of snapshotToSettle) {
        const cur = this.activeOwned.get(resId)
        if (cur && cur.ownerToken === token) {
          safeReleaseExactOwnerReservation(this.admission, resId, token)
          this.activeOwned.delete(resId)
        }
        if (this.committedReservations.get(resId) === token) this.committedReservations.delete(resId)
      }
    } else {
      // Unknown/failure retain debt, fail-close subsequent admission, bounded retry (not infinite timers)
      this.lastAccountingFailed = true
      if (this.retryCount < SyncMetadataAdmissionCoordinator.MAX_SETTLE_RETRIES) {
        this.retryCount++
        this.refreshScheduled = true
        const backoffMs = 50 * Math.pow(2, this.retryCount)
        this.accountingRefreshTimer = setTimeout(() => {
          this.accountingRefreshTimer = null
          this.refreshScheduled = false
          void this.runAccountingSettle()
        }, backoffMs)
        this.accountingRefreshTimer.unref?.()
      } else {
        // Bounded retries exhausted; retain debt until next external refresh or commit without infinite timer
        this.refreshScheduled = false
      }
    }

    this.refreshInFlight = false

    // On later successful fresh measurement release only covered snapshot, queue subsequent debt safely
    if (isFreshAndHealthy && this.committedReservations.size > 0 && !this.refreshScheduled && !this.stopped) {
      this.scheduleAccountingRefresh()
    }
  }

  private triggerFreeDiskRefreshIfNeeded(): void {
    if (this.stopped || (this.isStoppedOption && this.isStoppedOption()) || this.freeDiskRefreshing) return
    const now = Date.now()
    if (this.cachedFreeDisk && now - this.cachedFreeDisk.timestamp < this.freeDiskTtlMs) {
      return
    }
    this.freeDiskRefreshing = true
    const getter = this.getFreeDiskBytesOption ?? (() => {
      const dir = this.dbPath ? dirname(this.dbPath) : process.cwd()
      return getValidatedFreeDiskBytes(dir)
    })
    getter()
      .then((bytes) => {
        if (this.stopped || (this.isStoppedOption && this.isStoppedOption())) return
        this.freeDiskRefreshing = false
        if (bytes !== null && Number.isFinite(bytes) && bytes >= 0) {
          this.cachedFreeDisk = { bytes, timestamp: Date.now() }
        } else {
          this.cachedFreeDisk = null
        }
      })
      .catch(() => {
        if (this.stopped || (this.isStoppedOption && this.isStoppedOption())) return
        this.freeDiskRefreshing = false
        this.cachedFreeDisk = null
      })
  }
}

export class StandaloneSyncMetadataGuard implements SyncMetadataGuard {
  constructor(private readonly policy: 'allow' | 'deny' = 'allow') {}

  canWriteProjection(): boolean {
    return this.policy !== 'deny'
  }

  canAdmitNewDocument(
    doc: { name: string; path: string },
    estimatedBytes: number,
  ): SyncMetadataAdmissionDecision {
    void doc
    if (this.policy === 'deny') {
      return {
        admitted: false,
        reason: 'budget-full',
        estimatedBytes,
        error: 'Admission denied by explicit standalone policy',
      }
    }
    return {
      admitted: true,
      reason: 'ok',
      estimatedBytes,
    }
  }

  settleCommit(): void {}
  rollbackCommit(): void {}
  isReady(): boolean {
    return this.policy !== 'deny'
  }
  getLastRejectionReason(): string | undefined {
    return this.policy === 'deny' ? 'Admission denied by explicit standalone policy' : undefined
  }
  close(): void {}
}

export function wireSyncMetadataAdmission(db: DatabaseSync, guard: SyncMetadataGuard): void {
  setDbProjectionSyncGuard(db, guard)
}

export function unwireSyncMetadataAdmission(db: DatabaseSync): void {
  clearDbProjectionSyncGuard(db)
}
