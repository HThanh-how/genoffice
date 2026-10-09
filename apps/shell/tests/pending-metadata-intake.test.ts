import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PendingMetadataIntake, type PendingMetadataIntakeOptions } from '../src/main/document-memory/runtime/pending-metadata-intake'

describe('bounded startup metadata intake', () => {
  let dir: string
  const queues: PendingMetadataIntake[] = []
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'genoffice-intake-')) })
  afterEach(() => {
    queues.splice(0).forEach(q => q.close())
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })
  function file(name: string): string {
    const path = join(dir, name)
    writeFileSync(path, 'Giấy ra viện Phạm Hữu Công')
    return path
  }
  function queue(overrides: Partial<PendingMetadataIntakeOptions> = {}) {
    const remembered = vi.fn(() => ({ outcome: 'admitted' as const }))
    const discovered = vi.fn(() => ({ outcome: 'enrolled' as const }))
    const error = vi.fn()
    const q = new PendingMetadataIntake({
      isWriteReady: () => true, isAccountingReady: () => true,
      isFreeDiskReady: () => true, isStopped: () => false,
      isEnabled: () => true, onRemember: remembered,
      onDiscovered: discovered, onLastError: error, ...overrides,
    })
    queues.push(q)
    return { q, remembered, discovered, error }
  }

  it('keeps startup intents until all three gates are ready and replays once', async () => {
    let ack = false, accounting = false, disk = false
    const { q, remembered } = queue({ isWriteReady: () => ack,
      isAccountingReady: () => accounting, isFreeDiskReady: () => disk })
    const path = file('medical.txt')
    expect(q.enqueue(path, 'remember').status).toBe('deferred')
    await q.triggerReplay()
    expect(remembered).not.toHaveBeenCalled()
    ack = true; accounting = true
    await q.triggerReplay()
    expect(remembered).not.toHaveBeenCalled()
    disk = true
    await q.triggerReplay()
    expect(remembered).toHaveBeenCalledExactlyOnceWith(path)
    expect(q.size).toBe(0)
    await q.triggerReplay()
    expect(remembered).toHaveBeenCalledTimes(1)
  })

  it('deduplicates, promotes a manual open, and rejects overflow visibly', async () => {
    let enabled = false
    const { q, remembered, discovered, error } = queue({ maxCapacity: 1, isEnabled: () => enabled })
    const path = file('medical.txt')
    q.enqueue(path, 'discovered')
    q.enqueue(path, 'remember')
    expect(q.size).toBe(1)
    expect(q.get(path)?.kind).toBe('remember')
    expect(q.enqueue(file('other.txt'), 'remember').status).toBe('rejected')
    expect(error).toHaveBeenCalledWith('Metadata admission queue full')
    await q.triggerReplay()
    expect(remembered).not.toHaveBeenCalled()
    enabled = true
    await q.triggerReplay()
    expect(remembered).toHaveBeenCalledExactlyOnceWith(path)
    expect(discovered).not.toHaveBeenCalled()
  })

  it('retains full-budget intents without looping or losing the request', async () => {
    const remember = vi.fn(() => ({ outcome: 'denied' as const, reason: 'budget-full' }))
    const { q, error } = queue({ onRemember: remember })
    q.enqueue(file('medical.txt'), 'remember')
    await q.triggerReplay()
    expect(remember).toHaveBeenCalledTimes(1)
    expect(q.size).toBe(1)
    expect(error).toHaveBeenCalledWith('budget-full')
    expect(q.list()[0]?.retries).toBe(0)
  })

  it('rechecks discovery files and drops deleted sources without replaying', async () => {
    const { q, discovered } = queue()
    const path = file('gone.txt')
    q.enqueue(path, 'discovered')
    unlinkSync(path)
    await q.triggerReplay()
    expect(discovered).not.toHaveBeenCalled()
    expect(q.size).toBe(0)
  })

  it('cancels and transfers pending paths, and close prevents future writes', async () => {
    const { q, remembered } = queue()
    const canceled = file('cancel.txt'), old = file('old.txt'), next = file('next.txt')
    q.enqueue(canceled, 'remember')
    q.enqueue(old, 'remember')
    q.getAdapter().onCanceled?.(canceled)
    q.getAdapter().onMoved?.(old, next)
    await q.triggerReplay()
    expect(remembered).toHaveBeenCalledExactlyOnceWith(next)
    q.close()
    expect(q.enqueue(canceled, 'remember')).toEqual({ status: 'rejected', reason: 'stopped' })
    await q.triggerReplay()
    expect(remembered).toHaveBeenCalledTimes(1)
  })

  it('stops disk retries after the bounded schedule and survives late readiness', async () => {
    vi.useFakeTimers()
    let disk = false
    const { q, remembered } = queue({ isFreeDiskReady: () => disk })
    q.enqueue(file('disk.txt'), 'remember')
    await vi.advanceTimersByTimeAsync(1000)
    expect(remembered).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(q.size).toBe(1)
    disk = true
    await q.triggerReplay()
    expect(remembered).toHaveBeenCalledTimes(1)
  })
})
