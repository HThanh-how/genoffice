import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { ensureRedundancySchema } from '../src/main/document-memory/storage/redundancy-schema'
import {
  ARCHIVE_AFTER_DAYS,
  DEFAULT_AGE_POLICY,
  FRESH_WINDOW_DAYS,
  ageBucketOf,
  computeValueDensity,
  countAgeBuckets,
  recencyFactor,
  resolveAgePolicy,
  valueDensitySql,
  type ValueInput,
} from '../src/main/document-memory/runtime/value-density'
import { DAY, seedDocuments } from './helpers/compaction-fixtures'

describe('age policy ("recent files matter, year-old files do not")', () => {
  it('has documented defaults: 30 days fresh, 12 months archive', () => {
    expect(FRESH_WINDOW_DAYS).toBe(30)
    expect(ARCHIVE_AFTER_DAYS).toBe(365)
    expect(DEFAULT_AGE_POLICY).toEqual({ freshWindowDays: 30, archiveAfterDays: 365 })
    expect(resolveAgePolicy()).toEqual(DEFAULT_AGE_POLICY)
    expect(resolveAgePolicy({})).toEqual(DEFAULT_AGE_POLICY)
  })

  it('is overridable through the budget/settings object and ignores nonsense', () => {
    expect(resolveAgePolicy({ archiveAfterMonths: 6 }).archiveAfterDays).toBeCloseTo(182.5, 5)
    expect(resolveAgePolicy({ freshWindowDays: 7, archiveAfterMonths: 3 })).toMatchObject({ freshWindowDays: 7 })
    expect(resolveAgePolicy({ archiveAfterMonths: -1, freshWindowDays: Number.NaN })).toEqual(DEFAULT_AGE_POLICY)
    // the archive threshold always stays well behind the fresh window
    expect(resolveAgePolicy({ freshWindowDays: 100, archiveAfterMonths: 1 }).archiveAfterDays).toBe(200)
  })

  it('buckets by the last time a document was opened OR modified; unknown age is never archive', () => {
    const now = Date.UTC(2026, 9, 9)
    expect(ageBucketOf(now - 3 * DAY, now)).toBe('fresh')
    expect(ageBucketOf(now - 30 * DAY, now)).toBe('fresh')
    expect(ageBucketOf(now - 31 * DAY, now)).toBe('recent')
    expect(ageBucketOf(now - 365 * DAY, now)).toBe('recent')
    expect(ageBucketOf(now - 366 * DAY, now)).toBe('archive')
    expect(ageBucketOf(0, now)).toBe('recent')
  })

  it('recency decays strongly: fresh = 1, a year old is two orders of magnitude lower', () => {
    expect(recencyFactor(0)).toBe(1)
    expect(recencyFactor(30)).toBe(1)
    expect(recencyFactor(60)).toBeGreaterThan(0.5)
    expect(recencyFactor(200)).toBeLessThan(0.25)
    expect(recencyFactor(400)).toBeLessThan(0.02)
    expect(recencyFactor(400)).toBeLessThan(recencyFactor(364) / 5) // the archive multiplier is a visible step
  })

  it('a year-old big document has a far lower value density than a week-old small one', () => {
    const now = Date.now()
    const base: ValueInput = { importance: 'normal', lastTouchMs: now, opened: false, nowMs: now, boilerplateRatio: 0, familySize: 1, isDuplicate: false, textBytes: 10_000, vectorBytes: 5_000 }
    const weekOldSmall = computeValueDensity({ ...base, lastTouchMs: now - 7 * DAY, textBytes: 2_000, vectorBytes: 1_000 })
    const yearOldBig = computeValueDensity({ ...base, lastTouchMs: now - 400 * DAY, textBytes: 200_000, vectorBytes: 50_000 })
    expect(yearOldBig).toBeLessThan(weekOldSmall / 100)
    // important documents stay ahead of normal ones of any age
    expect(computeValueDensity({ ...base, importance: 'important', lastTouchMs: now - 400 * DAY })).toBeGreaterThan(
      computeValueDensity({ ...base, lastTouchMs: now - 400 * DAY }),
    )
  })

  describe('SQL twin and bucket histogram (real SQLite)', () => {
    let dir: string
    let store: DocumentMemoryStore
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'value-density-age-'))
      store = new DocumentMemoryStore(join(dir, 'document-memory.db'), { role: 'worker' })
    })
    afterEach(() => {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    })

    it('valueDensitySql() agrees with computeValueDensity() for fresh / recent / archive documents, also with a custom policy', () => {
      const now = Date.now()
      const ages = [2, 29, 45, 120, 364, 366, 900]
      const docs = seedDocuments(store, dir, ages.map((a, i) => ({ name: `d-${i}.txt`, ageDays: a, chunks: 2 })), now)
      ensureRedundancySchema(store.rawDb)
      for (const d of docs) {
        const id = store.documentByPath(d.path)!.id
        store.rawDb
          .prepare(
            `INSERT INTO document_redundancy (document_id, family_key, family_size, boilerplate_ratio, chunk_count, text_bytes, boilerplate_bytes, vector_bytes, computed_at)
             VALUES (?, 'k', 1, 0, 2, 4000, 0, 2500, ?)`,
          )
          .run(id, now)
      }
      for (const policy of [DEFAULT_AGE_POLICY, resolveAgePolicy({ freshWindowDays: 10, archiveAfterMonths: 6 })]) {
        const rows = store.rawDb
          .prepare(`SELECT d.path AS path, ${valueDensitySql(now, policy)} AS dens FROM documents d JOIN document_redundancy r ON r.document_id = d.id`)
          .all() as Array<{ path: string; dens: number }>
        for (const d of docs) {
          const sql = rows.find((r) => r.path === d.path)!.dens
          const ts = computeValueDensity(
            { importance: 'normal', lastTouchMs: now - d.ageDays * DAY, opened: false, nowMs: now, boilerplateRatio: 0, familySize: 1, isDuplicate: false, textBytes: 4000, vectorBytes: 2500 },
            policy,
          )
          expect(sql).toBeCloseTo(ts, 12)
        }
      }
    })

    it('countAgeBuckets reports the histogram; opening a document moves it to fresh (touch revives)', () => {
      const now = Date.now()
      const docs = seedDocuments(store, dir, [
        { name: 'fresh.txt', ageDays: 3 },
        { name: 'recent.txt', ageDays: 90 },
        { name: 'archive-a.txt', ageDays: 500 },
        { name: 'archive-b.txt', ageDays: 800 },
        { name: 'imp.txt', kind: 'important', ageDays: 800 },
      ], now)
      let h = countAgeBuckets(store.rawDb, now)
      expect([h.fresh.documents, h.recent.documents, h.archive.documents, h.protectedDocuments]).toEqual([1, 1, 2, 1])
      expect(h.archive.chunks).toBe(20)
      expect(h.freshWindowDays).toBe(30)
      expect(h.archiveAfterDays).toBe(365)
      // opened a year later does not matter: the LAST touch counts. Opening archive-a today revives it.
      store.remember(docs[2]!.path)
      h = countAgeBuckets(store.rawDb, Date.now())
      expect([h.fresh.documents, h.archive.documents]).toEqual([2, 1])
      // a custom policy re-buckets the same library
      h = countAgeBuckets(store.rawDb, Date.now(), resolveAgePolicy({ archiveAfterMonths: 2 }))
      expect([h.archive.documents, h.recent.documents]).toEqual([2, 0]) // the 90-day-old document and archive-b
    })
  })
})
