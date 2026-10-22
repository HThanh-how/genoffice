import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PrintDialog } from '../src/renderer/components/PrintDialog'

let root: Root | undefined

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Windows PrintDialog', () => {
  it.each([{ ok: true }, { ok: false }, { ok: false, error: 'printer offline' }])(
    'prints the selected sheets at native scale and cleans up after %j',
    async (result) => {
      vi.useFakeTimers()
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
      vi.stubGlobal('navigator', { platform: 'Win32' })
      vi.stubGlobal('devicePixelRatio', 1.5)
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          disconnect() {}
        },
      )
      document.body.innerHTML = `
      <div class="pagination-preview"><div class="pv-scroll">
        <div class="pv-print-sheet"><div class="pv-page" style="width:794px;height:1123px">first</div></div>
        <div class="pv-print-sheet"><div class="pv-page" style="width:794px;height:1123px">second</div></div>
      </div></div><div id="dialog"></div>`
      const preview = document.querySelector<HTMLElement>('.pagination-preview')!
      const pages = [...preview.querySelectorAll<HTMLElement>('.pv-page')]
      let finish!: (r: typeof result) => void
      const print = vi.fn(() => {
        expect(preview.classList.contains('pv-print-native-scale')).toBe(true)
        expect(preview.style.getPropertyValue('--pv-print-zoom')).toBe('1.5')
        expect(pages.map((p) => p.classList.contains('pv-print-skip'))).toEqual([false, true])
        expect(pages.map((p) => p.classList.contains('pv-print-tail'))).toEqual([true, false])
        return new Promise<typeof result>((resolve) => {
          finish = resolve
        })
      })
      vi.stubGlobal('desktop', { listPrinters: async () => [], print })
      const onClose = vi.fn()
      const setStatus = vi.fn()
      root = createRoot(document.querySelector('#dialog')!)
      await act(async () => root!.render(createElement(PrintDialog, { onClose, setStatus })))
      await act(async () => vi.advanceTimersByTime(500))
      const radios = document.querySelectorAll<HTMLInputElement>(
        '.print-options input[type="radio"]',
      )
      act(() => radios[1].click()) // current page only
      act(() => document.querySelector<HTMLButtonElement>('.modal-actions .primary')!.click())
      expect(print).toHaveBeenCalledWith(1, {
        deviceName: '',
        copies: 1,
        collate: true,
        duplex: 'simplex',
      })
      // Pagination polling must still see exactly two source pages during a job.
      await act(async () => vi.advanceTimersByTime(500))
      expect(document.querySelector('.print-preview-nav span')!.textContent).toContain('2')
      await act(async () => finish(result))
      expect(preview.classList.contains('pv-print-native-scale')).toBe(false)
      expect(preview.style.cssText).toBe('')
      expect(
        pages.every(
          (p) => !p.classList.contains('pv-print-skip') && !p.classList.contains('pv-print-tail'),
        ),
      ).toBe(true)
      expect(onClose).toHaveBeenCalledTimes(result.ok ? 1 : 0)
      expect(setStatus).toHaveBeenCalledTimes('error' in result ? 1 : 0)
    },
  )
})
