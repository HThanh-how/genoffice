import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  DEFAULT_EMBEDDING_PROFILE,
  EMBEDDING_PROFILES,
  isEmbeddingProfileId,
  type EmbeddingProfile,
  type EmbeddingProfileId,
} from '../embedding-profiles'

export const EMBEDDING_SETTINGS_FILENAME = 'document-memory-embedding.json'

export interface ActiveEmbeddingConfig {
  profileId: EmbeddingProfileId
  profile: EmbeddingProfile
  activeSpaceId: string
  activeDimensions: number
}

/**
 * Resolves the path to the independent embedding configuration JSON file.
 */
export function resolveEmbeddingSettingsPath(pathOrDir: string): string {
  if (basename(pathOrDir) === EMBEDDING_SETTINGS_FILENAME) {
    return pathOrDir
  }
  return join(pathOrDir, EMBEDDING_SETTINGS_FILENAME)
}

/**
 * Reads the active embedding profile ID independently from JSON file BEFORE database opens (BEH-14).
 * Returns 'standard' by default when file is missing, empty, or corrupted.
 */
export function readEmbeddingProfileId(pathOrDir: string): EmbeddingProfileId {
  const filePath = resolveEmbeddingSettingsPath(pathOrDir)
  if (!existsSync(filePath)) {
    // Also check parent directory if path was a database subdirectory
    const parentPath = join(dirname(pathOrDir), EMBEDDING_SETTINGS_FILENAME)
    if (existsSync(parentPath)) {
      return readEmbeddingProfileId(parentPath)
    }
    return DEFAULT_EMBEDDING_PROFILE
  }

  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as { profile?: unknown } | null
    if (parsed && isEmbeddingProfileId(parsed.profile)) {
      return parsed.profile
    }
  } catch {
    // Return default profile on read/parse error
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
 * Persists the active embedding profile to the independent JSON file.
 */
export function writeEmbeddingProfileId(pathOrDir: string, profileId: EmbeddingProfileId): void {
  const filePath = resolveEmbeddingSettingsPath(pathOrDir)
  writeFileSync(filePath, JSON.stringify({ profile: profileId }, null, 2), 'utf8')
}
