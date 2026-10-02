import { describe, expect, it } from 'vitest'
import { attentionRank } from '../src/renderer/src/fork/IndexProblems'

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
