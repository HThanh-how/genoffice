import { describe, expect, it } from 'vitest'
import { assertSettingsSaved } from '../src/ai-settings-result'

describe('the settings acknowledgement contract (U01-U04)', () => {
  it('U01: an affirmative acknowledgement is a save', () => {
    expect(assertSettingsSaved({ ok: true }).ok).toBe(true)
  })

  it('U02: every refusal reason is surfaced as a failure', () => {
    for (const reason of [
      'invalid',
      'unverified',
      'not-confirmed',
      'not-enabled',
      'unknown-policy',
      'stale',
      'write-failed',
    ]) {
      expect(() => assertSettingsSaved({ ok: false, reason })).toThrow(/not saved/)
    }
  })

  it('U03: a missing or malformed response is never a save', () => {
    for (const value of [null, undefined, {}, { ok: undefined }, 'ok', { ok: 'true' }, 0]) {
      expect(() => assertSettingsSaved(value)).toThrow(/not saved/)
    }
  })

  it('U04: the reason reaches the message the user sees', () => {
    expect(() => assertSettingsSaved({ ok: false, reason: 'stale' })).toThrow(
      /another window changed the settings first/,
    )
    expect(() => assertSettingsSaved({ ok: false, reason: 'write-failed' })).toThrow(
      /could not be written/,
    )
  })
})
