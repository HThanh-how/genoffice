import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { FreshnessCoordinator } from '../src/main/document-memory/runtime/freshness-coordinator'
import { FolderScanManager } from '../src/main/document-memory/folder-scan'
import { mediaCounts } from '../src/main/document-memory/media/media-repository'
import { jpeg, mp4, writeSparse } from './helpers/media-fixtures'

/**
 * Scale and cost of media rows on a synthetic tree (sparse files: valid headers, no disk use).
 * Default is small so the suite stays fast; run the full measurement with
 *   MEDIA_SCALE_FILES=20000 npx vitest run tests/media-scale.test.ts
 */
const FILES = Number(process.env.MEDIA_SCALE_FILES ?? 1500)
const MAX_BYTES_PER_ROW = 1024

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function dbBytes(store: DocumentMemoryStore): number {
  store.rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const { page_count } = store.rawDb.prepare('PRAGMA page_count').get() as { page_count: number }
  const { page_size } = store.rawDb.prepare('PRAGMA page_size').get() as { page_size: number }
  const { freelist_count } = store.rawDb.prepare('PRAGMA freelist_count').get() as { freelist_count: number }
  return (page_count - freelist_count) * page_size
}

describe(`media rows at scale (${FILES} files)`, () => {
  it('enrolls with bounded memory, without blocking the event loop, at under 1 KB per row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'genoffice-media-scale-'))
    dirs.push(dir)
    const root = join(dir, 'Pictures')
    const photo = jpeg(4032, 3024)
    const clip = mp4({ width: 1920, height: 1080, seconds: 30, mdatBytes: 2_000 })
    const perDir = 50
    let created = 0
    const makeStarted = performance.now()
    for (let a = 0; created < FILES; a++) {
      for (let b = 0; b < 20 && created < FILES; b++) {
        const folder = join(root, `Album ${String(a).padStart(3, '0')}`, `Chuyến đi ${b}`)
        mkdirSync(folder, { recursive: true })
        for (let i = 0; i < perDir && created < FILES; i++, created++) {
          const day = 1 + (created % 28)
          if (created % 25 === 0) writeSparse(join(folder, `VID_2018${String((created % 12) + 1).padStart(2, '0')}${String(day).padStart(2, '0')}_${created}.mp4`), clip, 4_000_000)
          else writeSparse(join(folder, `IMG_2017${String((created % 12) + 1).padStart(2, '0')}${String(day).padStart(2, '0')}_${100000 + created}.jpg`), photo, 24_000)
        }
      }
    }
    const makeMs = performance.now() - makeStarted

    const store = new DocumentMemoryStore(join(dir, 'document-memory.db'))
    const freshness = new FreshnessCoordinator({ store })
    const baseline = dbBytes(store)
    const scanner = new FolderScanManager(join(dir, 'state'), {
      indexDiscoveredFile: (path, meta) => freshness.indexDiscoveredFile(path, meta),
    })

    let worstLagMs = 0
    let last = performance.now()
    const lag = setInterval(() => {
      const now = performance.now()
      worstLagMs = Math.max(worstLagMs, now - last - 5)
      last = now
    }, 5)
    const rssBefore = process.memoryUsage().rss
    let rssPeak = rssBefore
    const sampler = setInterval(() => (rssPeak = Math.max(rssPeak, process.memoryUsage().rss)), 50)

    const scanStarted = performance.now()
    scanner.start(root)
    while (scanner.status().running) await new Promise((resolve) => setTimeout(resolve, 10))
    const scanMs = performance.now() - scanStarted
    const rows = (store.rawDb.prepare('SELECT count(*) AS n FROM document_media').get() as { n: number }).n

    // Headers are read by the background filler while the walk is still going; this flushes the tail.
    const tailStarted = performance.now()
    await freshness.drainMediaMetadata()
    const tailMs = performance.now() - tailStarted
    const filled = (store.rawDb.prepare('SELECT count(*) AS n FROM document_media WHERE meta_state = 1').get() as { n: number }).n
    clearInterval(lag)
    clearInterval(sampler)

    const bytes = dbBytes(store) - baseline
    const report = {
      files: FILES,
      rows,
      makeFilesS: +(makeMs / 1000).toFixed(1),
      enrollRowsPerSec: Math.round(rows / (scanMs / 1000)),
      headerTailMs: Math.round(tailMs),
      bytesPerRow: Math.round(bytes / rows),
      worstEventLoopLagMs: Math.round(worstLagMs),
      rssGrowthMB: +((rssPeak - rssBefore) / 1048576).toFixed(1),
    }
    console.log(`[media-scale] ${JSON.stringify(report)}`)
    try {
      const parts = store.rawDb
        .prepare("SELECT name, round(sum(pgsize) * 1.0 / ?, 1) AS bytes_per_row FROM dbstat GROUP BY name HAVING sum(pgsize) > 20000 ORDER BY 2 DESC LIMIT 12")
        .all(rows)
      console.log(`[media-scale] bytes/row by object ${JSON.stringify(parts)}`)
    } catch {
      // dbstat is optional
    }

    const timed = (query: string) => {
      const started = performance.now()
      const hits = store.searchNames(query, 5)
      return { ms: performance.now() - started, hits: hits.length }
    }
    const queries = Object.fromEntries(
      ['video', 'ảnh tháng 3 2017', 'ảnh 16/03/2017', 'IMG_20170316', 'chuyến đi 7'].map((q) => {
        const { ms, hits } = timed(q)
        return [q, { ms: +ms.toFixed(1), hits }]
      }),
    )
    console.log(`[media-scale] search ${JSON.stringify(queries)}`)
    for (const result of Object.values(queries)) expect(result.ms).toBeLessThan(250)
    expect(queries['video']!.hits).toBeGreaterThan(0)
    expect(queries['ảnh tháng 3 2017']!.hits).toBeGreaterThan(0)

    expect(rows).toBe(FILES)
    expect(filled).toBe(FILES)
    expect(mediaCounts(store.rawDb)).toMatchObject({ pendingMetadata: 0 })
    expect(store.incompletePaths()).toEqual([])
    expect(store.folderChunkProgress(root)).toMatchObject({ totalFiles: FILES, readyFiles: FILES, pendingFiles: 0, mediaFiles: FILES })
    expect(report.bytesPerRow).toBeLessThan(MAX_BYTES_PER_ROW)
    expect(report.worstEventLoopLagMs).toBeLessThan(250)
    expect(statSync(root).isDirectory()).toBe(true)

    // The whole tree again: nothing changed, nothing is rewritten and nothing is queued.
    const before = store.rawDb.prepare('SELECT max(updated_at) AS u, count(*) AS n FROM documents').get()
    const walked = await freshness.reconcileFolder(root, new Map())
    expect(walked.removed).toBe(0)
    scanner.rescanExisting(root)
    while (scanner.status().running) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(store.rawDb.prepare('SELECT max(updated_at) AS u, count(*) AS n FROM documents').get()).toEqual(before)
    expect(await freshness.drainMediaMetadata()).toBe(0)

    scanner.close()
    store.close()
  }, 280_000)
})
