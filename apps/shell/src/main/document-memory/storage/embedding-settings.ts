import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  DEFAULT_EMBEDDING_PROFILE,
  EMBEDDING_PROFILES,
  isEmbeddingProfileId,
  type EmbeddingProfile,
  type EmbeddingProfileId,
} from '../embedding-profiles'

export const EMBEDDING_SETTINGS_FILENAME = 'document-memory-embedding.json'
export const LEGACY_EMBEDDING_SETTINGS_FILENAME = 'embedding-settings.json'

export interface ActiveEmbeddingConfig {
  profileId: EmbeddingProfileId
  profile: EmbeddingProfile
  activeSpaceId: string
  activeDimensions: number
}

/**
 * Resolves the path to the canonical embedding configuration JSON file.
 */
export function resolveEmbeddingSettingsPath(pathOrDir: string): string {
  const base = basename(pathOrDir)
  if (base === EMBEDDING_SETTINGS_FILENAME) {
    return pathOrDir
  }
  if (base === LEGACY_EMBEDDING_SETTINGS_FILENAME) {
    return join(dirname(pathOrDir), EMBEDDING_SETTINGS_FILENAME)
  }
  return join(pathOrDir, EMBEDDING_SETTINGS_FILENAME)
}

function resolveSettingsDir(pathOrDir: string): string {
  const base = basename(pathOrDir)
  if (base === EMBEDDING_SETTINGS_FILENAME || base === LEGACY_EMBEDDING_SETTINGS_FILENAME) {
    return dirname(pathOrDir)
  }
  return pathOrDir
}

function parseProfileFromFile(filePath: string): EmbeddingProfileId | null {
  try {
    if (!existsSync(filePath)) return null
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as { profile?: unknown } | null
    if (parsed && isEmbeddingProfileId(parsed.profile)) {
      return parsed.profile
    }
  } catch {
    // Return null on read/parse error
  }
  return null
}

/**
 * Reads the active embedding profile ID independently from JSON file BEFORE database opens (BEH-14).
 * Returns 'standard' by default when file is missing, empty, or corrupted.
 *
 * Single source of truth & legacy compatibility:
 * - Canonical file: document-memory-embedding.json
 * - Legacy file: embedding-settings.json
 * - Canonical always wins if both exist.
 * - If canonical is missing but legacy exists: reads legacy, persists to canonical for future reads.
 */
export function readEmbeddingProfileId(pathOrDir: string): EmbeddingProfileId {
  const dir = resolveSettingsDir(pathOrDir)
  const canonicalPath = join(dir, EMBEDDING_SETTINGS_FILENAME)
  const legacyPath = join(dir, LEGACY_EMBEDDING_SETTINGS_FILENAME)

  // 1. Canonical always wins if it exists
  if (existsSync(canonicalPath)) {
    return parseProfileFromFile(canonicalPath) ?? DEFAULT_EMBEDDING_PROFILE
  }

  // 2. Canonical missing + legacy exists -> read legacy -> write canonical -> future reads canonical
  if (existsSync(legacyPath)) {
    const legacyProfile = parseProfileFromFile(legacyPath) ?? DEFAULT_EMBEDDING_PROFILE
    try {
      writeActiveEmbeddingConfig(dir, legacyProfile)
    } catch {
      // ignore write errors on read-only environments
    }
    return legacyProfile
  }

  // 3. Also check parent directory if path was a database subdirectory
  const parentDir = dirname(resolve(dir))
  if (parentDir && parentDir !== resolve(dir)) {
    const parentCanonical = join(parentDir, EMBEDDING_SETTINGS_FILENAME)
    if (existsSync(parentCanonical)) {
      return parseProfileFromFile(parentCanonical) ?? DEFAULT_EMBEDDING_PROFILE
    }

    const parentLegacy = join(parentDir, LEGACY_EMBEDDING_SETTINGS_FILENAME)
    if (existsSync(parentLegacy)) {
      const legacyProfile = parseProfileFromFile(parentLegacy) ?? DEFAULT_EMBEDDING_PROFILE
      try {
        writeActiveEmbeddingConfig(parentDir, legacyProfile)
      } catch {
        // ignore
      }
      return legacyProfile
    }
  }

  return DEFAULT_EMBEDDING_PROFILE
}

/**
 * Reads the active embedding space configuration independently (BEH-14).
 */
export function readActiveEmbeddingConfig(pathOrDir: string): ActiveEmbeddingConfig {
  const profileId = readEmbeddingProfileId(pathOrDir)
  const profile = EMBEDDING_PROFILES[profileId]
  return {
    profileId,
    profile,
    activeSpaceId: profile.embeddingId,
    activeDimensions: profile.dimensions,
  }
}

/**
 * Persists the active embedding profile to the canonical JSON file.
 */
export function writeActiveEmbeddingConfig(
  pathOrDir: string,
  profileId: EmbeddingProfileId,
): ActiveEmbeddingConfig {
  const filePath = resolveEmbeddingSettingsPath(pathOrDir)
  const validProfileId = isEmbeddingProfileId(profileId) ? profileId : DEFAULT_EMBEDDING_PROFILE
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify({ profile: validProfileId }, null, 2), 'utf8')
  const profile = EMBEDDING_PROFILES[validProfileId]
  return {
    profileId: validProfileId,
    profile,
    activeSpaceId: profile.embeddingId,
    activeDimensions: profile.dimensions,
  }
}

/**
 * Backwards compatible alias for writeActiveEmbeddingConfig.
 */
export function writeEmbeddingProfileId(pathOrDir: string, profileId: EmbeddingProfileId): void {
  writeActiveEmbeddingConfig(pathOrDir, profileId)
}
