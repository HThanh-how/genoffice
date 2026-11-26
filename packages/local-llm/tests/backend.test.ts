import { describe, expect, it, vi } from 'vitest'
import type { Llama } from 'node-llama-cpp'
import { isNoBinaryFound, openLlama } from '../src/host/backend'

class NoBinaryFoundError extends Error {
  constructor() {
    super('no binary')
    this.name = 'NoBinaryFoundError'
  }
}
const llama = (gpu: unknown) => ({ gpu }) as unknown as Llama

describe('openLlama', () => {
  it('uses the backend that was asked for when it exists', async () => {
    const getLlama = vi.fn(async (o: { gpu?: unknown }) => llama(o.gpu))
    const result = await openLlama(getLlama, false, { build: 'never' })
    expect(result.backendFallback).toBe(false)
    expect(getLlama).toHaveBeenCalledTimes(1)
    expect(getLlama.mock.calls[0]![0]).toMatchObject({ gpu: false, build: 'never' })
  })

  it('falls back to the available backend when no CPU build exists (Apple Silicon ships Metal only)', async () => {
    const getLlama = vi.fn(async (o: { gpu?: unknown }) => {
      if (o.gpu === false) throw new NoBinaryFoundError()
      return llama(o.gpu)
    })
    const result = await openLlama(getLlama, false, { build: 'never', skipDownload: true })
    expect(result.backendFallback).toBe(true)
    expect(getLlama.mock.calls.map(([o]) => o.gpu)).toEqual([false, 'auto'])
    expect(getLlama.mock.calls[1]![0]).toMatchObject({ build: 'never', skipDownload: true })
  })

  it('does not hide a missing binary the person asked for explicitly, or any other failure', async () => {
    const missing = vi.fn(async () => {
      throw new NoBinaryFoundError()
    })
    await expect(openLlama(missing, 'vulkan', {})).rejects.toThrow('no binary')
    expect(missing).toHaveBeenCalledTimes(1)
    const broken = vi.fn(async () => {
      throw new Error('dlopen failed')
    })
    await expect(openLlama(broken, false, {})).rejects.toThrow('dlopen failed')
    expect(broken).toHaveBeenCalledTimes(1)
  })

  it('recognises the error by name', () => {
    expect(isNoBinaryFound(new NoBinaryFoundError())).toBe(true)
    expect(isNoBinaryFound(new Error('x'))).toBe(false)
    expect(isNoBinaryFound('NoBinaryFoundError')).toBe(false)
  })
})
