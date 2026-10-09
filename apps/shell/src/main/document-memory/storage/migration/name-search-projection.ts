import type { DatabaseSync } from 'node:sqlite'
import {
  CREATE_NAME_SEARCH_PROJECTION_SQL,
  hasNameProjection,
  hasRowVersionColumn,
  initNameProjectionMetaState,
  getNameProjectionMetaState,
  CURRENT_NAME_PROJECTION_ALGORITHM_VERSION,
} from '../../name-search-projection'

export const NAME_SEARCH_PROJECTION_MIGRATION_ID = '20261008_name_search_projection'

export interface NameSearchProjectionMigrationResult {
  applied: boolean
  alreadyApplied: boolean
  tableCreated: boolean
  ftsCreated: boolean
  triggersCreated: boolean
  targetVersion?: number
  completedVersion?: number
  status?: string
  error?: string
}

/**
 * Enterprise Name Search Projection Schema Migration Hook.
 *
 * Safe, idempotent migration designed for candidate retrieval hardening.
 * Does NOT perform synchronous full backfill on startup to avoid blocking.
 * Integrator wires this during bootstrap/cutover alongside other migrations.
 */
export function migrateNameSearchProjection(db: DatabaseSync): NameSearchProjectionMigrationResult {
  try {
    // 1. Check if documents table exists
    const hasDocumentsTable = Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents'").get(),
    )
    if (!hasDocumentsTable) {
      return {
        applied: false,
        alreadyApplied: false,
        tableCreated: false,
        ftsCreated: false,
        triggersCreated: false,
        error: "Table 'documents' does not exist yet",
      }
    }

    // 2. Check if already applied with current algorithm version
    const metaBefore = getNameProjectionMetaState(db)
    const alreadyApplied =
      hasNameProjection(db) &&
      metaBefore.completedVersion >= CURRENT_NAME_PROJECTION_ALGORITHM_VERSION &&
      metaBefore.status === 'completed'

    // 3. Owned migration wrapped in savepoint to guarantee atomic initialization or rollback
    db.exec('SAVEPOINT name_search_projection_migration')
    try {
      db.exec(CREATE_NAME_SEARCH_PROJECTION_SQL)

      // Add row_version column additively if missing on pre-existing legacy table
      if (!hasRowVersionColumn(db)) {
        db.exec('ALTER TABLE document_name_projection ADD COLUMN row_version INTEGER DEFAULT 1')
      }

      // 4. Record migration in schema_migrations if available
      const hasSchemaMigrations = Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get(),
      )
      if (hasSchemaMigrations) {
        db.prepare(`
          INSERT INTO schema_migrations (id, applied_at)
          VALUES (?, unixepoch())
          ON CONFLICT(id) DO NOTHING;
        `).run(NAME_SEARCH_PROJECTION_MIGRATION_ID)
      }

      // 5. Version and rebuild state detection in document_memory_meta (propagate failure on error)
      initNameProjectionMetaState(db)

      db.exec('RELEASE name_search_projection_migration')
    } catch (migErr) {
      try {
        db.exec('ROLLBACK TO name_search_projection_migration')
        db.exec('RELEASE name_search_projection_migration')
      } catch {
        // preserve original error
      }
      throw migErr
    }

    const metaAfter = getNameProjectionMetaState(db)

    return {
      applied: true,
      alreadyApplied,
      tableCreated: true,
      ftsCreated: true,
      triggersCreated: true,
      targetVersion: CURRENT_NAME_PROJECTION_ALGORITHM_VERSION,
      completedVersion: metaAfter.completedVersion,
      status: metaAfter.status,
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return {
      applied: false,
      alreadyApplied: false,
      tableCreated: false,
      ftsCreated: false,
      triggersCreated: false,
      error: errorMsg,
    }
  }
}
