import { describe, expect, it } from 'vitest'
import { attentionRank, loadAtLeast } from '../src/renderer/src/fork/IndexProblems'
import { isIndexIssuePage, readIndexRequest } from '../src/renderer/src/fork/index-request'

describe('order of the "to do" groups', () => {
  it('puts scans first and the group being indexed last', () => {
    const reasons = ['waiting', 'timeout', 'no-text', 'corrupt'] as const
    expect([...reasons].sort((a, b) => attentionRank(a) - attentionRank(b))).toEqual([
      'no-text',
      'timeout',
      'corrupt',
      'waiting',
    ])
  })
})

describe('refreshing a list that was opened with "show more"', () => {
  const rows = Array.from({ length: 35 }, (_, i) => i)
  const fetchPage = (offset: number) =>
    Promise.resolve({ items: rows.slice(offset, offset + 10), total: rows.length })

  it('keeps as many rows as were on screen instead of going back to the first page', async () => {
    const { items, total } = await loadAtLeast(fetchPage, 25)
    expect(items).toHaveLength(30) // whole pages, at least what was shown
    expect(items[29]).toBe(29)
    expect(total).toBe(35)
  })

  it('stops at the end of the list', async () => {
    expect((await loadAtLeast(fetchPage, 100)).items).toHaveLength(35)
  })

  it('reads one page when only the first page was shown', async () => {
    expect((await loadAtLeast(fetchPage, 1)).items).toHaveLength(10)
  })

  it('rejects malformed pages instead of paging with an invalid total or row shape', async () => {
    expect(isIndexIssuePage({ total: Number.MAX_SAFE_INTEGER + 1, items: [] })).toBe(false)
    expect(isIndexIssuePage({ total: 1, items: [{ id: 1 }] })).toBe(false)
    await expect(loadAtLeast(async () => ({ total: -1, items: [] }), 1)).rejects.toThrow(
      'Invalid index response',
    )
  })

  it('caps page walks even if a response advertises an unreasonable total', async () => {
    let requests = 0
    const fetch = async (offset: number) => {
      requests++
      return { total: 30_000, items: Array.from({ length: 10 }, (_, index) => offset + index) }
    }
    await expect(loadAtLeast(fetch, 30_000)).rejects.toThrow('page limit')
    expect(requests).toBe(200)
  })

  it('bounds a single issue page request that never settles', async () => {
    await expect(
      readIndexRequest(() => new Promise(() => undefined), isIndexIssuePage, 5),
    ).rejects.toThrow('timed out')
  })
})
