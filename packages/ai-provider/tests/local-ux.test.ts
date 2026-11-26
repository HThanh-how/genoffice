import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalLlmError, type HostEvent, type LocalErrorCode } from '@genoffice/local-llm/protocol'
import { defaultAiSettings } from '../src/providers'
import { chatForProvider } from '../src/chat'
import { localProgressText, setLocalChatLanguage } from '../src/local-copy'
import { setLocalChatTransport } from '../src/local'
import { classifyAiStreamError } from '../src/stream-error'
import { streamForProvider } from '../src/stream'

const config = defaultAiSettings().providers.local
afterEach(() => {
  setLocalChatTransport(undefined)
  setLocalChatLanguage(() => 'en')
})

describe('Local AI messages', () => {
  it('a download in progress is a notice, not an error', () => {
    const err = new LocalLlmError('PREPARING', 'Downloading Local AI · 98%')
    expect(classifyAiStreamError(err)).toEqual({ errorCode: 'notice' })
  })

  it('every real error reaches the user as it was thrown', async () => {
    const raw: [LocalErrorCode, string][] = [
      ['CONTEXT_OVERFLOW', 'Local context exceeded: 19419 prompt tokens / 8192. Shorten it.'],
      ['INSUFFICIENT_RAM', 'At least 2.5 GiB available RAM is required for the local model'],
      ['MODEL_CHECKSUM', 'Local model failed SHA-256 verification'],
      ['MODEL_MISSING', 'Local model is missing. Download it in Settings → AI Model.'],
      ['NATIVE_CRASH', 'Local native host exited (139). Retry to restart it.'],
      ['BUSY', 'Local model is busy. Wait for the current request to finish.'],
      // reads like a service's network trouble; must not be replaced by the text for one
      ['RUNTIME', 'Local model download failed: network'],
    ]
    for (const [code, message] of raw) {
      const err = new LocalLlmError(code, message)
      // main sends { error: err.message, ...fields }: nothing may override the message
      expect({ error: err.message, ...classifyAiStreamError(err) }).toEqual({ error: message })
      setLocalChatTransport(async () => {
        throw err
      })
      expect(await chatForProvider('local', config, '', 'hi')).toEqual({
        ok: false,
        error: message,
      })
    }
  })

  it('names each step, with a percentage only where one was measured', () => {
    expect(localProgressText({ phase: 'starting' })).toBe('Starting Local AI…')
    expect(localProgressText({ phase: 'loading', percent: 40 })).toBe(
      'Loading the model into memory · 40%',
    )
    expect(localProgressText({ phase: 'reading' })).toBe('Reading your request…')
  })
})

describe('Local AI waiting', () => {
  it('turns host steps into status lines and any sign of life into activity', async () => {
    setLocalChatTransport(async (_config, _request, event) => {
      const say = (e: object) => event({ id: '1', ...e } as HostEvent)
      say({ type: 'phase', phase: 'starting' })
      say({ type: 'phase', phase: 'loading', percent: 50 })
      say({ type: 'status', loaded: false, busy: true, rssBytes: 1 })
      say({ type: 'text', text: 'hi' })
    })
    const onStatus = vi.fn()
    const onActivity = vi.fn()
    await streamForProvider('local', config, '', [], [], 10, {
      signal: new AbortController().signal,
      onDelta: () => {},
      onToolCall: () => {},
      onStatus,
      onActivity,
    })
    expect(onStatus.mock.calls.flat()).toEqual([
      'Starting Local AI…',
      'Loading the model into memory · 50%',
    ])
    expect(onActivity).toHaveBeenCalledTimes(4)
  })
})
