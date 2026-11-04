import { describe, expect, it } from 'vitest'
import { renameWithRetrySync } from '../src/store.js'

const failure = (code: string): Error => Object.assign(new Error(code), { code })

describe('renameWithRetrySync', () => {
  it('goes through at once when the rename works', () => {
    const pauses: number[] = []
    let calls = 0
    renameWithRetrySync(
      'a',
      'b',
      (ms) => void pauses.push(ms),
      () => void calls++,
    )
    expect([calls, pauses]).toEqual([1, []])
  })

  it('tries again after short pauses when Windows refuses for a moment, then succeeds', () => {
    const pauses: number[] = []
    let calls = 0
    renameWithRetrySync(
      'a',
      'b',
      (ms) => void pauses.push(ms),
      () => {
        if (++calls <= 2) throw failure(calls === 1 ? 'EPERM' : 'EBUSY')
      },
    )
    expect(calls).toBe(3)
    expect(pauses).toEqual([15, 40])
  })

  it('gives up with the last error after the pauses are used (under a third of a second in all)', () => {
    const pauses: number[] = []
    let calls = 0
    expect(() =>
      renameWithRetrySync(
        'a',
        'b',
        (ms) => void pauses.push(ms),
        () => {
          calls++
          throw failure('EACCES')
        },
      ),
    ).toThrow('EACCES')
    expect(calls).toBe(5)
    expect(pauses.reduce((a, b) => a + b, 0)).toBeLessThan(350)
  })

  it('does not retry an error that waiting cannot cure', () => {
    let calls = 0
    expect(() =>
      renameWithRetrySync(
        'a',
        'b',
        () => undefined,
        () => {
          calls++
          throw failure('ENOENT')
        },
      ),
    ).toThrow('ENOENT')
    expect(calls).toBe(1)
  })

  it('really waits: a real pause blocks for about the time asked', () => {
    let calls = 0
    const started = Date.now()
    renameWithRetrySync('a', 'b', undefined, () => {
      if (++calls === 1) throw failure('EPERM')
    })
    expect(Date.now() - started).toBeGreaterThanOrEqual(10)
  })
})
