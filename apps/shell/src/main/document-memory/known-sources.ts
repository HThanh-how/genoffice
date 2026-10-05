import { existsSync, statSync } from 'node:fs'
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
  private readonly retryTimers = new Map<KnownSearchSource, NodeJS.Timeout>()
  private readonly retryCounts = new Map<KnownSearchSource, number>()
  private static readonly MAX_RETRIES = 5
  private static readonly RETRY_BASE_INTERVAL_MS = 1500

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

  public isPathAvailable(path: string): boolean {
    try {
      return existsSync(path) && statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  public getStatus(id: KnownSearchSource): { status: KnownSearchSourceStatus; error?: string } {
    const enabled = this.state[id] ?? false
    if (!enabled) {
      return { status: 'disabled' }
    }

    const resolvedPath = this.resolvePath(id)
    if (!this.isPathAvailable(resolvedPath)) {
      return { status: 'unavailable', error: 'The selected folder is unavailable.' }
    }

    const scanner = this.getScanner()
    if (!scanner) {
      return { status: 'watching' }
    }

    const scanStatus = scanner.status()
    if (scanStatus.running && scanStatus.root && resolve(scanStatus.root) === resolve(resolvedPath)) {
      return { status: 'scanning' }
    }

    if (scanner.isWaiting(resolvedPath)) {
      return { status: 'queued' }
    }

    const job = scanner.folders().find((f) => resolve(f.root) === resolve(resolvedPath))
    if (job) {
      if (job.state === 'running') {
        return { status: 'scanning' }
      }
      if (job.lastError && job.errors > 0 && job.state === 'stopped') {
        return { status: 'error', error: job.lastError }
      }
      return { status: 'watching' }
    }

    return { status: 'watching' }
  }

  public getEntry(id: KnownSearchSource): KnownSearchSourceEntry {
    const resolvedPath = this.resolvePath(id)
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
   */
  public async getKnownSearchSources(): Promise<KnownSearchSourceEntry[]> {
    return KNOWN_SEARCH_SOURCES.map((id) => this.getEntry(id))
  }

  /**
   * Enables or disables a known search source.
   * Strictly validates that `id` is a known search source enum.
   * Persist-before-apply: writes to disk first before updating memory and runtime scanner.
   * When enabled: adds to watched folders and triggers scan/watch via FolderScanManager.
   * When disabled: unregisters root with owner `known:${id}`.
   */
  public async setKnownSearchSource(
    id: KnownSearchSource,
    enabled: boolean,
  ): Promise<KnownSearchSourceEntry> {
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

    // Disk write succeeded: mutate in-memory state
    this.state = nextState
    this.initialized = true

    const resolvedPath = this.resolvePath(id)
    const scanner = this.getScanner()
    const owner: FolderOwner = `known:${id}`

    if (scanner) {
      if (enabled) {
        if (this.isPathAvailable(resolvedPath)) {
          this.cancelRetry(id)
          try {
            scanner.start(resolvedPath, owner)
          } catch {
            // Scanner handles errors
          }
        } else {
          this.scheduleRetry(id)
        }
      } else {
        this.cancelRetry(id)
        try {
          await scanner.unregisterRoot(resolvedPath, owner)
        } catch {
          // Scanner cleanup failure handled safely
        }
      }
    }

    return this.getEntry(id)
  }

  private cancelRetry(id: KnownSearchSource): void {
    const timer = this.retryTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.retryTimers.delete(id)
    }
    this.retryCounts.delete(id)
  }

  private scheduleRetry(id: KnownSearchSource): void {
    if (this.retryTimers.has(id)) return
    const count = this.retryCounts.get(id) ?? 0
    if (count >= KnownSourcesManager.MAX_RETRIES) return

    this.retryCounts.set(id, count + 1)
    const delay = KnownSourcesManager.RETRY_BASE_INTERVAL_MS * Math.pow(1.5, count)
    const timer = setTimeout(async () => {
      this.retryTimers.delete(id)
      if (!this.state[id]) return

      const resolvedPath = this.resolvePath(id)
      if (this.isPathAvailable(resolvedPath)) {
        this.retryCounts.delete(id)
        const scanner = this.getScanner()
        if (scanner) {
          try {
            scanner.start(resolvedPath, `known:${id}`)
          } catch {
            // Best effort
          }
        }
      } else {
        this.scheduleRetry(id)
      }
    }, delay)

    timer.unref?.()
    this.retryTimers.set(id, timer)
  }

  /**
   * Reconciles desired sources with the runtime FolderScanManager.
   * If source is enabled and available: starts scan with owner `known:${id}`.
   * If source is enabled and unavailable: schedules bounded retry.
   * If source is disabled: unregisters root with owner `known:${id}`.
   */
  public async reconcileDesiredSources(): Promise<void> {
    const scanner = this.getScanner()
    if (!scanner) return

    for (const id of KNOWN_SEARCH_SOURCES) {
      const enabled = this.state[id]
      const resolvedPath = this.resolvePath(id)
      const owner: FolderOwner = `known:${id}`

      if (enabled) {
        if (this.isPathAvailable(resolvedPath)) {
          this.cancelRetry(id)
          try {
            scanner.start(resolvedPath, owner)
          } catch {
            // Scanner handles errors
          }
        } else {
          this.scheduleRetry(id)
        }
      } else {
        this.cancelRetry(id)
        try {
          await scanner.unregisterRoot(resolvedPath, owner)
        } catch {
          // Best effort
        }
      }
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
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer)
    }
    this.retryTimers.clear()
    this.retryCounts.clear()
  }
}
