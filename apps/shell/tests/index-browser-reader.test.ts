import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import {
  readIndexBrowser,
  validateBrowserQuery,
} from '../src/main/document-memory/index-browser-reader'
import { indexV2Copy, indexV2Words } from '../src/renderer/src/i18n/strings-index-v2'

const db = new DatabaseSync(':memory:')
db.exec(
  `CREATE TABLE documents(id INTEGER PRIMARY KEY, path TEXT, name TEXT, status TEXT, error TEXT, excluded INTEGER DEFAULT 0, content_evicted INTEGER DEFAULT 0, size_bytes INTEGER, updated_at INTEGER, priority_at INTEGER DEFAULT 0, chunk_done INTEGER DEFAULT 0, chunk_total INTEGER DEFAULT 0)`,
)
afterEach(() => db.exec('DELETE FROM documents'))
function seed(count = 250) {
  const insert = db.prepare(
    'INSERT INTO documents(id,path,name,status,error,size_bytes,updated_at) VALUES (?,?,?,?,?,?,?)',
  )
  for (let id = 1; id <= count; id++)
    insert.run(
      id,
      resolve(`seed/${id % 2 ? 'alpha' : 'alphabet'}/file-${id}.pdf`),
      id === 1 ? 'BỆNH VIỆN.pdf' : `file-${id}.pdf`,
      id % 3 ? 'error' : 'pending',
      id % 3 ? 'Permission denied' : null,
      id * 100,
      id,
    )
}
describe('bounded worker file browser', () => {
  it('separates text-only work still waiting for vectors from intentionally released searchable text', () => {
    seed()
    db.exec("UPDATE documents SET status = 'text-only' WHERE id IN (1, 2)")
    db.exec('UPDATE documents SET content_evicted = 1 WHERE id = 2')
    const waiting = readIndexBrowser(db, { reasons: ['waiting'], sort: 'name' })
    expect(waiting.total).toBe(84)
    expect(waiting.items.find((item) => item.id === 1)).toMatchObject({
      status: 'pending',
      reason: 'waiting',
    })
    const released = readIndexBrowser(db, { status: 'released' })
    expect(released.items.map((item) => item.id)).toEqual([2])
    expect(released.items[0]!.status).toBe('released')
    expect(released.items[0]!.reason).toBeUndefined()
  })
  it('returns accurate totals and at most 100 metadata rows per page, with deterministic offsets', () => {
    seed()
    const first = readIndexBrowser(db, {})
    const second = readIndexBrowser(db, { offset: 100 })
    expect(first.total).toBe(250)
    expect(first.items).toHaveLength(100)
    expect(second.items).toHaveLength(100)
    expect(first.items[99]!.id).toBe(151)
    expect(second.items[0]!.id).toBe(150)
    expect(first.sizeBytes).toBe(((250 * 251) / 2) * 100)
    expect(readIndexBrowser(db, { offset: 999 }).items).toEqual([])
  })
  it('filters before pagination by scope, reason, type and accent-insensitive name/path', () => {
    seed()
    expect(readIndexBrowser(db, { root: resolve('seed/alpha') }).total).toBe(125)
    expect(readIndexBrowser(db, { query: 'benh vien' }).items.map((i) => i.id)).toEqual([1])
    expect(readIndexBrowser(db, { reasons: ['waiting'] }).total).toBe(83)
    expect(readIndexBrowser(db, { type: 'docx' }).total).toBe(0)
    db.exec('UPDATE documents SET excluded = 1 WHERE id = 1')
    expect(readIndexBrowser(db, { query: 'benh' }).total).toBe(0)
  })
  it('sorts globally, not just inside the first fetched page', () => {
    seed()
    expect(readIndexBrowser(db, { sort: 'size', descending: true }).items[0]!.id).toBe(250)
    expect(
      readIndexBrowser(db, { sort: 'recent', descending: true, offset: 100 }).items[0]!.id,
    ).toBe(150)
    expect(readIndexBrowser(db, { query: "'; DROP TABLE documents;--" }).total).toBe(0)
  })
  it('holds a stable id boundary while processing changing matches in bounded pages', () => {
    seed()
    const first = readIndexBrowser(db, { reasons: ['permission'] })
    expect(first.maxId).toBe(250)
    db.exec("UPDATE documents SET status = 'ready' WHERE id <= 100")
    const next = readIndexBrowser(db, {
      reasons: ['permission'],
      afterId: 100,
      throughId: first.maxId,
    })
    expect(next.items[0]!.id).toBe(101)
    expect(next.items.every((item) => item.id > 100 && item.id <= 250)).toBe(true)
    expect(() => validateBrowserQuery({ afterId: -1 })).toThrow()
  })
  it('rejects malformed and unbounded IPC requests', () => {
    for (const value of [
      null,
      [],
      { offset: -1 },
      { offset: 0.5 },
      { sort: 'sqlite_master' },
      { query: 'x'.repeat(201) },
      { reasons: ['unknown'] },
      { type: '*.pdf' },
      { root: 1 },
    ])
      expect(() => validateBrowserQuery(value)).toThrow()
  })
  it('keeps all four authored shards in parity, with English fallback elsewhere', () => {
    for (const locale of ['vi', 'zh', 'zh-TW'])
      expect(Object.keys(indexV2Copy[locale]!).sort()).toEqual(Object.keys(indexV2Copy.en!).sort())
    expect(indexV2Words('fr')).toBe(indexV2Copy.en)
  })
})
