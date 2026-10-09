import { describe, expect, it } from 'vitest'
import {
  AgyError,
  agyErrorKindOf,
  agyTruncatedError,
  classifyAgyFailure,
  describeAgyError,
  extractAgyResetAt,
  hasAgyPrintTimeoutWarning,
  parseAgyDuration,
  parseAgyErrorLine,
} from '../src/agy-errors'
import { classifyAgyOcrError } from '../src/agy-ocr'

const NOW = Date.parse('2026-10-09T10:00:00Z')

describe('parseAgyErrorLine', () => {
  it('reads canonical status, code, retryability, error id and message from the stderr line', () => {
    const stderr = [
      'Fetching available models...',
      'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"retryable":false,"error_id":"e-123","message":"Quota exceeded for gemini"}',
    ].join('\n')
    expect(parseAgyErrorLine(stderr)).toEqual({
      status: 'RESOURCE_EXHAUSTED',
      code: 429,
      retryable: false,
      errorId: 'e-123',
      message: 'Quota exceeded for gemini',
    })
  })

  it('accepts other spellings, nested error objects and the short_error form the binary prints', () => {
    expect(parseAgyErrorLine('AGY_ERROR: {"short_error":"model overloaded"}')).toEqual({
      message: 'model overloaded',
    })
    expect(
      parseAgyErrorLine(
        'AGY_ERROR: {"error":{"canonical_status":"UNAVAILABLE","http_status":"503","is_retryable":true,"errorId":"x"}}',
      ),
    ).toEqual({ status: 'UNAVAILABLE', code: 503, retryable: true, errorId: 'x' })
  })

  it('uses the last AGY_ERROR line, survives broken JSON and returns undefined without a line', () => {
    expect(
      parseAgyErrorLine('AGY_ERROR: {"message":"old"}\nnoise\nAGY_ERROR: {"message":"new"}\n'),
    ).toEqual({ message: 'new' })
    expect(parseAgyErrorLine('AGY_ERROR: not json at all')).toEqual({ message: 'not json at all' })
    expect(parseAgyErrorLine('AGY_ERROR: [1,2]')).toEqual({ message: '[1,2]' })
    expect(parseAgyErrorLine('just some progress noise')).toBeUndefined()
    expect(parseAgyErrorLine('')).toBeUndefined()
  })
})

describe('print-timeout warning', () => {
  it('recognises the exact stderr line a real agy 1.3.2 printed on 2026-10-09', () => {
    expect(
      hasAgyPrintTimeoutWarning(
        '[agy] print timeout after 4s with turn in progress; returning partial output\n',
      ),
    ).toBe(true)
    expect(hasAgyPrintTimeoutWarning('Fetching available models...\nAuthentication required')).toBe(
      false,
    )
  })
})

describe('reset time', () => {
  it('reads an ISO timestamp that follows a reset phrase', () => {
    expect(extractAgyResetAt('Quota exhausted. Resets at 2026-10-09T15:30:00Z', NOW)).toBe(
      Date.parse('2026-10-09T15:30:00Z'),
    )
    expect(extractAgyResetAt('{"quota":"reset_time":"2026-10-10T00:00:00+07:00"}', NOW)).toBe(
      Date.parse('2026-10-09T17:00:00Z'),
    )
  })

  it('reads relative durations and retry-after keys', () => {
    expect(extractAgyResetAt('Your quota resets in 2h 15m', NOW)).toBe(NOW + 8_100_000)
    expect(extractAgyResetAt('please retry after 90s', NOW)).toBe(NOW + 90_000)
    expect(extractAgyResetAt('{"retry_after": 3600}', NOW)).toBe(NOW + 3_600_000)
    expect(extractAgyResetAt('"retryDelay":"45s"', NOW)).toBe(NOW + 45_000)
  })

  it('ignores times that are past, absurdly far, or not near a reset word', () => {
    expect(extractAgyResetAt('resets at 2026-10-09T09:00:00Z', NOW)).toBeUndefined()
    expect(extractAgyResetAt('resets at 2027-12-31T00:00:00Z', NOW)).toBeUndefined()
    expect(extractAgyResetAt('started at 2026-10-09T15:30:00Z', NOW)).toBeUndefined()
    expect(extractAgyResetAt('nothing useful here', NOW)).toBeUndefined()
  })

  it('parses compound durations', () => {
    expect(parseAgyDuration('1h 5m 30s')).toBe(3_930_000)
    expect(parseAgyDuration('2 hours')).toBe(7_200_000)
    expect(parseAgyDuration('45.5s')).toBe(45_500)
    expect(parseAgyDuration('soon')).toBeUndefined()
  })
})

describe('classifyAgyFailure', () => {
  it('an exhausted quota is typed, carries the reset time and is not retryable', () => {
    const error = classifyAgyFailure({
      exitCode: 3,
      now: NOW,
      stderr:
        'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"retryable":false,"message":"Quota exceeded. Resets at 2026-10-09T15:30:00Z"}',
    })
    expect(error).toBeInstanceOf(AgyError)
    expect(error.kind).toBe('quota')
    expect(error.retryable).toBe(false)
    expect(error.resetAt).toBe(Date.parse('2026-10-09T15:30:00Z'))
    expect(error.exitCode).toBe(3)
    expect(error.message).toMatch(/quota is used up and resets at/)
    expect(error.info?.status).toBe('RESOURCE_EXHAUSTED')
  })

  it('the credits notice agy prints is a quota failure without a reset time', () => {
    const error = classifyAgyFailure({
      resultError: 'Your AI credits balance is too low to continue.',
      exitCode: 1,
    })
    expect(error.kind).toBe('quota')
    expect(error.resetAt).toBeUndefined()
    expect(error.message).toMatch(/usage quota is used up\. Wait for it to reset/)
  })

  it('a signed-out CLI is an auth failure however it says so', () => {
    for (const input of [
      { stderr: 'Authentication required' },
      { stderr: 'not signed in' },
      { resultError: 'Please sign in again' },
      { stderr: 'AGY_ERROR: {"status":"UNAUTHENTICATED","message":"token"}' },
      { stderr: 'AGY_ERROR: {"code":401}' },
    ]) {
      const error = classifyAgyFailure({ ...input, exitCode: 1 })
      expect(error.kind).toBe('auth')
      expect(error.retryable).toBe(false)
      expect(error.message).toMatch(/not signed in/)
    }
  })

  it('a transient model failure is retryable; a plain rate limit is not mistaken for an empty quota', () => {
    const overloaded = classifyAgyFailure({
      exitCode: 3,
      stderr:
        'AGY_ERROR: {"status":"UNAVAILABLE","code":503,"retryable":true,"message":"The model is overloaded"}',
    })
    expect(overloaded.kind).toBe('model')
    expect(overloaded.retryable).toBe(true)
    expect(overloaded.message).toMatch(/temporarily unavailable \(503\)/)

    const rate = classifyAgyFailure({
      exitCode: 3,
      stderr: 'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"message":"Too many requests"}',
    })
    expect(rate.kind).toBe('model')
    expect(rate.retryable).toBe(true)
  })

  it('exit code 3 without a readable line is still a model error; other codes keep the CLI text', () => {
    const three = classifyAgyFailure({ exitCode: 3, stderr: 'something broke\n' })
    expect(three.kind).toBe('model')
    expect(three.message).toContain('something broke')

    const plain = classifyAgyFailure({
      resultError:
        'invalid model selection (--model "nope"): model nope is not recognized\nAvailable models:\n  Gemini',
      exitCode: 1,
    })
    expect(plain.kind).toBe('unknown')
    expect(plain.message).toBe(
      'invalid model selection (--model "nope"): model nope is not recognized',
    )
    expect(classifyAgyFailure({ exitCode: 7, stderr: '' }).message).toBe(
      'Antigravity CLI exited with code 7 without a result',
    )
  })

  it('never reads the model answer: a document that says "quota exceeded" is not a failure', () => {
    const error = classifyAgyFailure({
      exitCode: 1,
      stderr: 'progress...',
      partialText: 'The quota exceeded warning, please sign in again, 429 429',
    })
    expect(error.kind).toBe('unknown')
    expect(error.partialText).toContain('quota exceeded')
  })

  it('a deadline status is a timeout', () => {
    expect(
      classifyAgyFailure({
        exitCode: 3,
        stderr: 'AGY_ERROR: {"status":"DEADLINE_EXCEEDED","code":504}',
      }).kind,
    ).toBe('timeout')
  })
})

describe('typed error helpers', () => {
  it('describes each kind in plain English', () => {
    expect(describeAgyError('quota', { resetAt: NOW + 60_000, now: NOW })).toMatch(
      /resets at .*\d.*(AM|PM)/,
    )
    expect(describeAgyError('auth')).toContain('Settings → AI Model')
    expect(describeAgyError('timeout')).toContain('partial answer was discarded')
    expect(describeAgyError('model', { retryable: false, detail: 'bad' })).toBe(
      'Antigravity reported a model error: bad',
    )
  })

  it('finds the kind through a cause chain', () => {
    const inner = agyTruncatedError('half an answer')
    expect(inner.kind).toBe('timeout')
    expect(inner.partialText).toBe('half an answer')
    expect(agyErrorKindOf(new Error('wrapped', { cause: inner }))).toBe('timeout')
    expect(agyErrorKindOf(new Error('plain'))).toBeUndefined()
  })

  it('keeps messages that the OCR classifier already routes correctly', () => {
    const kinds = {
      quota: classifyAgyFailure({ resultError: 'Your AI credits balance is too low', exitCode: 1 }),
      auth: classifyAgyFailure({ stderr: 'Authentication required', exitCode: 1 }),
      model: classifyAgyFailure({
        exitCode: 3,
        stderr: 'AGY_ERROR: {"status":"UNAVAILABLE","retryable":true}',
      }),
      timeout: agyTruncatedError(''),
    }
    expect(classifyAgyOcrError(kinds.quota.message)).toBe('quota')
    expect(classifyAgyOcrError(kinds.auth.message)).toBe('auth')
    expect(classifyAgyOcrError(kinds.model.message)).toBe('transient')
    expect(classifyAgyOcrError(kinds.timeout.message)).toBe('transient')
  })
})
