import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileIndexer } from '../src/main/file-index/indexer'
import { FileIndexStore } from '../src/main/file-index/store'

const WORKER = join(__dirname, 'file-index-test-worker.mjs')

let dir: string
let storeDir: string
let store: FileIndexStore
let indexer: FileIndexer | null
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-incomplete-'))
  storeDir = mkdtempSync(join(tmpdir(), 'genoffice-diff-db-'))
  store = new FileIndexStore(join(storeDir, 'index.db'))
  mkdirSync(join(dir, 'a'))
  writeFileSync(join(dir, 'a', 'seen.txt'), 'seen')
})
afterEach(() => {
  indexer?.stop()
  store.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(storeDir, { recursive: true, force: true })
})

describe('FileIndexer diff on a big index', () => {
  it('does not hold the event loop while it walks 150k known paths of a root it could not read completely', async () => {
    // rows of an earlier, fuller walk: the root is now only partly readable, so none of them may be judged gone
    store.upsertPendingBatch(
      Array.from({ length: 1000 }, (_, i) => ({
        path: join(dir, 'gone', `f${i}.txt`),
        mtimeMs: i,
        sizeBytes: i,
      })),
    )
    const db = (store as unknown as { db: import('node:sqlite').DatabaseSync }).db
    db.exec('BEGIN')
    const ins = db.prepare(
      "INSERT INTO files(path, name, ext, mtime_ms, size_bytes, status, body) VALUES (?, ?, 'txt', 1, 1, 'ok', NULL)",
    )
    for (let i = 0; i < 150_000; i++) ins.run(join(dir, 'gone', 'deep', `x${i}.txt`), `x${i}.txt`)
    db.exec('COMMIT')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    indexer = new FileIndexer(store, WORKER, { roots: () => [dir], extraPaths: () => [] }, 5_000)

    const profiling = {
      sqlitePageReadMs: 0,
      maxSqlitePageReadMs: 0,
      mapConstructionMs: 0,
      maxMapConstructionMs: 0,
      totalListAllSlicedMs: 0,
      totalScanMs: 0,
      pagesCount: 0,
    }

    store.listAllSliced = async function (yieldNow, pageSize = 1_000) {
      const page = (this as any).db.prepare(
        'SELECT id, path, mtime_ms, size_bytes, status FROM files WHERE id > ? ORDER BY id LIMIT ?',
      )
      const out = new Map<string, any>()
      let after = 0
      const startTotal = performance.now()
      for (;;) {
        profiling.pagesCount++
        const t0 = performance.now()
        const rows = page.all(after, pageSize) as any[]
        const t1 = performance.now()
        const readDuration = t1 - t0
        profiling.sqlitePageReadMs += readDuration
        if (readDuration > profiling.maxSqlitePageReadMs)
          profiling.maxSqlitePageReadMs = readDuration

        if (rows.length === 0) {
          profiling.totalListAllSlicedMs = performance.now() - startTotal
          return out
        }

        const t2 = performance.now()
        for (const r of rows) {
          out.set(r.path, {
            path: r.path,
            mtimeMs: r.mtime_ms,
            sizeBytes: r.size_bytes,
            status: r.status,
          })
        }
        const t3 = performance.now()
        const mapDuration = t3 - t2
        profiling.mapConstructionMs += mapDuration
        if (mapDuration > profiling.maxMapConstructionMs)
          profiling.maxMapConstructionMs = mapDuration

        after = rows[rows.length - 1]!.id
        await yieldNow()
      }
    }

    const gaps: number[] = []
    let last = performance.now()
    const timer = setInterval(() => {
      gaps.push(performance.now() - last)
      last = performance.now()
    }, 4)
    const tScanStart = performance.now()
    await indexer.scan()
    profiling.totalScanMs = performance.now() - tScanStart
    // a block that ends the promise chain is only seen by the first timer that fires after it
    await new Promise((resolve) => setTimeout(resolve, 30))
    clearInterval(timer)
    expect(store.count()).toBeGreaterThan(150_000) // nothing was dropped
    const maxGap = Math.max(...gaps)
    console.log(
      '[PROFILING BREAKDOWN]',
      JSON.stringify(
        {
          maxGap,
          profiling,
          topGaps: gaps
            .filter((g) => g > 15)
            .sort((a, b) => b - a)
            .slice(0, 10),
          totalGapsRecorded: gaps.length,
        },
        null,
        2,
      ),
    )
    // the loop used to `continue` without ever yielding: hundreds of ms in one piece
    expect(
      maxGap,
      JSON.stringify(
        {
          maxGap,
          profiling,
          topGaps: gaps
            .filter((g) => g > 20)
            .sort((a, b) => b - a)
            .slice(0, 10),
        },
        null,
        2,
      ),
    ).toBeLessThan(100)
  }, 60_000)
})
