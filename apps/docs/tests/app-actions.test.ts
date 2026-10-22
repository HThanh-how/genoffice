import { describe, expect, it, vi } from 'vitest'
import { docsAppActions } from '../src/renderer/app-actions'

vi.mock('@genoffice/ui', () => ({ waitForActionStep: vi.fn(async () => {}) }))
const input = { kind: 'app_action' as const, id: 'export-pdf' as const, args: {}, teach: false }
describe('Docs app commands', () => {
  it('PDF success is based on the existing export promise', async () => {
    let resolve!: (value: boolean) => void
    const exportPdf = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          resolve = r
        }),
    )
    const registry = docsAppActions(vi.fn(), exportPdf)
    const settled = vi.fn()
    const work = registry.get('export-pdf').run(input, new AbortController().signal).then(settled)
    expect(settled).not.toHaveBeenCalled()
    resolve(true)
    await work
    expect(settled).toHaveBeenCalledWith({ status: 'completed' })
    expect(registry.get('export-pdf').risk).toBe('confirm')
  })
  it('does not claim a saved PDF when the save dialog was cancelled', async () => {
    const registry = docsAppActions(
      vi.fn(),
      vi.fn(async () => false),
    )
    expect(await registry.get('export-pdf').run(input, new AbortController().signal)).toEqual({
      status: 'cancelled',
    })
  })
  it('printing acknowledges only the dialog handoff', async () => {
    const registry = docsAppActions(
      vi.fn(async () => true),
      vi.fn(),
    )
    expect(
      await registry.get('print').run({ ...input, id: 'print' }, new AbortController().signal),
    ).toEqual({ status: 'handoff' })
    expect(registry.get('print').steps[0]?.selector).toBeUndefined()
  })
})
