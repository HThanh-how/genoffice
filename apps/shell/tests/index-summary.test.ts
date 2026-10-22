import { describe, expect, it, vi } from 'vitest'
import {
  capBadge,
  deriveIndexSummary,
  isProblemReason,
  loadIndexSummary,
  navIndicator,
} from '../src/renderer/src/fork/index-summary'
import type { HomeApi, HomeIndexingActivity } from '../src/shared/home-api'
import { buildIssueSections } from '../src/renderer/src/fork/index-issue-groups'

function activity(over: {
  pendingFiles?: number
  errorFiles?: number
  emptyFiles?: number
  running?: boolean
  enabled?: boolean
}): HomeIndexingActivity {
  return {
    memory: {
      enabled: over.enabled ?? true,
      modelState: 'ready',
      pending: over.pendingFiles ?? 0,
      errors: over.errorFiles ?? 0,
    },
    folder: over.running ? { running: true } : null,
    folderProgress: {
      totalFiles: 100,
      readyFiles: 90,
      pendingFiles: over.pendingFiles ?? 0,
      errorFiles: over.errorFiles ?? 0,
      emptyFiles: over.emptyFiles ?? 0,
      completedChunks: 0,
      totalChunks: 0,
      percent: 90,
    },
  } as unknown as HomeIndexingActivity
}

const groups = (g: Array<[string, number]>) =>
  ({
    total: g.reduce((n, [, c]) => n + c, 0),
    groups: g.map(([reason, count]) => ({ reason, count })),
  }) as never

describe('deriveIndexSummary', () => {
  it('empty files are not problems', () => {
    const s = deriveIndexSummary({ activity: activity({ emptyFiles: 1992 }) })
    expect(s.problems).toBe(0)
    expect(s.empty).toBe(1992)
  })

  it('waiting is the queue and never counts as a problem', () => {
    const s = deriveIndexSummary({
      activity: activity({ pendingFiles: 40 }),
      attention: groups([['waiting', 40]]),
    })
    expect(s.waiting).toBe(40)
    expect(s.problems).toBe(0)
    expect(navIndicator(s)).toEqual({ kind: 'working' })
  })

  it('counts only actionable groups: skips waiting, no-text and informational reasons', () => {
    const attention = groups([
      ['permission', 3],
      ['corrupt', 2],
      ['no-text', 500],
      ['empty', 9],
      ['too-large', 4],
      ['waiting', 7],
    ])
    const s = deriveIndexSummary({ activity: activity({}), attention })
    expect(s.problems).toBe(5)
    expect(s.problemGroups.map((g) => g.reason)).toEqual(['permission', 'corrupt'])
    expect(isProblemReason('no-text')).toBe(false)
    expect(isProblemReason('model')).toBe(true)
  })

  it('a password-protected file is a problem; the badge and the Issues groups agree', () => {
    const attention = groups([
      ['corrupt', 2],
      ['password', 14],
      ['other', 19],
      ['no-text', 1467],
      ['empty', 490],
      ['waiting', 3],
    ])
    const s = deriveIndexSummary({ activity: activity({}), attention })
    expect(s.problems).toBe(35)
    const sections = buildIssueSections(attention.groups)
    expect(sections.needs.reduce((n, r) => n + r.count, 0)).toBe(s.problems)
  })

  it('falls back to failed files of the activity without issue groups', () => {
    expect(
      deriveIndexSummary({ activity: activity({ errorFiles: 6, emptyFiles: 50 }) }).problems,
    ).toBe(6)
  })

  it('sidebar badge: a number only for real problems, a quiet mark for a long queue, nothing when calm', () => {
    const queue = deriveIndexSummary({ activity: activity({ pendingFiles: 25_000 }) })
    expect(navIndicator(queue)).toEqual({ kind: 'working' })
    const problems = deriveIndexSummary({
      activity: activity({ pendingFiles: 25_000, errorFiles: 21 }),
    })
    expect(navIndicator(problems)).toEqual({ kind: 'problems', n: 21 })
    expect(navIndicator(deriveIndexSummary({ activity: activity({}) }))).toBeNull()
    const off = deriveIndexSummary({ activity: activity({ pendingFiles: 10, enabled: false }) })
    expect(navIndicator(off)).toBeNull()
  })

  it('caps the badge number', () => {
    expect(capBadge(7)).toBe('7')
    expect(capBadge(99)).toBe('99')
    expect(capBadge(100)).toBe('99+')
    expect(capBadge(9665)).toBe('99+')
  })

  it('is active while scanning or queued', () => {
    expect(deriveIndexSummary({ activity: activity({ running: true }) }).active).toBe(true)
    expect(deriveIndexSummary({ activity: activity({ pendingFiles: 1 }) }).active).toBe(true)
    expect(deriveIndexSummary({ activity: activity({}) }).active).toBe(false)
  })
})

describe('loadIndexSummary (sidebar, dock and dashboard share it)', () => {
  const attention = groups([
    ['permission', 3],
    ['no-text', 100],
  ])
  it('gives the same numbers as the dashboard derivation', async () => {
    const a = activity({ pendingFiles: 5, errorFiles: 120, emptyFiles: 100 })
    const api = {
      getIndexingActivity: vi.fn().mockResolvedValue(a),
      getDocumentIndexIssueSummary: vi.fn().mockResolvedValue(attention),
    } as unknown as HomeApi
    const loaded = await loadIndexSummary(api)
    expect(loaded).toEqual(deriveIndexSummary({ activity: a, attention }))
    expect(loaded?.problems).toBe(3)
  })
  it('survives a failing issue summary and a missing api', async () => {
    const api = {
      getIndexingActivity: vi.fn().mockResolvedValue(activity({ errorFiles: 4 })),
      getDocumentIndexIssueSummary: vi.fn().mockRejectedValue(new Error('x')),
    } as unknown as HomeApi
    expect((await loadIndexSummary(api))?.problems).toBe(4)
    expect(await loadIndexSummary({} as HomeApi)).toBeNull()
  })
})
