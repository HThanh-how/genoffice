import { describe, expect, it } from 'vitest'
import { AgyError, agyTruncatedError, classifyAgyFailure } from '../src/agy-errors'
import { classifyAiStreamError } from '../src/stream-error'
import { AiCreditsError } from '../src/protocols/shared'
import { AiTimeoutError } from '../src/watchdog'
import { agyChoice } from '../src/agy-choice'

describe('classifyAiStreamError', () => {
  it('keeps the existing mapping for the other providers', () => {
    expect(classifyAiStreamError(new AiTimeoutError(5000))).toEqual({ errorCode: 'timeout' })
    expect(
      classifyAiStreamError(new AiCreditsError('Your Genspark credits have been exhausted')),
    ).toEqual({
      errorCode: 'credits',
    })
    expect(classifyAiStreamError(new Error('HTTP 429: slow down'))).toEqual({
      errorCode: 'overloaded',
    })
    expect(classifyAiStreamError(new TypeError('fetch failed'))).toEqual({ errorCode: 'network' })
    expect(classifyAiStreamError(new Error('something else'))).toEqual({})
  })

  it('maps typed agy failures to the localizable codes, with the reset time for a quota', () => {
    const reset = Date.now() + 3_600_000
    const quota = new AgyError({ kind: 'quota', message: 'q', resetAt: reset })
    expect(classifyAiStreamError(quota)).toEqual({ errorCode: 'quota', errorResetAt: reset })
    expect(classifyAiStreamError(new AgyError({ kind: 'quota', message: 'q' }))).toEqual({
      errorCode: 'quota',
    })
    expect(classifyAiStreamError(new AgyError({ kind: 'auth', message: 'a' }))).toEqual({
      errorCode: 'auth',
    })
    expect(classifyAiStreamError(agyTruncatedError('half'))).toEqual({ errorCode: 'timeout' })
  })

  it('a transient model failure reads as "busy"; other agy errors keep their own text', () => {
    expect(
      classifyAiStreamError(
        classifyAgyFailure({
          exitCode: 3,
          stderr: 'AGY_ERROR: {"status":"UNAVAILABLE","retryable":true}',
        }),
      ),
    ).toEqual({ errorCode: 'overloaded' })
    expect(
      classifyAiStreamError(
        classifyAgyFailure({
          exitCode: 3,
          stderr: 'AGY_ERROR: {"status":"INVALID_ARGUMENT","retryable":false,"message":"bad"}',
        }),
      ),
    ).toEqual({})
    expect(
      classifyAiStreamError(new AgyError({ kind: 'unknown', message: 'invalid model' })),
    ).toEqual({})
  })

  it('sees a typed error through the cause chain', () => {
    const wrapped = new Error('Antigravity could not ...', {
      cause: new AgyError({ kind: 'auth', message: 'a' }),
    })
    expect(classifyAiStreamError(wrapped)).toEqual({ errorCode: 'auth' })
  })
})

describe('agyChoice (who has chosen Antigravity)', () => {
  it('is yes as soon as any feature is stored as agy, without needing to know about usability', () => {
    expect(agyChoice({ provider: 'agy' }, null)).toBe('yes')
    expect(agyChoice({ provider: 'gemini', media: { imageProvider: 'agy' } }, null)).toBe('yes')
    expect(agyChoice({ provider: 'gemini', search: { provider: 'agy' } }, null)).toBe('yes')
    expect(agyChoice({ media: { analysisProvider: 'agy' } }, null)).toBe('yes')
    expect(agyChoice({ media: { videoAnalysisProvider: 'agy' } }, null)).toBe('yes')
    // a pre-split file used one media provider for everything
    expect(agyChoice({ media: { provider: 'agy' } }, null)).toBe('yes')
  })

  it('is no when every feature is stored as something else', () => {
    const decided = {
      provider: 'gemini',
      media: {
        imageProvider: 'openai',
        analysisProvider: 'gemini',
        videoAnalysisProvider: 'gemini',
      },
      search: { provider: 'serper' },
    }
    expect(agyChoice(decided, null)).toBe('no')
    expect(agyChoice(decided, true)).toBe('no')
  })

  it('leaves undecided features to the agy-first default', () => {
    expect(agyChoice({}, null)).toBe('unknown')
    expect(agyChoice({}, true)).toBe('yes')
    expect(agyChoice({}, false)).toBe('no')
    expect(
      agyChoice({ provider: 'gemini', media: {}, search: { provider: 'serper' } }, false),
    ).toBe('no')
    // a stored genspark keeps meaning "use the default"
    expect(agyChoice({ provider: 'genspark' }, true)).toBe('yes')
  })

  it('survives a hand-edited or corrupted file', () => {
    expect(agyChoice(null, false)).toBe('no')
    expect(agyChoice('garbage', null)).toBe('unknown')
    expect(agyChoice({ provider: 5, media: 'x', search: [] }, true)).toBe('yes')
  })
})
