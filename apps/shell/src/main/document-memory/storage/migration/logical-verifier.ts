import { DatabaseSync } from 'node:sqlite'

export interface IntegrityCheckResult {
  ok: boolean
  integrity: string
  foreignKeyErrors: unknown[]
}

/**
 * Runs physical integrity checks on a SQLite database file:
 * - PRAGMA integrity_check === 'ok'
 * - PRAGMA foreign_key_check returns 0 errors
 */
export function verifyDatabaseIntegrity(dbOrPath: string | DatabaseSync): IntegrityCheckResult {
  const isPath = typeof dbOrPath === 'string'
  const db = isPath ? new DatabaseSync(dbOrPath) : dbOrPath
  try {
    const integrityRow = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
    const integrity = integrityRow?.integrity_check ?? 'unknown'
    const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all()
    const ok = integrity === 'ok' && foreignKeyErrors.length === 0
    return { ok, integrity, foreignKeyErrors }
  } finally {
    if (isPath) {
      db.close()
    }
  }
}

export interface LogicalConsistencyResult {
  ok: boolean
  reasons: string[]
  expectedDocuments: number
  actualDocuments: number
  actualChunks: number
}

/**
 * Validates logical consistency after migration (INV-09).
 */
export function verifyLogicalConsistency(
  targetDb: DatabaseSync,
  expectedDocuments: number,
  expectedChunks: number,
): LogicalConsistencyResult {
  const reasons: string[] = []
  const docCountRow = targetDb.prepare('SELECT count(*) AS n FROM documents').get() as { n: number }
  const actualDocs = docCountRow.n

  const chunkCountRow = targetDb.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }
  const actualChunks = chunkCountRow.n

  if (actualDocs !== expectedDocuments) {
    reasons.push(`Document count mismatch: expected ${expectedDocuments}, got ${actualDocs}`)
  }

  if (actualChunks !== expectedChunks) {
    reasons.push(`Chunk count mismatch: expected ${expectedChunks}, got ${actualChunks}`)
  }

  return {
    ok: reasons.length === 0,
    reasons,
    expectedDocuments,
    actualDocuments: actualDocs,
    actualChunks,
  }
}
