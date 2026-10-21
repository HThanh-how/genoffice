import { describe, expect, it } from 'vitest'
import { ISSUE_REASON_ORDER } from '../src/main/document-memory/issues'
import {
  ISSUE_CATEGORIES,
  buildIssueSections,
  narrowSummary,
  sectionOf,
} from '../src/renderer/src/fork/index-issue-groups'
import { EN, VI } from '../src/renderer/src/fork/index-dashboard-i18n'

describe('issue reasons fold into a few groups', () => {
  it('maps every reason to a section', () => {
    for (const reason of ISSUE_REASON_ORDER) expect(sectionOf(reason), reason).toBeTruthy()
  })

  it('uses the documented groups; queue and blank files are kept apart', () => {
    expect(sectionOf('permission')).toBe('locked')
    expect(sectionOf('timeout')).toBe('locked')
    expect(sectionOf('corrupt')).toBe('damaged')
    expect(sectionOf('password')).toBe('damaged')
    expect(sectionOf('too-large')).toBe('unsupported')
    expect(sectionOf('unsupported')).toBe('unsupported')
    expect(sectionOf('no-text')).toBe('ocr')
    expect(sectionOf('unavailable')).toBe('gone')
    expect(sectionOf('model')).toBe('other')
    expect(sectionOf('waiting')).toBe('waiting')
    expect(sectionOf('empty')).toBe('auto')
  })

  it('every group has a title and a hint in English and Vietnamese', () => {
    for (const d of [EN, VI])
      for (const id of ISSUE_CATEGORIES) {
        expect(d.issues.cat[id].title.length, id).toBeGreaterThan(0)
        expect(d.issues.cat[id].hint.length, id).toBeGreaterThan(0)
      }
  })
})

describe('buildIssueSections', () => {
  const groups = [
    { reason: 'permission' as const, count: 4 },
    { reason: 'timeout' as const, count: 1 },
    { reason: 'corrupt' as const, count: 2 },
    { reason: 'too-large' as const, count: 3 },
    { reason: 'unavailable' as const, count: 6 },
    { reason: 'waiting' as const, count: 9665 },
    { reason: 'empty' as const, count: 1992 },
  ]

  it('adds counts per group in the listed order; queue and blank files are not problems', () => {
    const s = buildIssueSections(groups)
    expect(s.needs.map((r) => [r.id, r.count])).toEqual([
      ['locked', 5],
      ['damaged', 2],
      ['unsupported', 3],
      ['gone', 6],
    ])
    expect(s.waiting?.count).toBe(9665)
    expect(s.auto?.count).toBe(1992)
  })

  it('offers a retry only where trying again can change the outcome', () => {
    const byId = Object.fromEntries(
      buildIssueSections(groups).needs.map((r) => [r.id, r.retryable]),
    )
    expect(byId).toMatchObject({ locked: true, damaged: true, unsupported: false, gone: false })
  })

  it('drops empty groups and tolerates no input', () => {
    expect(buildIssueSections([{ reason: 'corrupt', count: 0 }]).needs).toEqual([])
    expect(buildIssueSections([])).toEqual({ needs: [], waiting: null, auto: null })
  })

  it('narrows a summary to the reasons of one group', () => {
    const summary = { total: 20, groups } as never
    const narrowed = narrowSummary(summary, ['permission', 'timeout'])
    expect(narrowed.groups.map((g) => g.reason)).toEqual(['permission', 'timeout'])
    expect(narrowed.total).toBe(5)
  })
})
