import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

function floatBlob(vector, dim = 320) {
  const f32 = new Float32Array(dim)
  if (Array.isArray(vector)) {
    for (let i = 0; i < vector.length && i < dim; i++) f32[i] = vector[i]
  }
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
}

export function generateSyntheticFixture(options = {}) {
  const profile = options.profile || 'small'
  const outPath = resolve(options.out || './synthetic-document-memory.db')

  if (existsSync(outPath)) {
    try {
      unlinkSync(outPath)
    } catch {
      // ignore
    }
  }

  const dir = dirname(outPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const db = new DatabaseSync(outPath)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE documents (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      mtime_ms REAL,
      size_bytes INTEGER,
      hash TEXT,
      embedding_model TEXT,
      active_chunk_set_id INTEGER,
      error TEXT,
      excluded INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0,
      truncated_reason TEXT,
      last_opened_at INTEGER NOT NULL DEFAULT 0,
      priority_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      chunk_total INTEGER NOT NULL DEFAULT 0,
      chunk_done INTEGER NOT NULL DEFAULT 0,
      chunk_counted INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE embedding_spaces (
      id TEXT PRIMARY KEY,
      model_repo TEXT NOT NULL,
      model_revision TEXT NOT NULL,
      pooling TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      quantization TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE chunk_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunker_version INTEGER NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_set_id INTEGER REFERENCES chunk_sets(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      text TEXT NOT NULL,
      normalized TEXT,
      location TEXT NOT NULL,
      vector BLOB,
      vector_dim INTEGER
    );

    CREATE TABLE chunk_embeddings (
      chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      space_id TEXT NOT NULL REFERENCES embedding_spaces(id) ON DELETE CASCADE,
      vector BLOB NOT NULL,
      vector_dim INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (chunk_id, space_id)
    );

    CREATE VIRTUAL TABLE chunk_fts USING fts5(text, tokenize='unicode61 remove_diacritics 2');

    CREATE TABLE ocr_pages (
      path TEXT NOT NULL,
      page INTEGER NOT NULL,
      hash TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
      size_bytes INTEGER NOT NULL,
      total_pages INTEGER NOT NULL,
      text TEXT NOT NULL,
      model TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (path, page)
    ) WITHOUT ROWID;

    CREATE TABLE pdf_scan_info (
      path TEXT PRIMARY KEY,
      mtime_ms REAL NOT NULL,
      size_bytes INTEGER NOT NULL,
      total_pages INTEGER NOT NULL,
      scanned TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE ann_indexes (
      space_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL DEFAULT 0,
      desired_generation INTEGER NOT NULL DEFAULT 0,
      file_path TEXT,
      indexed_count INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'ready',
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)

  // Add default embedding spaces
  db.prepare(
    `
    INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
    VALUES
      ('standard', 'genoffice/F2LLM-v2-80M-ONNX', 'ad88d7a126', 'last-token', 320, 'q8'),
      ('high', 'Qwen/Qwen3-Embedding-0.6B', 'bd58e9fd4b', 'last-token', 512, 'q8')
  `,
  ).run()

  const insertDoc = db.prepare(`
    INSERT INTO documents (
      id, path, name, status, mtime_ms, size_bytes, hash, embedding_model,
      active_chunk_set_id, error, excluded, truncated, truncated_reason,
      last_opened_at, priority_at, chunk_total, chunk_done
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const insertSet = db.prepare(`
    INSERT INTO chunk_sets (id, document_id, chunker_version, state)
    VALUES (?, ?, 2, ?)
  `)

  const insertChunk = db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, normalized, location, vector, vector_dim)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const insertFts = db.prepare('INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)')

  const insertEmbedding = db.prepare(`
    INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
    VALUES (?, ?, ?, ?)
  `)

  let docIdSeq = 1
  let chunkIdSeq = 1
  let setIdSeq = 1

  db.exec('BEGIN IMMEDIATE')

  if (profile === 'pathological') {
    // 1. Obsolete embedding space
    db.prepare(
      `
      INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES ('obsolete-e5', 'Xenova/multilingual-e5-small', 'rev-old', 'mean', 384, 'q8')
    `,
    ).run()

    // 2. 10 Chromium license files inside build output (Case B: Auto-discovered artifact)
    for (let i = 1; i <= 10; i++) {
      const docId = docIdSeq++
      const setId = setIdSeq++
      const p = `D:/work/build/win-unpacked/resources/LICENSES.chromium_${i}.html`
      insertDoc.run(
        docId,
        p,
        `LICENSES.chromium_${i}.html`,
        'ready',
        1000,
        500000,
        `hash-lic-${i}`,
        'standard',
        setId,
        null,
        0,
        1,
        'chunk-limit',
        0,
        1000,
        20,
        20,
      )
      insertSet.run(setId, docId, 'active')
      for (let c = 0; c < 20; c++) {
        const chunkId = chunkIdSeq++
        const txt = `Chromium license chunk ${c} terms for index item ${i}`
        const v = floatBlob([0.1, 0.2], 320)
        insertChunk.run(chunkId, docId, setId, c, txt, txt, `Chunk ${c + 1}`, v, 320)
        insertFts.run(chunkId, txt)
        insertEmbedding.run(chunkId, 'standard', v, 320)
      }
    }

    // 3. User-opened Chromium license (Case C: User intent preserved)
    const userOpenedDocId = docIdSeq++
    const userOpenedSetId = setIdSeq++
    const userPath = 'D:/work/project/LICENSES.chromium.html'
    insertDoc.run(
      userOpenedDocId,
      userPath,
      'LICENSES.chromium.html',
      'ready',
      2000,
      40000,
      'hash-user-lic',
      'standard',
      userOpenedSetId,
      null,
      0,
      0,
      null,
      1710000000,
      1710000000,
      5,
      5,
    )
    insertSet.run(userOpenedSetId, userOpenedDocId, 'active')
    for (let c = 0; c < 5; c++) {
      const chunkId = chunkIdSeq++
      const txt = `User explicitly opened license passage ${c}`
      const v = floatBlob([0.3, 0.4], 320)
      insertChunk.run(
        chunkId,
        userOpenedDocId,
        userOpenedSetId,
        c,
        txt,
        txt,
        `Chunk ${c + 1}`,
        v,
        320,
      )
      insertFts.run(chunkId, txt)
      insertEmbedding.run(chunkId, 'standard', v, 320)
    }

    // 4. Document with Retired and Active chunk sets
    const multiSetDocId = docIdSeq++
    const retiredSetId = setIdSeq++
    const activeSetId = setIdSeq++
    insertDoc.run(
      multiSetDocId,
      'D:/docs/contract.docx',
      'contract.docx',
      'ready',
      3000,
      80000,
      'hash-contract',
      'standard',
      activeSetId,
      null,
      0,
      0,
      null,
      1700000000,
      1700000000,
      3,
      3,
    )
    insertSet.run(retiredSetId, multiSetDocId, 'retired')
    insertSet.run(activeSetId, multiSetDocId, 'active')

    // Chunks in retired set (must be discarded by V3 migration)
    for (let c = 0; c < 3; c++) {
      const chunkId = chunkIdSeq++
      const txt = `Old contract draft chunk ${c}`
      insertChunk.run(
        chunkId,
        multiSetDocId,
        retiredSetId,
        c,
        txt,
        txt,
        `Chunk ${c + 1}`,
        null,
        null,
      )
      insertFts.run(chunkId, txt)
    }

    // Chunks in active set (must be kept by V3 migration)
    for (let c = 0; c < 3; c++) {
      const chunkId = chunkIdSeq++
      const txt = `Final approved contract clause ${c}`
      const v = floatBlob([0.5, 0.6], 320)
      insertChunk.run(chunkId, multiSetDocId, activeSetId, c, txt, txt, `Chunk ${c + 1}`, v, 320)
      insertFts.run(chunkId, txt)
      insertEmbedding.run(chunkId, 'standard', v, 320)
    }

    // 5. Excluded document
    const excludedDocId = docIdSeq++
    insertDoc.run(
      excludedDocId,
      'D:/secret/financials.xlsx',
      'financials.xlsx',
      'ready',
      4000,
      10000,
      'hash-fin',
      'standard',
      null,
      null,
      1,
      0,
      null,
      0,
      0,
      0,
      0,
    )

    // 6. OCR PDF document
    const ocrDocId = docIdSeq++
    const ocrSetId = setIdSeq
    const ocrPath = 'D:/scans/invoice_scan.pdf'
    insertDoc.run(
      ocrDocId,
      ocrPath,
      'invoice_scan.pdf',
      'ready',
      5000,
      120000,
      'hash-scan',
      'standard',
      ocrSetId,
      null,
      0,
      0,
      null,
      1715000000,
      1715000000,
      2,
      2,
    )
    insertSet.run(ocrSetId, ocrDocId, 'active')
    for (let c = 0; c < 2; c++) {
      const chunkId = chunkIdSeq++
      const txt = `OCR transcribed scan total amount $${(c + 1) * 1000}`
      insertChunk.run(chunkId, ocrDocId, ocrSetId, c, txt, txt, `[OCR:p${c + 1}]`, null, null)
      insertFts.run(chunkId, txt)
    }
    db.prepare(
      `
      INSERT INTO ocr_pages (path, page, hash, mtime_ms, size_bytes, total_pages, text)
      VALUES (?, 1, 'h1', 5000, 120000, 2, 'OCR transcribed scan total amount $1000')
    `,
    ).run(ocrPath)
    db.prepare(
      `
      INSERT INTO pdf_scan_info (path, mtime_ms, size_bytes, total_pages, scanned)
      VALUES (?, 5000, 120000, 2, 'scanned')
    `,
    ).run(ocrPath)
  } else {
    // Normal small / medium / large generation
    const docCount = profile === 'large' ? 1000 : profile === 'medium' ? 100 : 10
    const chunksPerDoc = profile === 'large' ? 10 : 8

    for (let i = 1; i <= docCount; i++) {
      const docId = docIdSeq++
      const setId = setIdSeq++
      const p = `D:/corpus/document_${i}.docx`
      insertDoc.run(
        docId,
        p,
        `document_${i}.docx`,
        'ready',
        1000 + i,
        5000,
        `hash-${i}`,
        'standard',
        setId,
        null,
        0,
        0,
        null,
        1700000000 + i,
        1700000000 + i,
        chunksPerDoc,
        chunksPerDoc,
      )
      insertSet.run(setId, docId, 'active')

      for (let c = 0; c < chunksPerDoc; c++) {
        const chunkId = chunkIdSeq++
        const txt = `Document ${i} paragraph ${c} content on enterprise retrieval performance`
        const v = floatBlob([0.1 * (i % 5), 0.2 * (c % 5)], 320)
        insertChunk.run(chunkId, docId, setId, c, txt, txt, `Chunk ${c + 1}`, v, 320)
        insertFts.run(chunkId, txt)
        insertEmbedding.run(chunkId, 'standard', v, 320)
      }
    }
  }

  db.exec('COMMIT')
  db.close()

  return {
    path: outPath,
    profile,
    documents: docIdSeq - 1,
    chunks: chunkIdSeq - 1,
  }
}

if (process.argv[1] && process.argv[1].endsWith('document-memory-fixture.mjs')) {
  const profileArg =
    process.argv.find((a) => a.startsWith('--profile='))?.split('=')[1] || 'pathological'
  const outArg =
    process.argv.find((a) => a.startsWith('--out='))?.split('=')[1] || './test-fixture.db'
  const res = generateSyntheticFixture({ profile: profileArg, out: outArg })
  console.log(
    `Generated fixture: profile=${res.profile}, docs=${res.documents}, chunks=${res.chunks}, file=${res.path}`,
  )
}
