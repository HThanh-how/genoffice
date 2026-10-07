import type { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import type { DocumentIndexStorageDiagnostics } from '../../../../shared/fork/document-index-api'
import {
  inspectPhysicalStorageState,
  type SchemaPhysicalState,
} from '../schema-inspector'

export class DiagnosticsRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly dbPath: string,
  ) {}

  getSchemaPhysicalState(): SchemaPhysicalState {
    return inspectPhysicalStorageState(this.db, this.dbPath)
  }

  getSchemaState(): SchemaPhysicalState {
    return this.getSchemaPhysicalState()
  }

  getStorageDiagnostics(backupPath?: string): DocumentIndexStorageDiagnostics {
    let activeDbSizeBytes = 0
    let walSizeBytes = 0
    let v2BackupSizeBytes: number | null = null

    try {
      if (existsSync(this.dbPath)) activeDbSizeBytes = statSync(this.dbPath).size
    } catch {
      // ignore
    }

    const walPath = `${this.dbPath}-wal`
    try {
      if (existsSync(walPath)) walSizeBytes = statSync(walPath).size
    } catch {
      // ignore
    }

    const effectiveBackupPath = backupPath ?? `${this.dbPath}.v2.backup.db`
    try {
      if (existsSync(effectiveBackupPath)) v2BackupSizeBytes = statSync(effectiveBackupPath).size
    } catch {
      // ignore
    }

    let pageSize = 4096
    let pageCount = 0
    let freelistCount = 0
    try {
      pageSize = (this.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size
      pageCount = (this.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count
      freelistCount = (this.db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count
    } catch {
      // ignore
    }
    const estimatedReclaimableBytes = freelistCount * pageSize

    const physicalState = this.getSchemaPhysicalState()

    let schemaVersionRow: { value: string } | undefined
    try {
      schemaVersionRow = this.db
        .prepare("SELECT value FROM document_memory_meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined
    } catch {
      // ignore
    }

    let schemaVersion: string
    let migrationStatus: DocumentIndexStorageDiagnostics['migrationStatus']

    switch (physicalState) {
      case 'v3':
        // Physical inspection confirmed Canonical V3 schema
        schemaVersion = schemaVersionRow?.value ?? '3'
        migrationStatus = 'completed'
        break
      case 'migration-in-progress':
        schemaVersion = 'migration-in-progress'
        migrationStatus = 'in-progress'
        break
      case 'v2':
        schemaVersion = schemaVersionRow?.value ?? 'v2'
        migrationStatus = 'none'
        break
      case 'migration-needed':
        schemaVersion = schemaVersionRow?.value ?? 'migration-needed'
        migrationStatus = 'none'
        break
      case 'corrupt':
        schemaVersion = 'corrupt'
        migrationStatus = 'none'
        break
      case 'unknown':
      default:
        schemaVersion = schemaVersionRow?.value ?? 'unknown'
        migrationStatus = 'none'
        break
    }

    let topOffendersByChunks: DocumentIndexStorageDiagnostics['topOffendersByChunks'] = []
    try {
      topOffendersByChunks = (
        this.db
          .prepare(`
            SELECT d.id, d.path, d.name, count(c.id) AS chunks, d.truncated
            FROM documents d
            JOIN chunks c ON c.document_id = d.id
            WHERE d.excluded = 0
            GROUP BY d.id
            ORDER BY chunks DESC
            LIMIT 20
          `)
          .all() as Array<{ id: number; path: string; name: string; chunks: number; truncated: number }>
      ).map((row) => ({
        id: row.id,
        path: row.path,
        name: row.name,
        chunks: row.chunks,
        truncated: !!row.truncated,
      }))
    } catch {
      // ignore
    }

    let topOffendersBySize: DocumentIndexStorageDiagnostics['topOffendersBySize'] = []
    try {
      topOffendersBySize = (
        this.db
          .prepare(`
            SELECT d.id, d.path, d.name, coalesce(d.size_bytes, 0) AS sizeBytes, d.chunk_total AS chunks
            FROM documents d
            WHERE d.excluded = 0
            ORDER BY sizeBytes DESC
            LIMIT 20
          `)
          .all() as Array<{ id: number; path: string; name: string; sizeBytes: number; chunks: number }>
      ).map((row) => ({
        id: row.id,
        path: row.path,
        name: row.name,
        sizeBytes: row.sizeBytes,
        chunks: row.chunks,
      }))
    } catch {
      // ignore
    }

    let breakdown: DocumentIndexStorageDiagnostics['breakdown']
    try {
      const dbstatRows = this.db
        .prepare('SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name')
        .all() as Array<{ name: string; bytes: number }>

      let chunksBytes = 0
      let embeddingsBytes = 0
      let ftsBytes = 0
      let documentsBytes = 0
      let ocrBytes = 0
      let otherBytes = 0

      for (const row of dbstatRows) {
        if (row.name === 'chunks' || row.name.startsWith('chunks_')) chunksBytes += row.bytes
        else if (row.name === 'chunk_embeddings' || row.name.startsWith('chunk_embeddings_')) embeddingsBytes += row.bytes
        else if (row.name.includes('fts')) ftsBytes += row.bytes
        else if (row.name === 'documents' || row.name.startsWith('documents_')) documentsBytes += row.bytes
        else if (row.name.includes('ocr')) ocrBytes += row.bytes
        else otherBytes += row.bytes
      }

      breakdown = { chunksBytes, embeddingsBytes, ftsBytes, documentsBytes, ocrBytes, otherBytes }
    } catch {
      try {
        const chunkTextBytes = (
          this.db.prepare('SELECT coalesce(sum(length(text) + length(location)), 0) AS b FROM chunks').get() as { b: number }
        ).b
        const embVectorBytes = (
          this.db.prepare('SELECT coalesce(sum(length(vector)), 0) AS b FROM chunk_embeddings').get() as { b: number }
        ).b
        const ftsTextBytes = (
          this.db.prepare('SELECT coalesce(sum(length(text)), 0) AS b FROM chunk_fts').get() as { b: number }
        ).b
        const docMetaBytes = (
          this.db.prepare('SELECT coalesce(sum(length(path) + length(name)), 0) AS b FROM documents').get() as { b: number }
        ).b
        const knownUsed = chunkTextBytes + embVectorBytes + ftsTextBytes + docMetaBytes
        breakdown = {
          chunksBytes: chunkTextBytes,
          embeddingsBytes: embVectorBytes,
          ftsBytes: ftsTextBytes,
          documentsBytes: docMetaBytes,
          ocrBytes: 0,
          otherBytes: Math.max(0, activeDbSizeBytes - knownUsed),
        }
      } catch {
        // ignore
      }
    }

    return {
      activeDbSizeBytes,
      walSizeBytes,
      pageSize,
      pageCount,
      freelistCount,
      estimatedReclaimableBytes,
      v2BackupSizeBytes,
      schemaVersion,
      migrationStatus,
      topOffendersByChunks,
      topOffendersBySize,
      ...(breakdown ? { breakdown } : {}),
    }
  }
}

export function collectStorageDiagnostics(
  db: DatabaseSync,
  dbPath: string,
  backupPath?: string,
): DocumentIndexStorageDiagnostics {
  return new DiagnosticsRepository(db, dbPath).getStorageDiagnostics(backupPath)
}
