import type { DatabaseSync } from 'node:sqlite'

export interface SeedOptions {
  docs: number
  /** every n-th document gets a junk name (`~$...`); 0 = none */
  junkEvery?: number
  chunksPerDoc?: number
  /** documents the user opened (never purged, whatever their name) */
  openedEvery?: number
  /** root folder of the fake paths */
  root?: string
}

/**
 * Fills a V3 document-memory database with documents, chunk sets, chunks, full-text rows and vectors by plain SQL
 * (fast enough for thousands of documents). Everything a delete has to clean up is present.
 */
export function seedDocuments(
  db: DatabaseSync,
  options: SeedOptions,
): { junk: number; ids: number[] } {
  const perDoc = options.chunksPerDoc ?? 2
  const root = options.root ?? '/seed'
  db.exec(
    `INSERT OR IGNORE INTO embedding_spaces(id, model_repo, model_revision, pooling, dimensions, quantization)
     VALUES ('seed-space', 'seed', 'r', 'mean', 8, 'q8')`,
  )
  const insDoc = db.prepare(
    `INSERT INTO documents(path, name, status, mtime_ms, size_bytes, hash, embedding_model, last_opened_at, chunk_done, chunk_counted)
     VALUES (?, ?, 'ready', 1, 100, ?, 'seed-space', ?, ?, 1)`,
  )
  const insSet = db.prepare(
    `INSERT INTO chunk_sets(document_id, chunker_version, state) VALUES (?, 1, 'active')`,
  )
  const insChunk = db.prepare(
    'INSERT INTO chunks(document_id, chunk_set_id, ordinal, text, location) VALUES (?, ?, ?, ?, ?)',
  )
  const insFts = db.prepare('INSERT INTO chunk_fts(rowid, text) VALUES (?, ?)')
  const insEmb = db.prepare(
    `INSERT INTO chunk_embeddings(chunk_id, space_id, vector, vector_dim) VALUES (?, 'seed-space', ?, 8)`,
  )
  const insCount = db.prepare(
    `INSERT INTO document_embedding_counts(document_id, space_id, completed_chunks) VALUES (?, 'seed-space', ?)`,
  )
  const vector = new Uint8Array(8)
  let junk = 0
  const ids: number[] = []
  db.exec('BEGIN')
  for (let i = 0; i < options.docs; i++) {
    const isJunk = options.junkEvery ? i % options.junkEvery === 0 : false
    const opened = options.openedEvery ? i % options.openedEvery === 0 : false
    const name = isJunk ? `~$draft-${i}.docx` : `report-${i}.docx`
    if (isJunk && !opened) junk++
    const id = Number(
      insDoc.run(`${root}/${i % 20}/${name}`, name, `h${i}`, opened ? 5 : 0, perDoc)
        .lastInsertRowid,
    )
    ids.push(id)
    const setId = Number(insSet.run(id).lastInsertRowid)
    for (let c = 0; c < perDoc; c++) {
      const chunkId = Number(
        insChunk.run(id, setId, c, `text of ${name} part ${c}`, `p${c}`).lastInsertRowid,
      )
      insFts.run(chunkId, `text of ${name} part ${c}`)
      insEmb.run(chunkId, vector)
    }
    insCount.run(id, perDoc)
    db.prepare('UPDATE documents SET active_chunk_set_id = ? WHERE id = ?').run(setId, id)
  }
  db.exec('COMMIT')
  return { junk, ids }
}
