import { DatabaseSync } from 'node:sqlite'

/**
 * Builds a legacy V2 document-memory database: the shape found on real machines (no chunk_sets, chunks carry an
 * inline `vector` / `normalized`), sized by `documents x chunksPerDocument` so a test can make the V2 -> V3
 * migration take as long as it needs to.
 */
export function buildLegacyV2Database(
  dbPath: string,
  documents: number,
  chunksPerDocument: number,
  textBytes = 1200,
): void {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, status TEXT NOT NULL,
      mtime_ms REAL, size_bytes INTEGER, hash TEXT, embedding_model TEXT, error TEXT,
      excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
      truncated INTEGER NOT NULL DEFAULT 0, truncated_reason TEXT,
      last_opened_at INTEGER NOT NULL DEFAULT 0, priority_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      chunk_total INTEGER NOT NULL DEFAULT 0, chunk_done INTEGER NOT NULL DEFAULT 0, chunk_counted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, text TEXT NOT NULL, normalized TEXT NOT NULL, location TEXT NOT NULL,
      vector BLOB, vector_dim INTEGER
    );
    CREATE VIRTUAL TABLE chunk_fts USING fts5(text);
    CREATE TABLE ocr_pages (
      path TEXT NOT NULL, page INTEGER NOT NULL, hash TEXT NOT NULL, mtime_ms REAL NOT NULL, size_bytes INTEGER NOT NULL,
      total_pages INTEGER NOT NULL, text TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (path, page)
    ) WITHOUT ROWID;
    CREATE TABLE pdf_scan_info (
      path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, size_bytes INTEGER NOT NULL, total_pages INTEGER NOT NULL, scanned TEXT NOT NULL
    ) WITHOUT ROWID;
  `)
  const insDoc = db.prepare(
    `INSERT INTO documents (id, path, name, status, mtime_ms, size_bytes, hash, chunk_total, chunk_done, chunk_counted)
     VALUES (?, ?, ?, 'ready', 1, 1, ?, ?, 0, 1)`,
  )
  const insChunk = db.prepare(
    'INSERT INTO chunks (document_id, ordinal, text, normalized, location) VALUES (?, ?, ?, ?, ?)',
  )
  const insFts = db.prepare('INSERT INTO chunk_fts(rowid, text) VALUES (?, ?)')
  const words = 'bao cao hop dong tai chinh nam hoc ke hoach thanh toan van ban quyet dinh'.split(
    ' ',
  )
  let chunkId = 0
  db.exec('BEGIN')
  for (let d = 1; d <= documents; d++) {
    insDoc.run(d, `/data/doc-${d}.txt`, `doc-${d}.txt`, `h${d}`, chunksPerDocument)
    for (let i = 0; i < chunksPerDocument; i++) {
      let text = ''
      let k = (d * 7 + i) % words.length
      while (text.length < textBytes)
        text += `${words[k++ % words.length]} ${(d * 31 + i * 17 + text.length) % 9973} `
      insChunk.run(d, i, text, text, `{"p":${i}}`)
      insFts.run(++chunkId, text)
    }
  }
  db.exec('COMMIT')
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.close()
}
