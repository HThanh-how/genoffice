import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createIpcTransport,
  getNotice,
  getStreamStatus,
  IPC_STREAM_SILENCE_TIMEOUT_MS,
  subscribeNotices,
  subscribeStreamStatus,
  withoutNotices,
  type IpcStreamChunk,
} from '../src'

function open() {
  const listeners = new Set<(chunk: IpcStreamChunk) => void>()
  const cancelled: string[] = []
  let emit!: (chunk: Omit<IpcStreamChunk, 'requestId'>) => void
  const callbacks = { onDelta: vi.fn(), onToolCall: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
  const transport = createIpcTransport({
    onStream: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    start: ({ requestId }) => {
      emit = (chunk) => [...listeners].forEach((fn) => fn({ requestId, ...chunk }))
    },
    cancel: (id) => cancelled.push(id),
    getSettings: () => ({}),
    unknownErrorText: () => 'unknown',
  })
  const send = () => transport.stream({ system: '', messages: [], tools: [] }, callbacks)
  const handle = send()
  return {
    emit: (chunk: Omit<IpcStreamChunk, 'requestId'>) => emit(chunk),
    handle,
    send,
    listeners,
    cancelled,
    ...callbacks,
  }
}
afterEach(() => vi.useRealTimers())

describe('stream status', () => {
  it('is visible while waiting and gone with the first word', () => {
    const changed = vi.fn()
    const off = subscribeStreamStatus(changed)
    const { emit, handle } = open()
    emit({ type: 'status', text: 'Loading…' })
    expect(getStreamStatus()).toBe('Loading…')
    emit({ type: 'delta', text: 'Hi' })
    expect(getStreamStatus()).toBeNull()
    expect(changed).toHaveBeenCalledTimes(2)
    handle.cancel()
    off()
  })

  it.each(['done', 'error', 'cancel'] as const)('never survives %s', (end) => {
    const { emit, handle } = open()
    emit({ type: 'status', text: 'Reading…' })
    if (end === 'cancel') handle.cancel()
    else emit({ type: end })
    expect(getStreamStatus()).toBeNull()
  })

  it('counts as activity for the silence timeout', () => {
    vi.useFakeTimers()
    const { emit, onError, handle } = open()
    vi.advanceTimersByTime(IPC_STREAM_SILENCE_TIMEOUT_MS - 1000)
    emit({ type: 'status', text: 'Reading…' })
    vi.advanceTimersByTime(IPC_STREAM_SILENCE_TIMEOUT_MS - 1000)
    expect(onError).not.toHaveBeenCalled()
    handle.cancel()
  })

  it('marks a notice as one, and leaves real errors alone', () => {
    const notice = open()
    notice.emit({ type: 'error', error: 'Downloading · 98%', errorCode: 'notice' })
    expect(notice.onError).toHaveBeenCalledWith('Downloading · 98%', {
      notice: expect.any(String),
    })
    const failure = open()
    failure.emit({ type: 'error', error: 'boom' })
    expect(failure.onError.mock.calls).toEqual([['boom']])
  })

  it('updates the one status line in place after the turn ended, then lets go', () => {
    const { emit, onError, onDone, onDelta, listeners } = open()
    emit({ type: 'error', error: '80%', errorCode: 'notice' })
    const id = onError.mock.calls[0]![1].notice as string
    const changed = vi.fn()
    const off = subscribeNotices(changed)
    const seen = ['81%', '82%', '82%', 'Checking…', 'Ready'].map((text) => {
      emit({ type: 'status', text })
      return getNotice(id)!.text
    })
    expect(seen).toEqual(['81%', '82%', '82%', 'Checking…', 'Ready'])
    expect(changed).toHaveBeenCalledTimes(4) // an unchanged line is not a change
    emit({ type: 'done' })
    expect(listeners.size).toBe(0)
    // no event of a finished turn reaches the chat again
    expect([onError, onDone, onDelta].map((f) => f.mock.calls.length)).toEqual([1, 0, 0])
    expect(getStreamStatus()).toBeNull()
    off()
  })

  it('a failed download turns the line into its original error', () => {
    const { emit, onError } = open()
    emit({ type: 'error', error: '80%', errorCode: 'notice' })
    emit({ type: 'error', error: 'Local model failed SHA-256 verification' })
    expect(getNotice(onError.mock.calls[0]![1].notice)).toEqual({
      text: 'Local model failed SHA-256 verification',
      failed: true,
    })
    expect(onError).toHaveBeenCalledOnce()
  })

  it('asking again leaves one line: the old one is no longer followed', () => {
    const { emit, onError, send, listeners, cancelled } = open()
    emit({ type: 'error', error: '80%', errorCode: 'notice' })
    send()
    emit({ type: 'error', error: '82%', errorCode: 'notice' })
    const [first, second] = onError.mock.calls.map((call) => call[1].notice as string)
    expect(cancelled).toEqual([first])
    expect(listeners.size).toBe(1)
    expect(
      withoutNotices([
        { role: 'user' },
        { role: 'assistant', notice: first },
        { role: 'user', notice: first },
        { role: 'assistant' },
      ]),
    ).toEqual([{ role: 'user' }, { role: 'user', notice: first }, { role: 'assistant' }])
    emit({ type: 'status', text: '83%' })
    expect(getNotice(second!)!.text).toBe('83%')
  })
})
