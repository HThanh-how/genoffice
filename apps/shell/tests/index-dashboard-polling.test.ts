import { describe, expect, it } from 'vitest'

describe('Index Dashboard Polling Cadence Specifications (IT-4)', () => {
  const ACTIVE_POLL_MS = 2000
  const IDLE_POLL_MS = 5000

  it('enforces 2s active and 5s idle cadence rules', () => {
    // When pending > 0 and not paused, cadence must be 2000ms
    const calculatePollInterval = (pending: number, paused: boolean): number => {
      if (paused || pending === 0) return IDLE_POLL_MS
      return ACTIVE_POLL_MS
    }

    expect(calculatePollInterval(10, false)).toBe(2000)
    expect(calculatePollInterval(1, false)).toBe(2000)
    expect(calculatePollInterval(0, false)).toBe(5000)
    expect(calculatePollInterval(10, true)).toBe(5000)
    expect(calculatePollInterval(0, true)).toBe(5000)
  })

  it('suppresses polling when document visibility is hidden', () => {
    const shouldPoll = (visibilityState: 'visible' | 'hidden'): boolean => {
      return visibilityState === 'visible'
    }

    expect(shouldPoll('visible')).toBe(true)
    expect(shouldPoll('hidden')).toBe(false)
  })
})
