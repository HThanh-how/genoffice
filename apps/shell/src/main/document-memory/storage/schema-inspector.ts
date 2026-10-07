import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type SchemaPhysicalState =
  | 'v2'
  | 'v3'
  | 'migration-needed'
  | 'migration-in-progress'
  | 'unknown'
  | 'corrupt'

export type SchemaState = SchemaPhysicalState

export interface StorageVersionReport {
  isV3: boolean
  needsMigration: boolean
  state: SchemaPhysicalState
  schemaState: SchemaPhysicalState
  reasons: string[]
  tableNames: string[]
  hasObsoleteChunkColumns: boolean
  hasDocumentEmbeddingCounts: boolean
  autoVacuum: number
}

interface InspectHandleResult {
  state: SchemaPhysicalState
  reasons: string[]
  tableNames: string[]
  hasObsoleteChunkColumns: boolean
  hasDocumentEmbeddingCounts: boolean
  autoVacuum: number
}

function checkMigrationInProgressOnDisk(dbPath: string): boolean {
  try {
    const dir = dirname(dbPath)
    const manifestPath = join(dir, 'document-memory.migration-state.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (manifest.phase !== 'completed') {
          return true
        }
      } catch {
        return true
      }
    }
    if (
      existsSync(`${dbPath}.v3.tmp.db`) ||
      existsSync(`${dbPath}.v3.tmp`) ||
      existsSync(`${dbPath}.migrating`)
    ) {
      return true
    }
  } catch {
    // ignore
  }
  return false
}

function inspectDatabaseHandle(db: DatabaseSync, dbPath?: string): InspectHandleResult {
  if (dbPath && checkMigrationInProgressOnDisk(dbPath)) {
    return {
      state: 'migration-in-progress',
      reasons: ['Storage migration cutover or temporary database in progress on disk'],
      tableNames: [],
      hasObsoleteChunkColumns: false,
      hasDocumentEmbeddingCounts: false,
      autoVacuum: 0,
    }
  }

  try {
    const quickCheckRow = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined
    if (quickCheckRow?.quick_check !== 'ok') {
      return {
        state: 'corrupt',
        reasons: [`Database corrupted: quick_check returned ${quickCheckRow?.quick_check ?? 'failed'}`],
        tableNames: [],
        hasObsoleteChunkColumns: false,
        hasDocumentEmbeddingCounts: false,
        autoVacuum: 0,
      }
    }
  } catch (err: any) {
    return {
      state: 'corrupt',
      reasons: [`Database corrupted or invalid: ${err?.message}`],
      tableNames: [],
      hasObsoleteChunkColumns: false,
      hasDocumentEmbeddingCounts: false,
      autoVacuum: 0,
    }
  }

  let tables: string[] = []
  try {
    tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string
      }>
    ).map((r) => r.name)
  } catch (err: any) {
    return {
      state: 'corrupt',
      reasons: [`Database corrupted or invalid: ${err?.message}`],
      tableNames: [],
      hasObsoleteChunkColumns: false,
      hasDocumentEmbeddingCounts: false,
      autoVacuum: 0,
    }
  }

  if (tables.length === 0) {
    return {
      state: 'unknown',
      reasons: ['Database contains no tables'],
      tableNames: [],
      hasObsoleteChunkColumns: false,
      hasDocumentEmbeddingCounts: false,
      autoVacuum: 0,
    }
  }

  const reasons: string[] = []
  let hasObsoleteChunkColumns = false
  const hasDocumentEmbeddingCounts = tables.includes('document_embedding_counts')
  const hasChunkEmbeddings = tables.includes('chunk_embeddings')

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

  if (!hasChunkEmbeddings && tables.includes('chunks')) {
    reasons.push('chunk_embeddings table is missing (V2 vector storage layout)')
  }

  const autoVacuumRow = db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number } | undefined
  const autoVacuum = autoVacuumRow?.auto_vacuum ?? 0
  if (autoVacuum !== 2) {
    reasons.push(`PRAGMA auto_vacuum is ${autoVacuum} (expected 2 for INCREMENTAL)`)
  }

  const isV2 = hasObsoleteChunkColumns || (!hasChunkEmbeddings && tables.includes('chunks'))
  const isV3 =
    !hasObsoleteChunkColumns &&
    hasChunkEmbeddings &&
    hasDocumentEmbeddingCounts &&
    autoVacuum === 2 &&
    tables.includes('documents') &&
    tables.includes('chunks')

  let state: SchemaPhysicalState
  if (isV3) {
    state = 'v3'
  } else if (isV2) {
    state = 'v2'
  } else if (tables.includes('documents') || tables.includes('chunks')) {
    state = 'migration-needed'
  } else {
    state = 'unknown'
  }

  return {
    state,
    reasons,
    tableNames: tables,
    hasObsoleteChunkColumns,
    hasDocumentEmbeddingCounts,
    autoVacuum,
  }
}

/**
 * Inspects physical storage state of a database connection or file path.
 */
export function inspectPhysicalStorageState(
  dbOrPath: DatabaseSync | string,
  dbPath?: string,
): SchemaPhysicalState {
  if (typeof dbOrPath === 'string') {
    if (!existsSync(dbOrPath)) {
      return 'unknown'
    }
    if (checkMigrationInProgressOnDisk(dbOrPath)) {
      return 'migration-in-progress'
    }
    let db: DatabaseSync
    try {
      db = new DatabaseSync(dbOrPath)
    } catch {
      return 'corrupt'
    }
    try {
      return inspectDatabaseHandle(db, dbOrPath).state
    } finally {
      try {
        db.close()
      } catch {
        // ignore
      }
    }
  }

  return inspectDatabaseHandle(dbOrPath, dbPath).state
}

export const inspectSchemaState = inspectPhysicalStorageState

/**
 * Inspects a database file and determines whether it conforms to Canonical Schema V3.
 */
export function inspectDatabaseVersion(dbPath: string): StorageVersionReport {
  if (!existsSync(dbPath)) {
    return {
      isV3: false,
      needsMigration: false,
      state: 'unknown',
      schemaState: 'unknown',
      reasons: ['Database file does not exist'],
      tableNames: [],
      hasObsoleteChunkColumns: false,
      hasDocumentEmbeddingCounts: false,
      autoVacuum: 0,
    }
  }

  if (checkMigrationInProgressOnDisk(dbPath)) {
    return {
      isV3: false,
      needsMigration: true,
      state: 'migration-in-progress',
      schemaState: 'migration-in-progress',
      reasons: ['Storage migration cutover or temporary database in progress'],
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
      state: 'corrupt',
      schemaState: 'corrupt',
      reasons: [`Database corrupted or invalid: ${err?.message}`],
      tableNames: [],
      hasObsoleteChunkColumns: false,
      hasDocumentEmbeddingCounts: false,
      autoVacuum: 0,
    }
  }

  try {
    const inspected = inspectDatabaseHandle(db, dbPath)
    const isV3 = inspected.state === 'v3'
    const needsMigration =
      inspected.state === 'corrupt' ||
      inspected.state === 'v2' ||
      inspected.state === 'migration-needed' ||
      inspected.state === 'migration-in-progress'

    return {
      isV3,
      needsMigration,
      state: inspected.state,
      schemaState: inspected.state,
      reasons: inspected.reasons,
      tableNames: inspected.tableNames,
      hasObsoleteChunkColumns: inspected.hasObsoleteChunkColumns,
      hasDocumentEmbeddingCounts: inspected.hasDocumentEmbeddingCounts,
      autoVacuum: inspected.autoVacuum,
    }
  } finally {
    try {
      db.close()
    } catch {
      // ignore
    }
  }
}
