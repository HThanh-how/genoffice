import { DatabaseSync } from 'node:sqlite'
import { statSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

export function runBenchmark(options = {}) {
  const dbPath = resolve(options.db || './test-fixture.db')
  if (!existsSync(dbPath)) {
    throw new Error(`Benchmark database not found at: ${dbPath}`)
  }

  const dbBytes = statSync(dbPath).size
  const db = new DatabaseSync(dbPath, { readOnly: true })

  // Corpus counts
  const docRow = db.prepare('SELECT count(*) as c FROM documents').get()
  const documents = docRow?.c ?? 0

  const chunkRow = db.prepare('SELECT count(*) as c FROM chunks').get()
  const chunks = chunkRow?.c ?? 0

  let vectors
  try {
    const vecRow = db.prepare('SELECT count(*) as c FROM chunk_embeddings').get()
    vectors = vecRow?.c ?? 0
  } catch {
    // fallback if legacy
    try {
      const legacyVecRow = db
        .prepare('SELECT count(*) as c FROM chunks WHERE vector IS NOT NULL')
        .get()
      vectors = legacyVecRow?.c ?? 0
    } catch {
      vectors = 0
    }
  }

  // Lexical FTS benchmark
  const queryCount = Number(options.queries || 50)
  const lexicalLatencies = []
  const testTerms = [
    'enterprise',
    'document',
    'performance',
    'contract',
    'chunk',
    'terms',
    'clause',
    'scan',
  ]

  const ftsStmt = db.prepare(`
    SELECT rowid, rank FROM chunk_fts WHERE chunk_fts MATCH ? ORDER BY rank LIMIT 20
  `)

  for (let i = 0; i < queryCount; i++) {
    const term = testTerms[i % testTerms.length]
    const started = performance.now()
    try {
      ftsStmt.all(term)
    } catch {
      // ignore
    }
    const duration = performance.now() - started
    lexicalLatencies.push(duration)
  }

  lexicalLatencies.sort((a, b) => a - b)
  const percentile = (arr, p) => {
    if (!arr.length) return 0
    const idx = Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))
    return Math.round(arr[idx] * 100) / 100
  }

  const lexicalP50Ms = percentile(lexicalLatencies, 50)
  const lexicalP95Ms = percentile(lexicalLatencies, 95)

  // Snapshot simulation latency benchmark
  const snapshotLatencies = []
  const pageStmt = db.prepare('PRAGMA page_count')
  const freeStmt = db.prepare('PRAGMA freelist_count')

  for (let i = 0; i < 20; i++) {
    const started = performance.now()
    pageStmt.get()
    freeStmt.get()
    const duration = performance.now() - started
    snapshotLatencies.push(duration)
  }
  snapshotLatencies.sort((a, b) => a - b)
  const snapshotP95Ms = percentile(snapshotLatencies, 95)

  // Event loop delay measurement
  const elMonitor = monitorEventLoopDelay({ resolution: 20 })
  elMonitor.enable()
  // Yield to allow event loop monitoring sample
  const elP95Ms = Math.round((elMonitor.percentile(95) / 1_000_000) * 100) / 100
  elMonitor.disable()

  db.close()

  return {
    dbBytes,
    documents,
    chunks,
    vectors,
    lexicalP50Ms,
    lexicalP95Ms,
    snapshotP95Ms,
    eventLoopP95Ms: elP95Ms,
  }
}

if (process.argv[1] && process.argv[1].endsWith('document-memory-benchmark.mjs')) {
  const dbArg =
    process.argv.find((a) => a.startsWith('--db='))?.split('=')[1] || './test-fixture.db'
  const queriesArg = process.argv.find((a) => a.startsWith('--queries='))?.split('=')[1] || '50'
  const results = runBenchmark({ db: dbArg, queries: queriesArg })
  console.log(JSON.stringify(results, null, 2))
}
