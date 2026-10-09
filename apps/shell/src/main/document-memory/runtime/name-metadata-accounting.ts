import { DatabaseSync } from 'node:sqlite'

/** Runs in the accounting worker, not in the synchronous admission path. */
export function measureNameMetadataBytes(dbPath: string, db?: DatabaseSync): number {
  const connection = db ?? new DatabaseSync(dbPath, { readOnly: true })
  try {
    // Include identity-table indexes and all FTS shadow tables. dbstat counts allocated pages,
    // including partially empty pages: logical string lengths would undercount real storage.
    const row = connection.prepare(`
      SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat
      WHERE name IN (
        SELECT name FROM sqlite_schema
        WHERE tbl_name = 'documents' OR tbl_name = 'document_name_projection'
          OR name = 'document_name_projection_fts'
          OR name GLOB 'document_name_projection_fts_*'
          OR name = 'document_name_fts' OR name GLOB 'document_name_fts_*'
      )
    `).get() as { bytes: number }
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0) throw new Error('Invalid name metadata page measurement')
    return row.bytes
  } finally {
    if (!db) connection.close()
  }
}
