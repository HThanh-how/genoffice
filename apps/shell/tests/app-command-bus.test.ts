import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppCommandBus, type CommandTarget } from '../src/main/app-command-bus'

afterEach(() => vi.useRealTimers())
const input = { kind: 'app_action' as const, id: 'print' as const, args: {}, teach: false }
function target(): CommandTarget {
  return { key: 2, valid: vi.fn(() => true), send: vi.fn(), cancel: vi.fn() }
}

describe('command completion bus', () => {
  it('waits for the matching renderer acknowledgement, not send()', async () => {
    const bus = new AppCommandBus()
    const renderer = target()
    const id = bus.prepare(1, input, renderer)
    const settled = vi.fn()
    const promise = bus.execute(1, id).then(settled)
    bus.ack(3, id, { status: 'completed' })
    bus.ack(2, 'wrong-id', { status: 'completed' })
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    expect(renderer.send).toHaveBeenCalledWith({ requestId: id, input })
    bus.ack(2, id, { status: 'handoff' })
    await promise
    expect(settled).toHaveBeenCalledWith({ status: 'handoff' })
    expect(() => bus.execute(1, id)).toThrow()
  })
  it('times out, cleans up and ignores a late success', async () => {
    vi.useFakeTimers()
    const bus = new AppCommandBus(50)
    const renderer = target()
    const id = bus.prepare(1, input, renderer)
    const promise = bus.execute(1, id)
    await vi.advanceTimersByTimeAsync(50)
    expect(await promise).toMatchObject({
      status: 'error',
      error: expect.stringContaining('unknown'),
    })
    expect(renderer.cancel).toHaveBeenCalledWith(id)
    bus.ack(2, id, { status: 'completed' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('refuses a target that changed during approval without sending', async () => {
    const bus = new AppCommandBus()
    const renderer = target()
    const id = bus.prepare(1, input, renderer)
    vi.mocked(renderer.valid).mockReturnValue(false)
    expect(await bus.execute(1, id)).toMatchObject({ status: 'error' })
    expect(renderer.send).not.toHaveBeenCalled()
  })
  it('cancels an in-flight target on tab switch or document replacement', async () => {
    const bus = new AppCommandBus()
    const renderer = target()
    const id = bus.prepare(1, input, renderer)
    const promise = bus.execute(1, id)
    vi.mocked(renderer.valid).mockReturnValue(false)
    bus.validateTargets()
    expect(await promise).toMatchObject({ status: 'error', error: 'Target changed' })
    bus.ack(2, id, { status: 'completed' })
  })
  it.each([1, 2])('closing requester or target %i releases its promise', async (sender) => {
    const bus = new AppCommandBus()
    const id = bus.prepare(1, input, target())
    const promise = bus.execute(1, id)
    bus.invalidate(sender)
    expect(await promise).toEqual({ status: 'cancelled' })
  })
  it('tickets are single-use and owned; another caller cannot cancel them', async () => {
    const bus = new AppCommandBus()
    const id = bus.prepare(1, input, target())
    expect(() => bus.execute(9, id)).toThrow()
    bus.cancel(9, id)
    const promise = bus.execute(1, id)
    expect(() => bus.execute(1, id)).toThrow()
    bus.cancel(1, id)
    expect(await promise).toEqual({ status: 'cancelled' })
  })
  it('expires an abandoned approval and notifies the renderer', async () => {
    vi.useFakeTimers()
    const bus = new AppCommandBus(50, 20)
    const renderer = target()
    const id = bus.prepare(1, input, renderer)
    await vi.advanceTimersByTimeAsync(20)
    expect(() => bus.execute(1, id)).toThrow()
    expect(renderer.cancel).toHaveBeenCalledWith(id)
    expect(vi.getTimerCount()).toBe(0)
  })
})
