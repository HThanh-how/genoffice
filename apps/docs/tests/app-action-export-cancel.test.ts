import { beforeEach, expect, it, vi } from 'vitest'
import { exportPdf, printDoc, type FileActionContext } from '../src/renderer/file-actions'

const phased = vi.hoisted(() => ({ pending: false, wait: vi.fn(async () => {}) }))
vi.mock('../src/renderer/phased-content', () => ({
  isPhasedContentPending: () => phased.pending,
  waitForFullContent: () => phased.wait(),
  cancelPhasedContent: vi.fn(),
  setContentPhased: vi.fn(),
}))
beforeEach(() => {
  phased.pending = false
  phased.wait.mockReset().mockResolvedValue(undefined)
  document.body.innerHTML = ''
})
function context() {
  return {
    doc: { fileName: 'bound-document.docx', parsed: { blocks: [] } },
    sections: [],
    pendingMixedExportRef: { current: false },
    printAutoOpenedPreviewRef: { current: false },
    setShowPagePreview: vi.fn(),
    setShowPrintDialog: vi.fn(),
    setStatus: vi.fn(),
    bumpPendingExportTick: vi.fn(),
  } as unknown as FileActionContext
}
it('stopping PDF export while full content loads cannot open a preview or native dialog', async () => {
  let ready!: () => void
  phased.wait.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        ready = resolve
      }),
  )
  const ctx = context()
  const controller = new AbortController()
  const result = exportPdf(ctx, undefined, controller.signal)
  controller.abort()
  ready()
  expect(await result).toBe(false)
  expect(ctx.setShowPagePreview).not.toHaveBeenCalled()
  expect(ctx.pendingMixedExportRef.current).toBe(false)
})
it('a parked PDF export settles and clears its reference on cancellation', async () => {
  const ctx = context()
  const controller = new AbortController()
  const result = exportPdf(ctx, undefined, controller.signal)
  await vi.waitFor(() => expect(ctx.pendingMixedExportRef.current).not.toBe(false))
  controller.abort()
  expect(await result).toBe(false)
  expect(ctx.pendingMixedExportRef.current).toBe(false)
})
it('stopping print while phased content loads cannot open its dialog afterwards', async () => {
  phased.pending = true
  let ready!: () => void
  phased.wait.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        ready = resolve
      }),
  )
  const ctx = context()
  const controller = new AbortController()
  const result = printDoc(ctx, controller.signal)
  controller.abort()
  phased.pending = false
  ready()
  expect(await result).toBe(false)
  expect(ctx.setShowPrintDialog).not.toHaveBeenCalled()
})
