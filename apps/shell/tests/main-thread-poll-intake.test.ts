import { describe, expect, it } from 'vitest'
import {
  enqueueIncompletePaged,
  enqueueIncompleteSliced,
  type IncompleteRow,
} from '../src/main/document-memory/runtime/poll-intake'

/** Burns CPU like a per-path database lookup would. */
function work(ms: number): void {
  const end = performance.now() + ms
  while (performance.now() < end) {
    // busy
  }
}

describe('enqueueIncompleteSliced', () => {
  it('hands 4000 paths over without holding the event loop for the whole run', async () => {
    const paths = Array.from({ length: 4000 }, (_, i) => `/p/${i}`)
    const gaps: number[] = []
    let last = performance.now()
    const timer = setInterval(() => {
      gaps.push(performance.now() - last)
      last = performance.now()
    }, 2)
    const taken: string[] = []
    // 0.25 ms per path = 1 s in one piece in the old loop
    await enqueueIncompleteSliced(
      paths,
      () => false,
      (p) => (work(0.25), taken.push(p)),
      () => false,
    )
    await new Promise((resolve) => setTimeout(resolve, 20)) // a block at the end of the chain shows in the next timer tick
    clearInterval(timer)
    expect(taken).toHaveLength(4000)
    expect(Math.max(...gaps)).toBeLessThan(60)
  }, 20_000)

  it('skips busy paths and stops as soon as the manager does', async () => {
    const taken: string[] = []
    let stopped = false
    await enqueueIncompleteSliced(
      ['a', 'b', 'c', 'd'],
      (p) => p === 'b',
      (p) => {
        taken.push(p)
        if (p === 'c') stopped = true
      },
      () => stopped,
    )
    expect(taken).toEqual(['a', 'c'])
  })
})

describe('enqueueIncompletePaged', () => {
  const rows: IncompleteRow[] = Array.from({ length: 5000 }, (_, i) => ({
    path: `/p/${i}`,
    priorityAt: 10_000 - Math.floor(i / 3),
    id: 5000 - i,
  }))
  const readPage = (
    after: { priorityAt: number; id: number } | null,
    limit: number,
  ): IncompleteRow[] => {
    const start = after
      ? rows.findIndex(
          (r) =>
            r.priorityAt < after.priorityAt ||
            (r.priorityAt === after.priorityAt && r.id < after.id),
        )
      : 0
    return start < 0 ? [] : rows.slice(start, start + limit)
  }

  it('reads a backlog of any size in full, page by page and in order, with no backlog limit', async () => {
    const taken: string[] = []
    const seen = await enqueueIncompletePaged({
      readPage,
      isBusy: () => false,
      enqueue: (p) => taken.push(p),
      isStopped: () => false,
      pageSize: 300,
    })
    expect(seen).toBe(5000)
    expect(taken).toEqual(rows.map((r) => r.path))
  })

  it('skips busy paths, and stops as soon as the manager does', async () => {
    const taken: string[] = []
    let stopped = false
    await enqueueIncompletePaged({
      readPage,
      isBusy: (p) => p === '/p/1',
      enqueue: (p) => {
        taken.push(p)
        if (p === '/p/400') stopped = true
      },
      isStopped: () => stopped,
      pageSize: 256,
    })
    expect(taken[0]).toBe('/p/0')
    expect(taken).not.toContain('/p/1')
    expect(taken[taken.length - 1]).toBe('/p/400')
  })

  it('does not hold the event loop while a 4000-path backlog is handed over', async () => {
    const gaps: number[] = []
    let last = performance.now()
    const timer = setInterval(() => {
      gaps.push(performance.now() - last)
      last = performance.now()
    }, 2)
    await enqueueIncompletePaged({
      readPage,
      isBusy: () => false,
      enqueue: () => work(0.25),
      isStopped: () => false,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    clearInterval(timer)
    expect(Math.max(...gaps)).toBeLessThan(60)
  }, 20_000)
})
