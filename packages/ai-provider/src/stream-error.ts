import { agyErrorKindOf, AgyError } from './agy-errors'
import { isAiNetworkError } from './network-error'
import { isAiOverloadedError } from './overload-error'
import { AiCreditsError } from './protocols/shared'
import { AiTimeoutError } from './watchdog'
import type { AiStreamChunk } from './types'

/**
 * The machine-readable part of an `error` stream chunk: which localized message the renderer
 * shows, and for an exhausted Antigravity quota when it comes back. One place for the three
 * editors' `ai:stream` handlers (they used to carry identical copies of this chain).
 */
export type AiStreamErrorFields = Pick<AiStreamChunk, 'errorCode' | 'errorResetAt'>

function findAgyError(err: unknown): AgyError | undefined {
  let current: unknown = err
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof AgyError) return current
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

export function classifyAiStreamError(err: unknown): AiStreamErrorFields {
  const agy = agyErrorKindOf(err) ? findAgyError(err) : undefined
  if (agy) {
    if (agy.kind === 'quota') {
      return {
        errorCode: 'quota',
        ...(agy.resetAt === undefined ? {} : { errorResetAt: agy.resetAt }),
      }
    }
    if (agy.kind === 'auth') return { errorCode: 'auth' }
    if (agy.kind === 'timeout') return { errorCode: 'timeout' }
    // a transient model failure reads as "the service is busy"; anything else keeps agy's own text
    if (agy.kind === 'model' && agy.retryable) return { errorCode: 'overloaded' }
    // other agy failures keep their own text unless the generic checks below recognise them
  }
  if (err instanceof AiTimeoutError) return { errorCode: 'timeout' }
  if (err instanceof AiCreditsError) return { errorCode: 'credits' }
  if (isAiNetworkError(err)) return { errorCode: 'network' }
  if (isAiOverloadedError(err)) return { errorCode: 'overloaded' }
  return {}
}
