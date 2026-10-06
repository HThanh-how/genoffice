import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readAppSettings, writeAppSettings } from '../app-settings'
import type { FolderOwner, FolderScanManager } from './folder-scan'

export type KnownSearchSource = 'documents' | 'downloads' | 'desktop'

export type KnownSearchSourceStatus =
  | 'disabled'
  | 'queued'
  | 'scanning'
  | 'watching'
  | 'unavailable'
  | 'error'

export interface KnownSearchSourceEntry {
  id: KnownSearchSource
  path: string
  enabled: boolean
  status: KnownSearchSourceStatus
  error?: string
}

export const KNOWN_SEARCH_SOURCES: readonly KnownSearchSource[] = [
  'documents',
  'downloads',
  'desktop',
] as const

export const KNOWN_SEARCH_SOURCES_KEY = 'knownSearchSources'
export const KNOWN_SEARCH_SOURCES_VERSION_KEY = 'knownSearchSourcesVersion'
export const KNOWN_SEARCH_SOURCES_INITIALIZED_KEY = 'knownSearchSourcesInitialized'

export const DEFAULT_KNOWN_SOURCES: Readonly<Record<KnownSearchSource, boolean>> = Object.freeze({
  documents: true,
  downloads: true,
  desktop: false,
})

export const UNINITIALIZED_KNOWN_SOURCES: Readonly<Record<KnownSearchSource, boolean>> = Object.freeze({
  documents: false,
  downloads: false,
  desktop: false,
})

/** Fast recovery intervals: 1.5s, 5s, 15s, 60s */
export const FAST_RETRY_INTERVALS_MS: readonly number[] = Object.freeze([1500, 5000, 15000, 60000])

/** Slow periodic retry interval: 5 minutes (300,000 ms) */
export const SLOW_PERIODIC_RETRY_INTERVAL_MS = 300_000

/** Async deadline for path availability probe to avoid hanging Electron on offline SMB shares */
export const PROBE_PATH_DEADLINE_MS = 3000

/** Cleanup retry intervals for unregisterRoot failures: 500ms, 1500ms, 3000ms */
export const CLEANUP_RETRY_INTERVALS_MS: readonly number[] = Object.freeze([500, 1500, 3000])

/** Maximum cleanup retry attempts */
export const MAX_CLEANUP_RETRIES = 3

/** Native path probe cache for coalescing concurrent filesystem stat calls on the same target */
export const nativePathProbes = new Map<string, Promise<boolean>>()

export function getOrCreateNativePathProbe(targetPath: string): Promise<boolean> {
  const path = resolve(targetPath)
  const existing = nativePathProbes.get(path)
  if (existing) {
    return existing
  }
  let nativeProbe: Promise<boolean>
  nativeProbe = stat(path)
    .then((stats) => stats.isDirectory())
    .catch(() => false)
    .finally(() => {
      if (nativePathProbes.get(path) === nativeProbe) {
        nativePathProbes.delete(path)
      }
    })
  nativePathProbes.set(path, nativeProbe)
  return nativeProbe
}

/**
 * Asynchronously probes whether targetPath exists and is a directory.
 * Bounded by deadlineMs (default: 3000ms) to never freeze the Electron main thread.
 * Coalesces concurrent in-flight probes on the same resolved path using nativePathProbes to avoid I/O stampede.
 * Caller deadline timeout does NOT evict native probe from cache.
 */
export function probePathAvailable(
  targetPath: string,
  deadlineMs: number = PROBE_PATH_DEADLINE_MS,
): Promise<boolean> {
  const path = resolve(targetPath)
  const nativeProbe = getOrCreateNativePathProbe(path)

  let timer: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<false>((resolvePromise) => {
    timer = setTimeout(() => {
      resolvePromise(false)
    }, deadlineMs)
    timer.unref?.()
  })

  return Promise.race([nativeProbe, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export function isKnownSearchSource(value: unknown): value is KnownSearchSource {
  return value === 'documents' || value === 'downloads' || value === 'desktop'
}

export interface ParsedKnownSourcesSettings {
  state: Record<KnownSearchSource, boolean>
  initialized: boolean
  version: number
}

export function parseKnownSourcesFullSettings(
  raw: Record<string, unknown> | undefined,
): ParsedKnownSourcesSettings {
  if (!raw || typeof raw !== 'object') {
    return {
      state: { ...UNINITIALIZED_KNOWN_SOURCES },
      initialized: false,
      version: 1,
    }
  }

  const initialized = raw[KNOWN_SEARCH_SOURCES_INITIALIZED_KEY] === true
  const version =
    typeof raw[KNOWN_SEARCH_SOURCES_VERSION_KEY] === 'number'
      ? (raw[KNOWN_SEARCH_SOURCES_VERSION_KEY] as number)
      : 1

  if (!initialized) {
    return {
      state: { ...UNINITIALIZED_KNOWN_SOURCES },
      initialized: false,
      version,
    }
  }

  const stored = raw[KNOWN_SEARCH_SOURCES_KEY]
  const candidate = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {}
  return {
    state: {
      documents:
        typeof candidate.documents === 'boolean'
          ? candidate.documents
          : DEFAULT_KNOWN_SOURCES.documents,
      downloads:
        typeof candidate.downloads === 'boolean'
          ? candidate.downloads
          : DEFAULT_KNOWN_SOURCES.downloads,
      desktop:
        typeof candidate.desktop === 'boolean'
          ? candidate.desktop
          : DEFAULT_KNOWN_SOURCES.desktop,
    },
    initialized: true,
    version,
  }
}

export function parseKnownSourcesSettings(
  raw: Record<string, unknown> | undefined,
): Record<KnownSearchSource, boolean> {
  return parseKnownSourcesFullSettings(raw).state
}

export interface KnownSourcesManagerOptions {
  /** Optional absolute path to app-settings.json or a getter returning it. */
  settingsPath?: string | (() => string)
  /** Optional FolderScanManager instance or getter. */
  scanner?: FolderScanManager | null
  getScanner?: () => FolderScanManager | null
  /** Optional custom path resolver (for testing or overrides). */
  getPath?: (id: KnownSearchSource) => string
  /** Optional initial state override (for testing or manual configuration) */
  initialState?: Partial<Record<KnownSearchSource, boolean>>
  initialized?: boolean
}

export class KnownSourcesManager {
  private readonly settingsPath?: string | (() => string)
  private getScanner: () => FolderScanManager | null
  private readonly customGetPath?: (id: KnownSearchSource) => string
  private state: Record<KnownSearchSource, boolean>
  private initialized: boolean
  private closed = false
  private readonly sourceGeneration = new Map<KnownSearchSource, number>()
  private readonly retryTimers = new Map<KnownSearchSource, NodeJS.Timeout>()
  private readonly retryCounts = new Map<KnownSearchSource, number>()
  private readonly cleanupTimers = new Map<KnownSearchSource, NodeJS.Timeout>()
  private readonly cleanupCounts = new Map<KnownSearchSource, number>()
  private readonly sourceErrors = new Map<KnownSearchSource, string>()
  private readonly pathAvailabilityCache = new Map<string, boolean>()
  private readonly activeRetryPromises = new Map<KnownSearchSource, Promise<void>>()
  private readonly activeCleanupPromises = new Map<KnownSearchSource, Promise<void>>()

  constructor(options: KnownSourcesManagerOptions = {}) {
    this.settingsPath = options.settingsPath
    this.customGetPath = options.getPath
    if (options.getScanner) {
      this.getScanner = options.getScanner
    } else if (options.scanner !== undefined) {
      const s = options.scanner
      this.getScanner = () => s
    } else {
      this.getScanner = () => null
    }

    for (const source of KNOWN_SEARCH_SOURCES) {
      this.sourceGeneration.set(source, 0)
    }

    if (options.initialState) {
      this.state = {
        documents: options.initialState.documents ?? false,
        downloads: options.initialState.downloads ?? false,
        desktop: options.initialState.desktop ?? false,
      }
      this.initialized = options.initialized ?? true
    } else {
      const loaded = this.loadInitialState()
      this.state = loaded.state
      this.initialized = loaded.initialized
    }
  }

  public isClosed(): boolean {
    return this.closed
  }

  public setScanner(scanner: FolderScanManager | null | (() => FolderScanManager | null)): void {
    if (typeof scanner === 'function') {
      this.getScanner = scanner
    } else {
      this.getScanner = () => scanner
    }
  }

  public isInitialized(): boolean {
    return this.initialized
  }

  private resolveSettingsFilePath(): string | null {
    if (!this.settingsPath) return null
    try {
      return typeof this.settingsPath === 'function' ? this.settingsPath() : this.settingsPath
    } catch {
      return null
    }
  }

  private loadInitialState(): { state: Record<KnownSearchSource, boolean>; initialized: boolean } {
    const filePath = this.resolveSettingsFilePath()
    if (!filePath) {
      return {
        state: { ...UNINITIALIZED_KNOWN_SOURCES },
        initialized: false,
      }
    }
    try {
      const stored = readAppSettings(filePath)
      const parsed = parseKnownSourcesFullSettings(stored)
      return {
        state: parsed.state,
        initialized: parsed.initialized,
      }
    } catch {
      return {
        state: { ...UNINITIALIZED_KNOWN_SOURCES },
        initialized: false,
      }
    }
  }

  /**
   * Resolves the canonical filesystem path for a given known source id.
   * Uses Electron app.getPath(id) when running inside Electron.
   * Falls back to joining os.homedir() with 'Documents', 'Downloads', or 'Desktop'.
   * Never accepts or returns arbitrary user-controlled paths.
   */
  public resolvePath(id: KnownSearchSource): string {
    if (!isKnownSearchSource(id)) {
      throw new Error(`Invalid known search source id: ${String(id)}`)
    }

    if (this.customGetPath) {
      try {
        return resolve(this.customGetPath(id))
      } catch {
        // Fall back to default resolution if custom resolver fails
      }
    }

    try {
      // Dynamic require so it executes safely both in Electron and in Node / Vitest
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require('electron')
      const electronApp = electron?.app
      if (electronApp && typeof electronApp.getPath === 'function') {
        const resolved = electronApp.getPath(id)
        if (typeof resolved === 'string' && resolved.trim()) {
          return resolve(resolved)
        }
      }
    } catch {
      // Electron app.getPath is not available (e.g. running in vitest under Node.js)
    }

    const folderName =
      id === 'documents' ? 'Documents' : id === 'downloads' ? 'Downloads' : 'Desktop'
    return resolve(join(homedir(), folderName))
  }

  /**
   * Asynchronously probes whether targetPath exists and is a directory.
   * Bounded by deadline to prevent freezing the Electron main process.
   * Caches result internally for immediate synchronous inspection by getStatus().
   */
  public async isPathAvailable(path: string, timeoutMs = PROBE_PATH_DEADLINE_MS): Promise<boolean> {
    const available = await probePathAvailable(path, timeoutMs)
    this.pathAvailabilityCache.set(path, available)
    return available
  }

  /**
   * Returns runtime truth status for a known source id.
   * Never reports 'watching' without actual registration and confirmed readiness in scanner.
   */
  public getStatus(id: KnownSearchSource): { status: KnownSearchSourceStatus; error?: string } {
    const enabled = this.state[id] ?? false
    if (!enabled) {
      return { status: 'disabled' }
    }

    const resolvedPath = this.resolvePath(id)
    const isAvailable = this.pathAvailabilityCache.get(resolvedPath) ?? false
    if (!isAvailable) {
      return { status: 'unavailable', error: 'The selected folder is unavailable.' }
    }

    // If start failed on this source, report error status and maintain retry
    if (this.sourceErrors.has(id)) {
      return { status: 'error', error: this.sourceErrors.get(id) }
    }

    const scanner = this.getScanner()
    if (!scanner) {
      return { status: 'queued' }
    }

    const owner: FolderOwner = `known:${id}`
    const regState =
      typeof scanner.registrationState === 'function'
        ? scanner.registrationState(resolvedPath, owner)
        : (() => {
            const job = scanner.folders?.().find((f) => resolve(f.root) === resolve(resolvedPath))
            if (job && job.owners && !job.owners.includes(owner)) return 'none'
            const scanStatus = scanner.status?.()
            if (
              scanStatus?.running &&
              scanStatus.root &&
              resolve(scanStatus.root) === resolve(resolvedPath)
            ) {
              if (job && !job.owners?.includes(owner)) return 'none'
              return 'scanning'
            }
            if (scanner.isWaiting?.(resolvedPath)) return 'queued'
            if (!job || (job.owners && !job.owners.includes(owner))) return 'none'
            if (job.state === 'running') return 'scanning'
            if (job.state === 'complete') return 'watching'
            if (job.state === 'stopped') return 'stopped'
            return 'none'
          })()

    switch (regState) {
      case 'scanning':
        return { status: 'scanning' }
      case 'queued':
        return { status: 'queued' }
      case 'watching':
        return { status: 'watching' }
      case 'stopped': {
        const job = scanner.folders().find((f) => resolve(f.root) === resolve(resolvedPath))
        if (job?.lastError && job.errors > 0) {
          return { status: 'error', error: job.lastError }
        }
        return { status: 'unavailable', error: 'Folder scanning is stopped.' }
      }
      case 'none':
      default:
        return { status: 'queued' }
    }
  }

  public async getEntry(id: KnownSearchSource): Promise<KnownSearchSourceEntry> {
    const resolvedPath = this.resolvePath(id)
    if (this.state[id]) {
      await this.isPathAvailable(resolvedPath)
    }
    const { status, error } = this.getStatus(id)
    return {
      id,
      path: resolvedPath,
      enabled: this.state[id] ?? false,
      status,
      ...(error ? { error } : {}),
    }
  }

  /**
   * Returns current list of known sources with resolved paths, enabled states and canonical status.
   * Performs async path probing across all sources without blocking main thread.
   */
  public async getKnownSearchSources(): Promise<KnownSearchSourceEntry[]> {
    return Promise.all(KNOWN_SEARCH_SOURCES.map((id) => this.getEntry(id)))
  }

  /**
   * Enables or disables a known search source.
   * Strictly validates that `id` is a known search source enum.
   * Persist-before-apply: writes to disk first before updating memory and runtime scanner.
   * When enabled: probes path, adds to scanner with owner `known:${id}`, handles exceptions, and sets retry.
   * When disabled: cancels retries, unregisters root with owner `known:${id}`.
   */
  public async setKnownSearchSource(
    id: KnownSearchSource,
    enabled: boolean,
  ): Promise<KnownSearchSourceEntry> {
    if (this.closed) {
      throw new Error('KnownSourcesManager is closed')
    }
    if (!isKnownSearchSource(id)) {
      throw new Error(`Invalid known search source id: ${String(id)}`)
    }
    if (typeof enabled !== 'boolean') {
      throw new Error(`Invalid enabled flag for ${id}: expected boolean`)
    }

    const nextState = { ...this.state, [id]: enabled }
    const filePath = this.resolveSettingsFilePath()

    if (filePath) {
      // Persist-before-apply: must succeed or throw before modifying RAM or scanner
      writeAppSettings(filePath, {
        [KNOWN_SEARCH_SOURCES_KEY]: nextState,
        [KNOWN_SEARCH_SOURCES_INITIALIZED_KEY]: true,
        [KNOWN_SEARCH_SOURCES_VERSION_KEY]: 1,
      })
    }

    // Disk write succeeded: mutate in-memory state and bump generation token
    this.state = nextState
    this.initialized = true
    this.sourceGeneration.set(id, (this.sourceGeneration.get(id) ?? 0) + 1)

    await this.reconcileOneSource(id, this.generationOf(id))
    return this.getEntry(id)
  }

  private generationOf(id: KnownSearchSource): number {
    return this.sourceGeneration.get(id) ?? 0
  }

  private isCurrentDesiredState(
    id: KnownSearchSource,
    generation: number,
    enabled: boolean,
  ): boolean {
    return (
      !this.closed &&
      this.state[id] === enabled &&
      this.generationOf(id) === generation
    )
  }

  public async reconcileOneSource(
    id: KnownSearchSource,
    generation = this.generationOf(id),
  ): Promise<void> {
    if (this.closed) return
    const enabled = this.state[id] ?? false
    if (!this.isCurrentDesiredState(id, generation, enabled)) {
      return
    }

    const resolvedPath = this.resolvePath(id)
    const scanner = this.getScanner()
    const owner: FolderOwner = `known:${id}`

    if (enabled) {
      this.cancelCleanupRetry(id)
      this.sourceErrors.delete(id)
      const available = await this.isPathAvailable(resolvedPath)
      if (!this.isCurrentDesiredState(id, generation, true)) {
        return
      }

      if (available) {
        if (scanner) {
          try {
            scanner.start(resolvedPath, owner)
            this.cancelRetry(id)
          } catch (err: unknown) {
            if (!this.isCurrentDesiredState(id, generation, true)) return
            const message = err instanceof Error ? err.message : String(err)
            this.sourceErrors.set(id, message)
            this.scheduleRetry(id)
          }
        } else {
          this.scheduleRetry(id)
        }
      } else {
        this.scheduleRetry(id)
      }
    } else {
      this.cancelRetry(id)
      this.sourceErrors.delete(id)
      if (scanner) {
        try {
          await scanner.unregisterRoot(resolvedPath, owner)
          this.cancelCleanupRetry(id)
        } catch {
          if (!this.closed && !this.state[id]) {
            this.scheduleCleanupRetry(id, resolvedPath, owner)
          }
        }
      }
      // Last desired state wins: nếu sau unregister mà source đã được bật lại
      if (!this.closed && this.state[id] === true) {
        await this.reconcileOneSource(id, this.generationOf(id))
      }
    }
  }

  private cancelRetry(id: KnownSearchSource): void {
    const timer = this.retryTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.retryTimers.delete(id)
    }
    this.retryCounts.delete(id)
  }

  private cancelCleanupRetry(id: KnownSearchSource): void {
    const timer = this.cleanupTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.cleanupTimers.delete(id)
    }
    this.cleanupCounts.delete(id)
  }

  /**
   * Schedules infinite retries for unavailable or failed sources.
   * Fast recovery phase: 1.5s, 5s, 15s, 60s.
   * Slow periodic retry phase: every 5 minutes (300,000 ms) while source is enabled.
   */
  private scheduleRetry(id: KnownSearchSource): void {
    if (this.closed || !this.state[id]) return
    if (this.retryTimers.has(id)) return

    const count = this.retryCounts.get(id) ?? 0
    const delay =
      count < FAST_RETRY_INTERVALS_MS.length
        ? FAST_RETRY_INTERVALS_MS[count]
        : SLOW_PERIODIC_RETRY_INTERVAL_MS

    this.retryCounts.set(id, count + 1)
    const generation = this.sourceGeneration.get(id) ?? 0

    const timer = setTimeout(() => {
      this.retryTimers.delete(id)
      if (this.closed || !this.state[id] || generation !== (this.sourceGeneration.get(id) ?? 0)) {
        this.retryCounts.delete(id)
        return
      }

      const promise = (async () => {
        if (this.closed || !this.state[id] || generation !== (this.sourceGeneration.get(id) ?? 0)) {
          this.retryCounts.delete(id)
          return
        }

        const resolvedPath = this.resolvePath(id)
        const available = await this.isPathAvailable(resolvedPath)

        // BẮT BUỘC kiểm tra lại sau async probe boundary
        if (this.closed || !this.state[id] || generation !== (this.sourceGeneration.get(id) ?? 0)) {
          return
        }

        if (available) {
          const scanner = this.getScanner()
          if (scanner) {
            try {
              scanner.start(resolvedPath, `known:${id}`)
              this.sourceErrors.delete(id)
              this.retryCounts.delete(id)
              return
            } catch (err: unknown) {
              if (this.closed || !this.state[id] || generation !== (this.sourceGeneration.get(id) ?? 0)) {
                return
              }
              const message = err instanceof Error ? err.message : String(err)
              this.sourceErrors.set(id, message)
              this.scheduleRetry(id)
            }
          } else {
            this.scheduleRetry(id)
          }
        } else {
          this.scheduleRetry(id)
        }
      })().finally(() => {
        if (this.activeRetryPromises.get(id) === promise) {
          this.activeRetryPromises.delete(id)
        }
      })

      this.activeRetryPromises.set(id, promise)
    }, delay)

    timer.unref?.()
    this.retryTimers.set(id, timer)
  }

  /**
   * Schedules bounded retries for unregistering root when scanner throws during source disable.
   * Prevents scanner from being trapped with stale owners.
   */
  private scheduleCleanupRetry(
    id: KnownSearchSource,
    targetPath: string,
    owner: FolderOwner,
  ): void {
    if (this.closed || this.state[id]) return
    if (this.cleanupTimers.has(id)) return

    const count = this.cleanupCounts.get(id) ?? 0
    if (count >= MAX_CLEANUP_RETRIES) {
      this.cleanupCounts.delete(id)
      return
    }

    const delay =
      count < CLEANUP_RETRY_INTERVALS_MS.length
        ? CLEANUP_RETRY_INTERVALS_MS[count]
        : CLEANUP_RETRY_INTERVALS_MS[CLEANUP_RETRY_INTERVALS_MS.length - 1]

    this.cleanupCounts.set(id, count + 1)

    const timer = setTimeout(() => {
      this.cleanupTimers.delete(id)
      if (this.closed || this.state[id]) {
        this.cleanupCounts.delete(id)
        return
      }

      const promise = (async () => {
        if (this.closed || this.state[id]) {
          this.cleanupCounts.delete(id)
          return
        }

        const scanner = this.getScanner()
        if (!scanner) return

        try {
          await scanner.unregisterRoot(targetPath, owner)
          this.cleanupCounts.delete(id)
        } catch {
          if (!this.closed && !this.state[id]) {
            this.scheduleCleanupRetry(id, targetPath, owner)
          }
        }
      })().finally(() => {
        if (this.activeCleanupPromises.get(id) === promise) {
          this.activeCleanupPromises.delete(id)
        }
      })

      this.activeCleanupPromises.set(id, promise)
    }, delay)

    timer.unref?.()
    this.cleanupTimers.set(id, timer)
  }

  /**
   * Waits for any currently executing retry async task to settle.
   * Useful for testing and deterministic synchronization.
   */
  public async waitForRetry(id?: KnownSearchSource): Promise<void> {
    if (id) {
      const p = this.activeRetryPromises.get(id)
      if (p) await p
    } else {
      await Promise.all([...this.activeRetryPromises.values()])
    }
  }

  /**
   * Waits for any currently executing cleanup async task to settle.
   * Useful for testing and deterministic synchronization.
   */
  public async waitForCleanup(id?: KnownSearchSource): Promise<void> {
    if (id) {
      const p = this.activeCleanupPromises.get(id)
      if (p) await p
    } else {
      await Promise.all([...this.activeCleanupPromises.values()])
    }
  }

  /**
   * Reconciles desired sources with the runtime FolderScanManager.
   * If source is enabled and available: starts scan with owner `known:${id}`, handles errors.
   * If source is enabled and unavailable: schedules bounded fast recovery / slow periodic retry.
   * If source is disabled: unregisters root with owner `known:${id}`.
   */
  public async reconcileDesiredSources(): Promise<void> {
    if (this.closed) return
    for (const id of KNOWN_SEARCH_SOURCES) {
      if (this.closed) return
      await this.reconcileOneSource(id, this.generationOf(id))
    }
  }

  /**
   * Synchronizes currently enabled sources with FolderScanManager.
   * Alias for reconcileDesiredSources.
   */
  public async syncWithScanner(): Promise<void> {
    return this.reconcileDesiredSources()
  }

  public close(): void {
    this.closed = true
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer)
    }
    this.retryTimers.clear()
    this.retryCounts.clear()

    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer)
    }
    this.cleanupTimers.clear()
    this.cleanupCounts.clear()

    this.sourceErrors.clear()
    this.pathAvailabilityCache.clear()
    this.activeRetryPromises.clear()
    this.activeCleanupPromises.clear()
  }
}
