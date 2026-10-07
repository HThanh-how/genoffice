import { isGeneratedArtifactPath } from '../../artifact-policy'

export type MigrationRetentionCategory =
  | 'case-a-excluded'
  | 'case-b-dropped-artifact'
  | 'case-c-user-opened'
  | 'case-d-normal-doc'

export interface RetentionDecision {
  category: MigrationRetentionCategory
  shouldCopyDocument: boolean
  shouldCopyChunksAndEmbeddings: boolean
}

export interface CandidateDocument {
  id: number
  path: string
  name?: string | null
  status: string
  excluded?: number | null
  last_opened_at?: number | null
}

/**
 * Applies Document Admission & Retention Policy during V2 to V3 migration (INV-02).
 * 
 * Rules:
 * - Case A: `excluded = 1` -> copy exclusion metadata, skip chunks and embeddings.
 * - Case B: Auto-discovered artifact (`last_opened_at = 0 AND isGeneratedArtifactPath(path)`) -> DROP completely!
 * - Case C: User-opened document (`last_opened_at > 0`) -> KEEP always (explicit user intent wins over filter).
 * - Case D: Normal document -> KEEP metadata, active chunks, canonical embeddings, and OCR.
 */
export function evaluateRetentionPolicy(doc: CandidateDocument): RetentionDecision {
  const isExcluded = doc.excluded === 1
  if (isExcluded) {
    return {
      category: 'case-a-excluded',
      shouldCopyDocument: true,
      shouldCopyChunksAndEmbeddings: false,
    }
  }

  const lastOpenedAt = doc.last_opened_at ?? 0

  if (lastOpenedAt === 0 && isGeneratedArtifactPath(doc.path)) {
    return {
      category: 'case-b-dropped-artifact',
      shouldCopyDocument: false,
      shouldCopyChunksAndEmbeddings: false,
    }
  }

  if (lastOpenedAt > 0) {
    return {
      category: 'case-c-user-opened',
      shouldCopyDocument: true,
      shouldCopyChunksAndEmbeddings: true,
    }
  }

  return {
    category: 'case-d-normal-doc',
    shouldCopyDocument: true,
    shouldCopyChunksAndEmbeddings: true,
  }
}

export const MIN_VERIFIED_BACKUPS = 3
export const MIN_BACKUP_AGE_HOURS = 24

export interface BackupRetentionDecision {
  shouldRetain: boolean
  reason: 'younger-than-24h' | 'top-3-verified' | 'unverified-under-threshold' | 'eligible-for-purge'
}

/**
 * Evaluates Backup Retention Policy (PAIR 06 / BEH-17 / INV-02).
 * 
 * Rules:
 * - Keep minimum 3 verified backups (verifiedRank < minVerifiedBackups).
 * - Keep all backups created within the last 24 hours (ageHours < minAgeHours).
 * - Purge only backups that are both older than 24h AND beyond the 3 newest verified backups.
 */
export function evaluateBackupRetention(
  ageHours: number,
  isVerified: boolean,
  verifiedRank: number,
  totalVerifiedCount: number,
  minVerifiedBackups = MIN_VERIFIED_BACKUPS,
  minAgeHours = MIN_BACKUP_AGE_HOURS,
): BackupRetentionDecision {
  if (ageHours < minAgeHours) {
    return { shouldRetain: true, reason: 'younger-than-24h' }
  }
  if (isVerified && verifiedRank < minVerifiedBackups) {
    return { shouldRetain: true, reason: 'top-3-verified' }
  }
  if (!isVerified && totalVerifiedCount < minVerifiedBackups) {
    return { shouldRetain: true, reason: 'unverified-under-threshold' }
  }
  return { shouldRetain: false, reason: 'eligible-for-purge' }
}
