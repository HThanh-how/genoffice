import { describe, expect, it, vi } from 'vitest'
import { createIpcTransport, type IpcStreamChunk, type IpcStreamStart } from '../src'

function setup(extra: {
  quotaErrorText?: (resetAt?: number) => string
  authErrorText?: () => string
}) {
  let listener: ((chunk: IpcStreamChunk) => void) | undefined
  const started: IpcStreamStart<{ provider: string }>[] = []
  const transport = createIpcTransport<{ provider: string }>({
    onStream: (l) => {
      listener = l
      return () => {
        listener = undefined
      }
    },
    start: (request) => void started.push(request),
    cancel: vi.fn(),
    getSettings: () => ({ provider: 'agy' }),
    unknownErrorText: () => 'unknown error',
    timeoutErrorText: () => 'timed out',
    ...extra,
  })
  const cb = { onDelta: vi.fn(), onToolCall: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
  transport.stream({ system: 's', messages: [], tools: [] }, cb)
  const emit = (chunk: Omit<IpcStreamChunk, 'requestId'>) =>
    listener?.({ requestId: started[0]!.requestId, ...chunk })
  return { cb, emit }
}

describe('Antigravity quota and sign-in errors', () => {
  it('passes the reset time to the localized quota message', () => {
    const quotaErrorText = vi.fn((resetAt?: number) => `quota back at ${resetAt}`)
    const { cb, emit } = setup({ quotaErrorText })
    emit({ type: 'error', error: 'raw English text', errorCode: 'quota', errorResetAt: 1234 })
    expect(quotaErrorText).toHaveBeenCalledWith(1234)
    expect(cb.onError).toHaveBeenCalledWith('quota back at 1234')
  })

  it('works without a reset time', () => {
    const { cb, emit } = setup({ quotaErrorText: (resetAt) => `quota ${resetAt ?? 'no time'}` })
    emit({ type: 'error', error: 'raw', errorCode: 'quota' })
    expect(cb.onError).toHaveBeenCalledWith('quota no time')
  })

  it('maps the auth code to the localized sign-in message', () => {
    const { cb, emit } = setup({ authErrorText: () => 'please sign in' })
    emit({ type: 'error', error: 'Authentication required', errorCode: 'auth' })
    expect(cb.onError).toHaveBeenCalledWith('please sign in')
  })

  it('falls back to the carried text when an app has no localized message for them', () => {
    const quota = setup({})
    quota.emit({ type: 'error', error: 'Your Antigravity quota is used up', errorCode: 'quota' })
    expect(quota.cb.onError).toHaveBeenCalledWith('Your Antigravity quota is used up')
    const auth = setup({})
    auth.emit({ type: 'error', error: '', errorCode: 'auth' })
    expect(auth.cb.onError).toHaveBeenCalledWith('unknown error')
  })
})
