import { existsSync, statSync } from 'node:fs'
import { availableParallelism, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  EMBEDDING_SETTINGS_FILENAME,
  LEGACY_EMBEDDING_SETTINGS_FILENAME,
  readEmbeddingProfileId,
  writeActiveEmbeddingConfig,
} from '../storage/embedding-settings'
import {
  DEFAULT_EMBEDDING_PROFILE,
  isEmbeddingProfileId,
  recommendEmbeddingProfile,
  type EmbeddingProfileId,
  type MachineSpec,
} from '../embedding-profiles'

/** The machine this process runs on, as recommendEmbeddingProfile wants it. */
export function currentMachineSpec(): MachineSpec {
  return {
    totalMemGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    logicalCores: availableParallelism(),
    arch: process.arch,
    platform: process.platform,
  }
}

export interface InitialProfileChoice {
  profile: EmbeddingProfileId
  /**
   * saved:          the user's (or a previous run's) stored choice, returned untouched
   * existing-index: no stored choice but an index already exists, so it was built with the legacy default
   * recommended:    a fresh install, matched to the machine
   */
  source: 'saved' | 'existing-index' | 'recommended'
}

/**
 * Which profile an install should start with. A saved profile always wins, and an index that
 * already exists without a settings file stays on the legacy default (its vectors live in that
 * space; nothing is re-embedded behind the user's back). Only a fresh install is advised by
 * the machine, and the caller persists the answer once (writeActiveEmbeddingConfig) so the
 * recommendation is never re-evaluated or applied over a later choice.
 */
export function chooseInitialEmbeddingProfile(input: {
  saved: unknown
  hasExistingIndex: boolean
  spec: MachineSpec
}): InitialProfileChoice {
  if (isEmbeddingProfileId(input.saved)) return { profile: input.saved, source: 'saved' }
  if (input.hasExistingIndex) return { profile: DEFAULT_EMBEDDING_PROFILE, source: 'existing-index' }
  return { profile: recommendEmbeddingProfile(input.spec).profile, source: 'recommended' }
}

function hasSettingsFile(dir: string): boolean {
  return (
    existsSync(join(dir, EMBEDDING_SETTINGS_FILENAME)) ||
    existsSync(join(dir, LEGACY_EMBEDDING_SETTINGS_FILENAME))
  )
}

/**
 * Startup entry point, to be called BEFORE the database is opened: reads the saved choice (the
 * same files and precedence as readEmbeddingProfileId), and only for a fresh install (no
 * settings file, no database file) persists the machine's recommendation. After that the file
 * exists, so the recommendation is never evaluated again and cannot override a later choice.
 */
export function resolveStartupEmbeddingProfile(input: {
  settingsDir: string
  dbPath: string
  spec: MachineSpec
}): InitialProfileChoice {
  const parent = dirname(resolve(input.settingsDir))
  const hasSaved = hasSettingsFile(input.settingsDir) || (parent !== resolve(input.settingsDir) && hasSettingsFile(parent))
  let hasExistingIndex = false
  try {
    hasExistingIndex = statSync(input.dbPath).size > 0
  } catch {
    // no database yet
  }
  const choice = chooseInitialEmbeddingProfile({
    saved: hasSaved ? readEmbeddingProfileId(input.settingsDir) : undefined,
    hasExistingIndex,
    spec: input.spec,
  })
  if (choice.source === 'recommended') writeActiveEmbeddingConfig(input.settingsDir, choice.profile)
  return choice
}
