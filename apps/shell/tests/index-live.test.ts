import { describe, expect, it } from 'vitest'
import type { IndexingNow } from '../src/shared/fork/document-index-api'
import { liveOf } from '../src/renderer/src/fork/IndexFiles'

const now = (extra: Partial<IndexingNow> = {}): IndexingNow => ({
  extracting: [{ path: 'a.pdf', since: 1000 }],
  embedding: { 'b.docx': { done: 3, total: 10 } },
  positions: { 'c.pdf': 1, 'd.pdf': 2 },
  queued: 2,
  paused: false,
  ...extra,
})

describe('liveOf', () => {
  it('tells what the indexer is doing with each file', () => {
    expect(liveOf(now(), 'a.pdf')).toEqual({ kind: 'reading', since: 1000 })
    expect(liveOf(now(), 'b.docx')).toEqual({ kind: 'embedding', done: 3, total: 10 })
    expect(liveOf(now(), 'd.pdf')).toEqual({ kind: 'queued', position: 2 })
    expect(liveOf(now(), 'zzz.pdf')).toBeNull()
    expect(liveOf(null, 'a.pdf')).toBeNull()
  })

  it('says paused for a file that is not being read while background work is paused', () => {
    expect(liveOf(now({ paused: true }), 'c.pdf')).toEqual({ kind: 'paused' })
    expect(liveOf(now({ paused: true }), 'a.pdf')).toEqual({ kind: 'reading', since: 1000 })
  })
})
