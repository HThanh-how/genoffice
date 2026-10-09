import {
  ensureStorageSettings,
  writeStorageSettings,
  validateStorageBudgetBytes,
  validateStorageBudgetVersion,
  deriveStoragePreset,
  STORAGE_PRESET_BYTES,
  type StorageBudgetConfig,
  type StorageBudgetPreset,
  type StorageBudgetStatus,
  type StorageBudgetPersistedSettings,
} from '../storage/storage-settings'
import {
  createStorageBudget,
  normalizeOvershootRatio,
  type DocumentIndexStorageBudget,
} from '../storage-budget'
import type {
  WorkerRequest,
  WorkerReply,
  StorageBudgetWorkerResult,
} from '../worker-types'

/**
 * The worker must have applied the same grace-zone overshoot as main (a missing echo means the default), otherwise
 * main would admit growth up to a hard cap the worker's own guards refuse (or the reverse).
 */
function overshootAckMatches(res: StorageBudgetWorkerResult, budget: DocumentIndexStorageBudget): boolean {
  return normalizeOvershootRatio(res.appliedOvershootRatio) === normalizeOvershootRatio(budget.overshootRatio)
}

export interface StorageBudgetCoordinatorOptions {
  settingsDir: string
  getMaintBudget: () => DocumentIndexStorageBudget
  setMaintBudget: (budget: DocumentIndexStorageBudget) => void
  askWorker: (request: WorkerRequest, timeoutMs?: number) => Promise<WorkerReply | null>
  isStopped: () => boolean
  workerTimeoutMs?: number
  onWriteReady?: () => void
  onHandshakeFailure?: (error: string) => void
}

/**
 * Coordinates persistent storage budget preferences with live worker runtime state.
 * Enforces monotonic version ACK protocol, immediate effective safe budget during quota reductions,
 * bounded retry recovery with live workers, and blocks writes/dispatches during startup, restart,
 * and pending configuration updates.
 */
export class StorageBudgetCoordinator {
  private desiredConfig: StorageBudgetPersistedSettings
  private appliedVersion: number | null = null
  private status: StorageBudgetStatus = 'pending'
  private error: string | undefined = undefined
  private appliedBudgetBytes: number | null = null
  private workerEpoch = 0
  private disposed = false
  private updateMutex: Promise<any> = Promise.resolve()
  private readonly writeReadyListeners = new Set<(ready: boolean) => void>()
  private retryTimer: NodeJS.Timeout | null = null
  private retryAttempts = 0
  private static readonly MAX_HANDSHAKE_RETRIES = 3
  private syncInProgress = false

  constructor(private readonly options: StorageBudgetCoordinatorOptions) {
    const loaded = ensureStorageSettings(this.options.settingsDir)
    this.desiredConfig = {
      maxDatabaseBytes: loaded.maxDatabaseBytes,
      preset: loaded.preset,
      version: loaded.version,
      lastSavedAt: loaded.lastSavedAt,
    }
    // Startup appliedVersion is explicitly null and status is 'pending'
    this.appliedVersion = null
    this.status = 'pending'
    this.error = undefined
    this.appliedBudgetBytes = null
  }

  /**
   * Returns unified storage budget configuration combining persisted desired settings
   * and live runtime ACK state.
   */
  getConfig(): StorageBudgetConfig {
    return {
      maxDatabaseBytes: this.desiredConfig.maxDatabaseBytes,
      preset: this.desiredConfig.preset,
      version: this.desiredConfig.version,
      appliedVersion: this.appliedVersion,
      status: this.status,
      error: this.error,
      appliedBudgetBytes: this.appliedBudgetBytes,
      lastSavedAt: this.desiredConfig.lastSavedAt,
    }
  }

  getStatus(): StorageBudgetStatus {
    return this.status
  }

  /**
   * Write gating check: True only when worker has verified and ACKed the exact desired version.
   */
  isWriteReady(): boolean {
    return (
      !this.disposed &&
      !this.options.isStopped() &&
      this.status === 'applied' &&
      typeof this.appliedVersion === 'number' &&
      this.appliedVersion === this.desiredConfig.version
    )
  }

  /**
   * Register a callback to be notified when write readiness changes.
   */
  onWriteReadyChange(listener: (ready: boolean) => void): () => void {
    this.writeReadyListeners.add(listener)
    return () => this.writeReadyListeners.delete(listener)
  }

  private notifyWriteReady(ready: boolean): void {
    for (const listener of this.writeReadyListeners) {
      try {
        listener(ready)
      } catch {
        // Non-blocking
      }
    }
    if (ready && this.options.onWriteReady && !this.disposed && !this.options.isStopped()) {
      try {
        this.options.onWriteReady()
      } catch {
        // Non-blocking
      }
    }
  }

  /**
   * Called when a worker process is newly spawned or restarted.
   * Self-increments workerEpoch monotonically (never resets to manager's epoch).
   * Resets runtime applied state, keeps writes blocked, and dispatches startup handshake.
   */
  async onWorkerSpawned(_managerEpoch?: number): Promise<boolean> {
    if (this.disposed || this.options.isStopped()) return false
    this.cancelRetry()
    const targetEpoch = ++this.workerEpoch
    this.appliedVersion = null
    this.status = 'pending'
    this.appliedBudgetBytes = null
    this.retryAttempts = 0
    this.notifyWriteReady(false)
    return this.syncWorkerBudget(targetEpoch)
  }

  /**
   * Called when worker is recycled or exits unexpectedly.
   * Increments worker generation, cancels retries, invalidates runtime applied state.
   */
  onWorkerRecycled(reason: string): void {
    this.cancelRetry()
    this.workerEpoch++
    this.appliedVersion = null
    this.status = 'pending'
    this.error = reason
    this.appliedBudgetBytes = null
    this.retryAttempts = 0
    this.notifyWriteReady(false)
  }

  /** Resolves true once the exact-version ACK has reopened writes; false on timeout or shutdown. */
  async waitForWriteReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (!this.isWriteReady()) {
      if (this.disposed || this.options.isStopped() || Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return true
  }

  /**
   * Recovers handshake when worker is still alive but handshake previously failed or timed out.
   * Cancels any pending backoff timer, resets retry counter, and triggers an immediate handshake.
   */
  async recover(): Promise<boolean> {
    if (this.disposed || this.options.isStopped() || this.isWriteReady() || this.syncInProgress) {
      return false
    }
    // Automatic polling must respect backoff and must not reset the retry budget.
    if (this.retryTimer || this.retryAttempts >= StorageBudgetCoordinator.MAX_HANDSHAKE_RETRIES) return false
    return this.syncWorkerBudget(this.workerEpoch)
  }

  /**
   * Executes startup/restart configuration handshake with the current worker generation.
   */
  private async syncWorkerBudget(targetEpoch: number): Promise<boolean> {
    if (this.disposed || this.options.isStopped() || this.workerEpoch !== targetEpoch) {
      return false
    }
    if (this.syncInProgress) {
      return false
    }
    this.syncInProgress = true

    const desired = this.desiredConfig
    const version = desired.version
    const fullBudget = createStorageBudget(desired.maxDatabaseBytes)
    fullBudget.version = version

    // Immediate safe budget backpressure: if not yet acknowledged, safe budget is min(desired, applied ?? desired)
    const safeBytes = Math.min(
      desired.maxDatabaseBytes,
      this.appliedBudgetBytes ?? desired.maxDatabaseBytes,
    )
    const safeBudget = createStorageBudget(safeBytes)
    safeBudget.version = version
    this.options.setMaintBudget(safeBudget)

    try {
      const reply = await this.options.askWorker(
        {
          type: 'set-storage-budget',
          budget: fullBudget,
          configVersion: version,
          epoch: targetEpoch,
        },
        this.options.workerTimeoutMs ?? 30_000,
      )

      if (this.disposed || this.options.isStopped() || this.workerEpoch !== targetEpoch) {
        return false // Stale reply from prior epoch or manager stopped
      }

      if (this.desiredConfig.version !== version) {
        return false // Newer desired config requested while handshake was in flight
      }

      if (!reply || !('result' in reply)) {
        const err =
          reply && 'error' in reply && typeof reply.error === 'string'
            ? reply.error
            : 'Worker storage budget handshake timed out'
        this.handleHandshakeFailure(targetEpoch, version, err)
        return false
      }

      const res = reply.result as StorageBudgetWorkerResult
      const appliedVer = typeof res.appliedVersion === 'number' ? res.appliedVersion : null
      const isExactAck = res.ok === true && appliedVer === version && overshootAckMatches(res, fullBudget)

      if (isExactAck) {
        this.cancelRetry()
        this.retryAttempts = 0
        this.appliedVersion = appliedVer
        this.status = 'applied'
        this.error = undefined
        this.appliedBudgetBytes = res.appliedBudgetBytes ?? desired.maxDatabaseBytes
        this.options.setMaintBudget(fullBudget)
        this.notifyWriteReady(true)
        return true
      } else {
        const err =
          res.error ?? `Worker ACK mismatch: applied version ${appliedVer} / overshoot ${res.appliedOvershootRatio ?? 'default'}, desired ${version} / ${fullBudget.overshootRatio}`
        this.handleHandshakeFailure(targetEpoch, version, err)
        return false
      }
    } catch (err: any) {
      if (
        !this.disposed &&
        !this.options.isStopped() &&
        this.workerEpoch === targetEpoch &&
        this.desiredConfig.version === version
      ) {
        this.handleHandshakeFailure(targetEpoch, version, err?.message ?? String(err))
      }
      return false
    } finally {
      if (this.workerEpoch === targetEpoch) this.syncInProgress = false
    }
  }

  private handleHandshakeFailure(targetEpoch: number, version: number, error: string): void {
    if (
      this.disposed ||
      this.options.isStopped() ||
      this.workerEpoch !== targetEpoch ||
      this.desiredConfig.version !== version
    ) {
      return // Stale failure from obsolete epoch or obsolete version; do not override
    }

    this.status = 'error'
    this.error = error
    this.notifyWriteReady(false)

    // Bounded backoff retry
    if (this.retryAttempts < StorageBudgetCoordinator.MAX_HANDSHAKE_RETRIES) {
      this.retryAttempts++
      const delayMs = Math.min(1000 * Math.pow(2, this.retryAttempts - 1), 8000)
      this.cancelRetry()
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        if (
          !this.disposed &&
          !this.options.isStopped() &&
          this.workerEpoch === targetEpoch &&
          this.desiredConfig.version === version &&
          !this.isWriteReady()
        ) {
          void this.syncWorkerBudget(targetEpoch)
        }
      }, delayMs)
      this.retryTimer.unref?.()
    } else {
      // Retries exhausted; notify manager if configured
      if (this.options.onHandshakeFailure) {
        try {
          this.options.onHandshakeFailure(error)
        } catch {
          // Non-blocking
        }
      }
    }
  }

  /**
   * Updates storage budget configuration.
   * Immediately persists desired monotonic version, closes write gate, and clamps effective safe budget.
   * Then serializes worker dispatch in updateMutex without losing the final desired request.
   */
  async setStorageBudget(
    input:
      | StorageBudgetConfig
      | { maxDatabaseBytes?: number; preset?: StorageBudgetPreset; version?: number }
      | number,
  ): Promise<StorageBudgetConfig> {
    let targetBytes: number
    let targetPreset: StorageBudgetPreset

    if (typeof input === 'number') {
      targetBytes = input
      targetPreset = deriveStoragePreset(targetBytes)
    } else {
      if (input.preset && input.preset in STORAGE_PRESET_BYTES) {
        targetBytes = STORAGE_PRESET_BYTES[input.preset as '1gb' | '3gb' | '5gb']
        targetPreset = input.preset
      } else if (input.maxDatabaseBytes !== undefined) {
        targetBytes = input.maxDatabaseBytes
        targetPreset = input.preset ?? deriveStoragePreset(targetBytes)
      } else {
        throw new Error('Either maxDatabaseBytes or a valid preset must be provided')
      }
    }

    if (!validateStorageBudgetBytes(targetBytes)) {
      throw new Error(`Invalid storage budget bytes: ${targetBytes}`)
    }

    let nextVersion: number
    if (typeof input === 'object' && input.version !== undefined) {
      if (!validateStorageBudgetVersion(input.version)) {
        throw new Error(`Invalid version: ${input.version}`)
      }
      nextVersion =
        input.version > this.desiredConfig.version ? input.version : this.desiredConfig.version + 1
    } else {
      nextVersion = this.desiredConfig.version + 1
    }

    // Persist desired configuration to disk immediately
    const saved = writeStorageSettings(this.options.settingsDir, {
      maxDatabaseBytes: targetBytes,
      preset: targetPreset,
      version: nextVersion,
    })

    this.desiredConfig = {
      maxDatabaseBytes: saved.maxDatabaseBytes,
      preset: saved.preset,
      version: saved.version,
      lastSavedAt: saved.lastSavedAt,
    }

    // Immediately close write gate on any new request
    this.status = 'pending'
    this.error = undefined
    this.notifyWriteReady(false)

    // Immediate effective safe budget on reduction / pending update:
    // Safe budget is clamped immediately to min(desired, applied ?? desired)
    const effectiveBytes = Math.min(targetBytes, this.appliedBudgetBytes ?? targetBytes)
    const safeBudget = createStorageBudget(effectiveBytes)
    safeBudget.version = nextVersion
    this.options.setMaintBudget(safeBudget)

    const capturedVersion = nextVersion
    const capturedTargetBytes = targetBytes

    return (this.updateMutex = this.updateMutex.then(
      () => this.applyBudgetToWorker(capturedVersion, capturedTargetBytes),
      () => this.applyBudgetToWorker(capturedVersion, capturedTargetBytes),
    ))
  }

  private async applyBudgetToWorker(
    capturedVersion: number,
    targetBytes: number,
  ): Promise<StorageBudgetConfig> {
    if (this.disposed || this.options.isStopped()) {
      return this.getConfig()
    }

    // If newer desired configuration was already queued, skip sending this stale version
    if (this.desiredConfig.version !== capturedVersion) {
      return this.getConfig()
    }

    const capturedEpoch = this.workerEpoch
    const fullBudget = createStorageBudget(targetBytes)
    fullBudget.version = capturedVersion

    try {
      const reply = await this.options.askWorker(
        {
          type: 'set-storage-budget',
          budget: fullBudget,
          configVersion: capturedVersion,
          epoch: capturedEpoch,
        },
        this.options.workerTimeoutMs ?? 30_000,
      )

      // Verify epoch hasn't changed while awaiting reply
      if (this.disposed || this.options.isStopped() || this.workerEpoch !== capturedEpoch) {
        return this.getConfig()
      }

      // Verify no newer desiredVersion was requested while this was in flight
      if (this.desiredConfig.version !== capturedVersion) {
        // Stale ACK must NOT reopen gate or expand budget
        return this.getConfig()
      }

      if (!reply || !('result' in reply)) {
        const err =
          reply && 'error' in reply && typeof reply.error === 'string'
            ? reply.error
            : 'Worker budget ACK timed out'
        this.status = 'error'
        this.error = err
        this.notifyWriteReady(false)
        return this.getConfig()
      }

      const res = reply.result as StorageBudgetWorkerResult
      const appliedVer = typeof res.appliedVersion === 'number' ? res.appliedVersion : null
      const isExactAck = res.ok === true && appliedVer === capturedVersion && overshootAckMatches(res, fullBudget)

      if (isExactAck) {
        this.appliedVersion = appliedVer
        this.status = 'applied'
        this.error = undefined
        this.appliedBudgetBytes = res.appliedBudgetBytes ?? targetBytes
        this.options.setMaintBudget(fullBudget)
        this.notifyWriteReady(true)
      } else {
        this.status = 'error'
        this.error =
          res.error ?? `Version/overshoot mismatch: applied ${appliedVer} / ${res.appliedOvershootRatio ?? 'default'}, desired ${capturedVersion} / ${fullBudget.overshootRatio}`
        this.notifyWriteReady(false)
      }
    } catch (err: any) {
      if (
        !this.disposed &&
        !this.options.isStopped() &&
        this.workerEpoch === capturedEpoch &&
        this.desiredConfig.version === capturedVersion
      ) {
        this.status = 'error'
        this.error = err?.message ?? String(err)
        this.notifyWriteReady(false)
      }
    }

    return this.getConfig()
  }

  close(): void {
    this.disposed = true
    this.cancelRetry()
    this.writeReadyListeners.clear()
  }

  private cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }
}
