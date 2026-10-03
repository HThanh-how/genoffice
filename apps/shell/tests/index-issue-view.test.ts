import { describe, expect, it } from 'vitest'
import { ISSUE_REASON_ORDER } from '../src/main/document-memory/issues'
import { issueBucket } from '../src/renderer/src/fork/index-issue-view'

describe('index issue view', () => {
  it('keeps queued work out of the action list', () => {
    expect(issueBucket('waiting')).toBe('background')
  })
  it('puts scans and recoverable failures in attention', () => {
    for (const reason of [
      'no-text',
      'model',
      'permission',
      'timeout',
      'unavailable',
      'corrupt',
      'changed',
      'other',
    ] as const) {
      expect(issueBucket(reason)).toBe('attention')
    }
  })
  it('keeps informational exclusions separate from failures', () => {
    for (const reason of ['password', 'empty', 'too-large', 'unsupported'] as const) {
      expect(issueBucket(reason)).toBe('skipped')
    }
    expect(ISSUE_REASON_ORDER.filter((reason) => issueBucket(reason) === 'background')).toEqual([
      'waiting',
    ])
  })
})
