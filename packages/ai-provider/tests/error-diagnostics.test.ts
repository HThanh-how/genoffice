import { expect, it, vi } from 'vitest'
import { setAiErrorLogger, streamForProvider } from '../src/stream'
it('records no key or document contents, preserves the provider exception', async () => {
  const log = vi.fn()
  setAiErrorLogger(log)
  await expect(
    streamForProvider(
      'gemini',
      { model: 'test', apiKey: '' },
      'private document',
      [],
      [],
      100,
      {} as never,
    ),
  ).rejects.toThrow('Set an API key')
  expect(log).toHaveBeenCalledOnce()
  expect(log.mock.calls[0][0]).toMatchObject({
    provider: 'gemini',
    status: null,
    category: 'other',
  })
  expect(JSON.stringify(log.mock.calls)).not.toContain('private document')
  expect(JSON.stringify(log.mock.calls)).not.toContain('Set an API key')
})
it('a failing logger cannot mask an AI error', async () => {
  setAiErrorLogger(() => {
    throw new Error('Logger broken')
  })
  await expect(
    streamForProvider('gemini', { model: 'test', apiKey: '' }, '', [], [], 100, {} as never),
  ).rejects.toThrow('Set an API key')
})
