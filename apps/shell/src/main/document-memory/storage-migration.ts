import { CANONICAL_SCHEMA_V3 } from './storage/schema-v3'
import { verifyDatabaseIntegrity, verifyLogicalConsistency } from './storage/migration/logical-verifier'
import { runStorageMigrationV2ToV3 } from './storage/migration/storage-migration-runner'
import type { MigrationBudgetContract } from './runtime/backup-write-budget'

export { CANONICAL_SCHEMA_V3 as SCHEMA_V3, verifyDatabaseIntegrity, verifyLogicalConsistency }

export interface StorageMigrationOptions {
  activeSpaceId: string
  activeDimensions: number
  pageSize?: number
  tempDbPath?: string
  backupDbPath?: string
  budgetBytes?: number
  settingsDir?: string
  freeDiskBytes?: number | null
  strictQuota?: boolean
  budgetContract?: MigrationBudgetContract
  onProgress?: (progress: StorageMigrationProgress) => void
  testFailureInjectionPoint?: 'before-cutover' | 'corrupt-temp' | 'verification-failed'
}

export interface StorageMigrationProgress {
  phase: 'schema' | 'documents' | 'fts' | 'cutover' | 'verified' | 'rollback'
  documentsProcessed: number
  documentsCopied: number
  documentsDropped: number
  chunksCopied: number
  embeddingsCopied: number
}

export interface StorageMigrationResult {
  success: boolean
  sourceDbPath: string
  targetDbPath: string
  backupDbPath: string
  documentsProcessed: number
  documentsCopied: number
  documentsDroppedArtifacts: number
  chunksCopied: number
  embeddingsCopied: number
  durationMs: number
  verified: boolean
}

/** Executes V2 to V3 storage migration runner (INV-01, INV-02, INV-08, INV-09). */
export function migrateStorageV2ToV3(sourceDbPath: string, options: StorageMigrationOptions): StorageMigrationResult {
  return runStorageMigrationV2ToV3(sourceDbPath, options)
}

export { runStorageMigrationV2ToV3 }
