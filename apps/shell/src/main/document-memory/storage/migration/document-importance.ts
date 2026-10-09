import type { DatabaseSync } from 'node:sqlite'

/**
 * Idempotent migration for document importance columns.
 * Safely adds:
 * - importance_override ('auto' | 'important' | 'low') default 'auto'
 * - importance_suggestion ('unknown' | 'normal' | 'important') default 'unknown'
 * - importance_reason TEXT nullable
 * - importance_updated_at INTEGER default 0
 *
 * Preserves all document records, chunks, embeddings, OCR data, and user choices.
 * Safe to rerun repeatedly.
 */
export function migrateDocumentImportance(db: DatabaseSync): boolean {
  const hasDocuments = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents'").get(),
  )
  if (!hasDocuments) return false

  const columns = (
    db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>
  ).map((c) => c.name)

  let altered = false

  if (!columns.includes('importance_override')) {
    db.exec(
      "ALTER TABLE documents ADD COLUMN importance_override TEXT NOT NULL DEFAULT 'auto' CHECK (importance_override IN ('auto', 'important', 'low'));",
    )
    altered = true
  }

  if (!columns.includes('importance_suggestion')) {
    db.exec(
      "ALTER TABLE documents ADD COLUMN importance_suggestion TEXT NOT NULL DEFAULT 'unknown' CHECK (importance_suggestion IN ('unknown', 'normal', 'important'));",
    )
    altered = true
  }

  if (!columns.includes('importance_reason')) {
    db.exec('ALTER TABLE documents ADD COLUMN importance_reason TEXT;')
    altered = true
  }

  if (!columns.includes('importance_updated_at')) {
    db.exec('ALTER TABLE documents ADD COLUMN importance_updated_at INTEGER NOT NULL DEFAULT 0;')
    altered = true
  }

  try {
    db.exec('CREATE INDEX IF NOT EXISTS documents_importance ON documents(importance_override, importance_suggestion);')
  } catch {
    // Non-fatal if index creation fails
  }

  return altered
}
