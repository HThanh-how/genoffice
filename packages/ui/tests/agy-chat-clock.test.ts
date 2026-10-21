import { describe, expect, it } from 'vitest'
import { clockTime, compactTokens } from '../src/AgyChatBar'

describe('agy home chat clock', () => {
  it('shows seconds under a minute and m:ss after', () => {
    expect(clockTime(0)).toBe('0s')
    expect(clockTime(45_900)).toBe('45s')
    expect(clockTime(65_000)).toBe('1:05')
    expect(clockTime(600_000)).toBe('10:00')
  })

  it('adds hours past one hour', () => {
    expect(clockTime(3_723_000)).toBe('1:02:03')
  })

  it('clamps negative input', () => {
    expect(clockTime(-5_000)).toBe('0s')
  })
})

describe('agy token count', () => {
  it('keeps small counts exact and shortens thousands', () => {
    expect(compactTokens(0)).toBe('0')
    expect(compactTokens(812)).toBe('812')
    expect(compactTokens(1000)).toBe('1.0k')
    expect(compactTokens(3092)).toBe('3.1k')
  })
})
