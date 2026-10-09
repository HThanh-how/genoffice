import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { totalmem } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DEFAULT_STORAGE_BUDGET } from '../storage-budget'
import { memoryTierFromTotal, type MemoryTier } from '../memory-tier'

export const STORAGE_SETTINGS_FILENAME = 'document-memory-storage.json'

export const MIN_STORAGE_BUDGET_BYTES = 500 * 1_000_000 // 500 MB (decimal)
export const MAX_STORAGE_BUDGET_BYTES = 100 * 1_000_000_000 // 100 GB (decimal)

export type StorageBudgetPreset = '1gb' | '3gb' | '5gb' | 'custom'

export const STORAGE_PRESET_BYTES: Readonly<Record<'1gb' | '3gb' | '5gb', number>> = Object.freeze({
  '1gb': 1_000_000_000,
  '3gb': 3_000_000_000,
  '5gb': 5_000_000_000,
})

export type StorageBudgetStatus = 'applied' | 'pending' | 'error'

/** Persisted desired storage budget configuration saved on disk. */
export interface StorageBudgetPersistedSettings {
  maxDatabaseBytes: number
  preset: StorageBudgetPreset
  version: number
  lastSavedAt?: number
}

/** Live runtime ACK and application state from the indexing worker. */
export interface StorageBudgetRuntimeState {
  appliedVersion: number | null
  status: StorageBudgetStatus
  error?: string
  appliedBudgetBytes?: number | null
}

/** Unified storage budget configuration combining desired preferences and live runtime state. */
export interface StorageBudgetConfig extends StorageBudgetPersistedSettings, StorageBudgetRuntimeState {}

export function isValidStoragePreset(preset: unknown): preset is StorageBudgetPreset {
  return preset === '1gb' || preset === '3gb' || preset === '5gb' || preset === 'custom'
}

export function validateStorageBudgetBytes(bytes: unknown): bytes is number {
  return (
    typeof bytes === 'number' &&
    Number.isFinite(bytes) &&
    Number.isSafeInteger(bytes) &&
    bytes >= MIN_STORAGE_BUDGET_BYTES &&
    bytes <= MAX_STORAGE_BUDGET_BYTES
  )
}

export function validateStorageBudgetVersion(version: unknown): version is number {
  return (
    typeof version === 'number' &&
    Number.isFinite(version) &&
    Number.isSafeInteger(version) &&
    version >= 0
  )
}

export function deriveStoragePreset(bytes: number): StorageBudgetPreset {
  if (bytes === STORAGE_PRESET_BYTES['1gb']) return '1gb'
  if (bytes === STORAGE_PRESET_BYTES['3gb']) return '3gb'
  if (bytes === STORAGE_PRESET_BYTES['5gb']) return '5gb'
  return 'custom'
}

export function resolveStorageSettingsPath(pathOrDir: string): string {
  const base = basename(pathOrDir)
  if (base === STORAGE_SETTINGS_FILENAME) {
    return pathOrDir
  }
  return join(pathOrDir, STORAGE_SETTINGS_FILENAME)
}

function resolveSettingsDir(pathOrDir: string): string {
  const base = basename(pathOrDir)
  if (base === STORAGE_SETTINGS_FILENAME) {
    return dirname(pathOrDir)
  }
  return pathOrDir
}

export function readStorageSettings(pathOrDir: string): StorageBudgetConfig {
  const filePath = resolveStorageSettingsPath(pathOrDir)
  const defaultBytes = DEFAULT_STORAGE_BUDGET.maxDatabaseBytes
  const defaultConfig: StorageBudgetConfig = {
    maxDatabaseBytes: defaultBytes,
    preset: deriveStoragePreset(defaultBytes),
    version: 1,
    appliedVersion: null,
    status: 'pending',
  }

  if (!existsSync(filePath)) {
    return defaultConfig
  }

  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<StorageBudgetPersistedSettings> | null
    if (parsed && typeof parsed === 'object') {
      const bytes = parsed.maxDatabaseBytes
      const preset = parsed.preset
      const version = validateStorageBudgetVersion(parsed.version) && parsed.version > 0
        ? parsed.version
        : 1

      if (preset && (preset === '1gb' || preset === '3gb' || preset === '5gb')) {
        const presetBytes = STORAGE_PRESET_BYTES[preset]
        if (bytes === undefined || bytes === presetBytes) {
          return {
            maxDatabaseBytes: presetBytes,
            preset,
            version,
            appliedVersion: null,
            status: 'pending',
          }
        }
      }

      if (validateStorageBudgetBytes(bytes)) {
        return {
          maxDatabaseBytes: bytes,
          preset: isValidStoragePreset(preset) ? preset : deriveStoragePreset(bytes),
          version,
          appliedVersion: null,
          status: 'pending',
        }
      }
    }
  } catch {
    // Corrupt JSON falls back to default
  }

  return defaultConfig
}

export function writeStorageSettings(
  pathOrDir: string,
  input:
    | StorageBudgetConfig
    | {
        maxDatabaseBytes?: number
        preset?: StorageBudgetPreset
        version?: number
        appliedVersion?: number | null
        status?: StorageBudgetStatus
        error?: string
        appliedBudgetBytes?: number | null
      }
    | number,
): StorageBudgetConfig {
  const filePath = resolveStorageSettingsPath(pathOrDir)
  const dir = resolveSettingsDir(pathOrDir)
  const previous = readStorageSettings(pathOrDir)

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
    throw new Error(
      `Storage budget bytes must be a positive integer between ${MIN_STORAGE_BUDGET_BYTES} (500 MB) and ${MAX_STORAGE_BUDGET_BYTES} (100 GB). Received: ${targetBytes}`,
    )
  }

  let nextVersion: number
  if (typeof input === 'object' && input.version !== undefined) {
    if (!validateStorageBudgetVersion(input.version)) {
      throw new Error(`Storage budget version must be a non-negative safe integer. Received: ${input.version}`)
    }
    nextVersion = input.version
  } else {
    const isBudgetChanged = targetBytes !== previous.maxDatabaseBytes || targetPreset !== previous.preset
    nextVersion = isBudgetChanged ? previous.version + 1 : previous.version
  }

  const diskData: StorageBudgetPersistedSettings = {
    maxDatabaseBytes: targetBytes,
    preset: targetPreset,
    version: nextVersion,
    lastSavedAt: Date.now(),
  }

  mkdirSync(dir, { recursive: true })
  const content = JSON.stringify(diskData, null, 2)
  const tempPath = join(
    dir,
    `.${STORAGE_SETTINGS_FILENAME}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  )

  try {
    writeFileSync(tempPath, content, 'utf8')
    renameSync(tempPath, filePath)
  } catch (err) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath)
    } catch {
      // ignore unlink error
    }
    throw err
  }

  const runtimeState: StorageBudgetRuntimeState = {
    appliedVersion: typeof input === 'object' && input.appliedVersion !== undefined ? input.appliedVersion : null,
    status: typeof input === 'object' && input.status ? input.status : 'pending',
    error: typeof input === 'object' ? input.error : undefined,
    appliedBudgetBytes: typeof input === 'object' ? input.appliedBudgetBytes : undefined,
  }

  return {
    ...diskData,
    ...runtimeState,
  }
}

/** RAM tier -> preset for a fresh install: 4 GB machines get the light 1 GB index, 8 GB the 3 GB default, 16 GB+ 5 GB. */
const TIER_PRESET: Readonly<Record<MemoryTier, '1gb' | '3gb' | '5gb'>> = Object.freeze({
  low: '1gb',
  normal: '3gb',
  high: '5gb',
})

export function recommendStoragePreset(totalMemBytes: number = totalmem()): '1gb' | '3gb' | '5gb' {
  return TIER_PRESET[memoryTierFromTotal(totalMemBytes / (1024 * 1024))]
}

/**
 * A database bigger than this beside the settings, or a relocated-index marker, proves the index already existed
 * before this setting did: that user keeps the quota they have always had. (A brand-new manager has already created
 * an empty schema-only database by the time settings are resolved, hence a size threshold rather than existence.)
 */
export const LEGACY_INDEX_EVIDENCE_BYTES = 4 * 1024 * 1024

function hasLegacyIndex(dir: string): boolean {
  try {
    if (existsSync(join(dir, 'document-memory-location.json'))) return true
    const db = join(dir, 'document-memory.db')
    return existsSync(db) && statSync(db).size > LEGACY_INDEX_EVIDENCE_BYTES
  } catch {
    return false
  }
}

/**
 * Startup resolution of the quota. A saved file (valid or corrupt) is never touched: the user's choice stands.
 * With no file at all the default is decided ONCE and persisted, so it cannot drift when RAM or index size change:
 *  - fresh install: preset by RAM tier (see recommendStoragePreset);
 *  - an index from before this setting existed: the historical 4 GiB (stored as 'custom'), i.e. unchanged.
 */
export function ensureStorageSettings(
  pathOrDir: string,
  opts: { totalMemBytes?: number } = {},
): StorageBudgetConfig {
  const filePath = resolveStorageSettingsPath(pathOrDir)
  if (existsSync(filePath)) return readStorageSettings(pathOrDir)
  try {
    const dir = resolveSettingsDir(pathOrDir)
    if (hasLegacyIndex(dir)) {
      return writeStorageSettings(pathOrDir, { maxDatabaseBytes: DEFAULT_STORAGE_BUDGET.maxDatabaseBytes, preset: 'custom', version: 1 })
    }
    return writeStorageSettings(pathOrDir, { preset: recommendStoragePreset(opts.totalMemBytes), version: 1 })
  } catch {
    return readStorageSettings(pathOrDir) // unwritable folder: run with the legacy default rather than fail startup
  }
}
