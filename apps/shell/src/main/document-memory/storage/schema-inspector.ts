import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'

export interface StorageVersionReport {
  isV3: boolean
  needsMigration: boolean
  reasons: string[]
  tableNames: string[]
  hasObsoleteChunkColumns: boolean
  hasDocumentEmbeddingCounts: boolean
  autoVacuum: number
}

/**
 * Inspects a database file and determines whether it conforms to Canonical Schema V3.
 */
export function inspectDatabaseVersion(dbPath: string): StorageVersionReport {
  if (!existsSync(dbPath)) {
    return {
      isV3: false,
      needsMigration: false,
      reasons: ['Database file does not exist'],
      tableNames: [],
      hasObsoleteChunkColumns: false,
      hasDocumentEmbeddingCounts: false,
      autoVacuum: 0,
    }
  }

  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath)
  } catch (err: any) {
    return {
      isV3: false,
      needsMigration: true,
      reasons: [`Database corrupted or invalid: ${err?.message}`],
      tableNames: [],
      hasObsoleteChunkColumns: false,
      hasDocumentEmbeddingCounts: false,
      autoVacuum: 0,
    }
  }

  try {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string
      }>
    ).map((r) => r.name)

    const reasons: string[] = []
    let hasObsoleteChunkColumns = false
    let hasDocumentEmbeddingCounts = tables.includes('document_embedding_counts')

    if (tables.includes('chunks')) {
      const chunkColumns = (
        db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>
      ).map((c) => c.name)

      if (chunkColumns.includes('vector')) {
        hasObsoleteChunkColumns = true
        reasons.push('chunks table contains obsolete "vector" column (V2 layout)')
      }
      if (chunkColumns.includes('vector_dim')) {
        hasObsoleteChunkColumns = true
        reasons.push('chunks table contains obsolete "vector_dim" column (V2 layout)')
      }
      if (chunkColumns.includes('normalized')) {
        hasObsoleteChunkColumns = true
        reasons.push('chunks table contains obsolete "normalized" column (V2 layout)')
      }
    } else {
      reasons.push('chunks table is missing')
    }

    if (!hasDocumentEmbeddingCounts) {
      reasons.push('document_embedding_counts table is missing')
    }

    const autoVacuumRow = db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number } | undefined
    const autoVacuum = autoVacuumRow?.auto_vacuum ?? 0
    if (autoVacuum !== 2) {
      reasons.push(`PRAGMA auto_vacuum is ${autoVacuum} (expected 2 for INCREMENTAL)`)
    }

    const needsMigration = hasObsoleteChunkColumns || !hasDocumentEmbeddingCounts || autoVacuum !== 2
    const isV3 = !needsMigration && tables.includes('documents') && tables.includes('chunks')

    return {
      isV3,
      needsMigration,
      reasons,
      tableNames: tables,
      hasObsoleteChunkColumns,
      hasDocumentEmbeddingCounts,
      autoVacuum,
    }
  } finally {
    db.close()
  }
}
