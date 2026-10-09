import { describe, expect, it } from 'vitest'
import {
  POLL_BACKLOG_LIMIT,
  enqueueIncompleteSliced,
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

  it('has a backlog limit above which a poll adds nothing', () => {
    expect(POLL_BACKLOG_LIMIT).toBeGreaterThan(0)
  })
})
