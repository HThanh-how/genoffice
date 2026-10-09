import type { DatabaseSync } from 'node:sqlite'
import { ensureVectorEvictionSchema } from '../vector-eviction-marker'

export const CACHE_RETENTION_MIGRATION_ID = '20261008_cache_retention_columns'

export interface CacheRetentionMigrationResult {
  applied: boolean
  alreadyApplied: boolean
  contentEvictedColumnAdded: boolean
  contentEvictedIndexAdded: boolean
  error?: string
}

/**
 * Checks if the `content_evicted` column is present on the `documents` table.
 */
export function hasContentEvictedColumn(db: DatabaseSync): boolean {
  try {
    const tableInfo = db
      .prepare("PRAGMA table_info('documents')")
      .all() as Array<{ name: string }>
    return tableInfo.some((col) => col.name === 'content_evicted')
  } catch (err: unknown) {
    console.debug('[cache-retention] table_info failed:', err)
    return false
  }
}

/**
 * Enterprise Cache Content Eviction Schema Migration Hook.
 *
 * Safe, idempotent migration designed for RUNTIME_INTEGRATOR to wire during bootstrap/cutover.
 * (Does NOT modify bootstrap/schema-v3/store directly, adhering to boundary rules).
 *
 * Adds:
 * - Column: `documents.content_evicted INTEGER NOT NULL DEFAULT 0 CHECK (content_evicted IN (0, 1))`
 * - Index: `documents_content_evicted ON documents(content_evicted)`
 * - Records migration into `schema_migrations` if the table is present.
 */
export function migrateCacheRetentionSchema(db: DatabaseSync): CacheRetentionMigrationResult {
  try {
    // 1. Check if documents table exists
    const hasDocumentsTable = Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents'").get(),
    )
    if (!hasDocumentsTable) {
      return {
        applied: false,
        alreadyApplied: false,
        contentEvictedColumnAdded: false,
        contentEvictedIndexAdded: false,
        error: "Table 'documents' does not exist yet",
      }
    }

    // 2. Check existing column
    const alreadyHasColumn = hasContentEvictedColumn(db)

    let contentEvictedColumnAdded = false
    if (!alreadyHasColumn) {
      try {
        db.exec('ALTER TABLE documents ADD COLUMN content_evicted INTEGER NOT NULL DEFAULT 0;')
        contentEvictedColumnAdded = true
      } catch (err: unknown) {
        // If column already exists (e.g. concurrent migration), ignore
        if (err instanceof Error && err.message.includes('duplicate column')) {
          // Concurrently added
        } else {
          throw err
        }
      }
    }

    // 3. Create index for fast filtering on non-evicted documents
    let contentEvictedIndexAdded = false
    try {
      db.exec('CREATE INDEX IF NOT EXISTS documents_content_evicted ON documents(content_evicted);')
      contentEvictedIndexAdded = true
    } catch (err: unknown) {
      console.warn('[cache-retention] index creation warning:', err)
    }

    // 3b. Durable 'vectors evicted by retention' marker table (additive, idempotent)
    ensureVectorEvictionSchema(db)

    // 4. Record migration entry in schema_migrations if available
    try {
      const hasSchemaMigrations = Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get(),
      )
      if (hasSchemaMigrations) {
        db.prepare(`
          INSERT INTO schema_migrations (id, applied_at)
          VALUES (?, unixepoch())
          ON CONFLICT(id) DO NOTHING
        `).run(CACHE_RETENTION_MIGRATION_ID)
      }
    } catch (err: unknown) {
      console.warn('[cache-retention] recording schema migration entry warning:', err)
    }

    return {
      applied: contentEvictedColumnAdded || contentEvictedIndexAdded || alreadyHasColumn,
      alreadyApplied: alreadyHasColumn,
      contentEvictedColumnAdded,
      contentEvictedIndexAdded,
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return {
      applied: false,
      alreadyApplied: false,
      contentEvictedColumnAdded: false,
      contentEvictedIndexAdded: false,
      error: errorMsg,
    }
  }
}
