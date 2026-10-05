import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readAppSettings, writeAppSetting } from '../app-settings'
import type { FolderScanManager } from './folder-scan'

export type KnownSearchSource = 'documents' | 'downloads' | 'desktop'

export interface KnownSearchSourceEntry {
  id: KnownSearchSource
  path: string
  enabled: boolean
}

export const KNOWN_SEARCH_SOURCES: readonly KnownSearchSource[] = [
  'documents',
  'downloads',
  'desktop',
] as const

export const KNOWN_SEARCH_SOURCES_KEY = 'knownSearchSources'

export const DEFAULT_KNOWN_SOURCES: Readonly<Record<KnownSearchSource, boolean>> = Object.freeze({
  documents: true,
  downloads: true,
  desktop: false,
})

export function isKnownSearchSource(value: unknown): value is KnownSearchSource {
  return value === 'documents' || value === 'downloads' || value === 'desktop'
}

export function parseKnownSourcesSettings(
  raw: Record<string, unknown> | undefined,
): Record<KnownSearchSource, boolean> {
  const defaults = { ...DEFAULT_KNOWN_SOURCES }
  if (!raw || typeof raw !== 'object') return defaults
  const stored = raw[KNOWN_SEARCH_SOURCES_KEY]
  if (!stored || typeof stored !== 'object') return defaults
  const candidate = stored as Record<string, unknown>
  return {
    documents: typeof candidate.documents === 'boolean' ? candidate.documents : defaults.documents,
    downloads: typeof candidate.downloads === 'boolean' ? candidate.downloads : defaults.downloads,
    desktop: typeof candidate.desktop === 'boolean' ? candidate.desktop : defaults.desktop,
  }
}

export interface KnownSourcesManagerOptions {
  /** Optional absolute path to app-settings.json or a getter returning it. */
  settingsPath?: string | (() => string)
  /** Optional FolderScanManager instance or getter. */
  scanner?: FolderScanManager | null
  getScanner?: () => FolderScanManager | null
  /** Optional custom path resolver (for testing or overrides). */
  getPath?: (id: KnownSearchSource) => string
}

export class KnownSourcesManager {
  private readonly settingsPath?: string | (() => string)
  private readonly getScanner: () => FolderScanManager | null
  private readonly customGetPath?: (id: KnownSearchSource) => string
  private state: Record<KnownSearchSource, boolean>

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

    this.state = this.loadInitialState()
  }

  private resolveSettingsFilePath(): string | null {
    if (!this.settingsPath) return null
    try {
      return typeof this.settingsPath === 'function' ? this.settingsPath() : this.settingsPath
    } catch {
      return null
    }
  }

  private loadInitialState(): Record<KnownSearchSource, boolean> {
    const filePath = this.resolveSettingsFilePath()
    if (!filePath) {
      return { ...DEFAULT_KNOWN_SOURCES }
    }
    try {
      const stored = readAppSettings(filePath)
      return parseKnownSourcesSettings(stored)
    } catch {
      return { ...DEFAULT_KNOWN_SOURCES }
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
   * Returns current list of known sources with resolved paths and enabled states.
   */
  public async getKnownSearchSources(): Promise<KnownSearchSourceEntry[]> {
    return KNOWN_SEARCH_SOURCES.map((id) => ({
      id,
      path: this.resolvePath(id),
      enabled: this.state[id] ?? DEFAULT_KNOWN_SOURCES[id],
    }))
  }

  /**
   * Enables or disables a known search source.
   * Strictly validates that `id` is a known search source enum.
   * When enabled: adds to watched folders and triggers scan/watch via FolderScanManager.
   * When disabled: stops any running scan for the path and removes it from watched folders.
   */
  public async setKnownSearchSource(id: KnownSearchSource, enabled: boolean): Promise<void> {
    if (!isKnownSearchSource(id)) {
      throw new Error(`Invalid known search source id: ${String(id)}`)
    }
    if (typeof enabled !== 'boolean') {
      throw new Error(`Invalid enabled flag for ${id}: expected boolean`)
    }

    this.state[id] = enabled

    const filePath = this.resolveSettingsFilePath()
    if (filePath) {
      try {
        writeAppSetting(filePath, KNOWN_SEARCH_SOURCES_KEY, { ...this.state })
      } catch {
        // Safe fallback if persistence encounters transient disk error
      }
    }

    const resolvedPath = this.resolvePath(id)
    const scanner = this.getScanner()
    if (scanner) {
      if (enabled) {
        try {
          scanner.start(resolvedPath)
        } catch {
          // Folder may be temporarily missing or busy, scanner gracefully logs
        }
      } else {
        try {
          const status = scanner.status()
          if (status.running && status.root && resolve(status.root) === resolve(resolvedPath)) {
            scanner.stop()
          }
          scanner.forget(resolvedPath)
        } catch {
          // Scanner cleanup failure handled safely
        }
      }
    }
  }

  /**
   * Synchronizes currently enabled sources with FolderScanManager.
   * Typically invoked during system startup or when scanner becomes available.
   */
  public async syncWithScanner(): Promise<void> {
    const scanner = this.getScanner()
    if (!scanner) return

    for (const id of KNOWN_SEARCH_SOURCES) {
      if (this.state[id]) {
        const resolvedPath = this.resolvePath(id)
        try {
          scanner.start(resolvedPath)
        } catch {
          // Best effort sync on startup
        }
      }
    }
  }
}
