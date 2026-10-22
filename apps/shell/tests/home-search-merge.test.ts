import { describe, expect, it } from 'vitest'
import type { FileSearchHit, RecentEntry } from '../src/shared/home-api'
import {
  contentGroup,
  instantNameMatches,
  mergeNameGroup,
  searchTotal,
} from '../src/renderer/src/fork/home-search-merge'

const entry = (path: string, over: Partial<RecentEntry> = {}): RecentEntry => ({
  path,
  name: path.split('/').pop()!,
  ext: path.split('.').pop()!,
  mtimeMs: 1,
  sizeBytes: 1,
  starred: false,
  ...over,
})
const hit = (path: string, over: Partial<FileSearchHit> = {}): FileSearchHit => ({
  ...entry(path),
  snippet: null,
  needles: [],
  ...over,
})

describe('instantNameMatches', () => {
  const files = [
    entry('/d/Giáo án Toán 6.docx'),
    entry('/d/bao cao.xlsx'),
    entry('/giao an/ke hoach.pdf'),
    entry('/d/Giáo án Toán 6.docx'),
    entry('/d/gone giao an.docx', { missing: true }),
  ]
  it('ignores accents and case and drops duplicates and missing files', () => {
    const r = instantNameMatches(files, 'GIAO an')
    expect(r.map((h) => h.path)).toEqual(['/d/Giáo án Toán 6.docx', '/giao an/ke hoach.pdf'])
    expect(r[0]!.snippet).toBeNull()
    expect(r[0]!.needles).toEqual(['giao', 'an'])
  })
  it('treats the last word as a prefix and requires every word', () => {
    expect(instantNameMatches(files, 'giáo án toa').map((h) => h.name)).toEqual([
      'Giáo án Toán 6.docx',
    ])
    expect(instantNameMatches(files, 'giao zzz')).toEqual([])
    expect(instantNameMatches(files, '   ')).toEqual([])
  })
  it('honours the file-type predicate and the limit', () => {
    expect(instantNameMatches(files, 'giao an', (e) => e.ext === 'pdf').map((h) => h.ext)).toEqual([
      'pdf',
    ])
    expect(instantNameMatches(files, 'giao an', () => true, 1)).toHaveLength(1)
  })
  it('puts the better name match first', () => {
    const r = instantNameMatches(
      [entry('/giao an/readme.txt'), entry('/x/giao an.docx')],
      'giao an',
    )
    expect(r[0]!.path).toBe('/x/giao an.docx')
  })
})

describe('merging the groups', () => {
  it('keeps instant rows in place, appends engine-only names and lets the engine row carry its data', () => {
    const instant = [hit('/a'), hit('/b')]
    const engine = [hit('/c'), hit('/b', { starred: true, needles: ['b'] })]
    const merged = mergeNameGroup(instant, engine)
    expect(merged.map((h) => h.path)).toEqual(['/a', '/b', '/c'])
    expect(merged[1]!.starred).toBe(true)
    // an engine answer for the same query never reorders the rows already shown
    expect(mergeNameGroup(merged, engine).map((h) => h.path)).toEqual(['/a', '/b', '/c'])
    expect(mergeNameGroup(instant, []).map((h) => h.path)).toEqual(['/a', '/b'])
  })
  it('drops from the content group what the names group already shows, keeping order', () => {
    const names = [hit('/a'), hit('/c')]
    const content = [hit('/x'), hit('/a'), hit('/y'), hit('/c')]
    expect(contentGroup(content, names).map((h) => h.path)).toEqual(['/x', '/y'])
  })
  it('counts each file once', () => {
    const names = [hit('/a'), hit('/z')]
    expect(searchTotal(names, null)).toBe(2)
    // truncated content page: its total already covers the name matches
    expect(searchTotal(names, { hits: [hit('/a')], total: 300 })).toBe(300)
    // complete page: /z is an instant-only row, counted on top
    expect(searchTotal(names, { hits: [hit('/a'), hit('/y')], total: 2 })).toBe(3)
  })
})
