import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearPrintZoom, printZoom, setPrintZoom } from '../src/renderer/print-zoom'

const setDpr = (dpr: number) =>
  Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true })

describe('printZoom', () => {
  it('reproduces the screen device scale and is a no-op at 1', () => {
    expect(printZoom(1)).toBe(1)
    expect(printZoom(2)).toBe(2)
    expect(printZoom(1.5)).toBe(1.5)
  })

  it('printer jobs take the exact inverse of a whole-percent scale', () => {
    expect(printZoom(1.5, 'printer', 'MacIntel')).toBeCloseTo(100 / 67, 10)
    expect(printZoom(2, 'printer', 'MacIntel')).toBe(2)
    expect(printZoom(1.25, 'printer', 'MacIntel')).toBe(1.25)
    expect(printZoom(1.5, 'pdf', 'MacIntel')).toBe(1.5)
  })

  it('Windows printer sheets retain screen layout metrics without percent rounding', () => {
    expect(printZoom(2, 'printer', 'Win32')).toBe(2)
    expect(printZoom(1.5, 'printer', 'Win32')).toBe(1.5)
    expect(printZoom(2, 'pdf', 'Win32')).toBe(2)
  })

  it('clamps to the range Chromium print scales can invert', () => {
    expect(printZoom(20)).toBe(10)
    expect(printZoom(0.25)).toBe(0.5)
    expect(printZoom(NaN)).toBe(1)
  })
})

describe('setPrintZoom', () => {
  it.each([1, 1.25, 1.5, 2])(
    'Windows at DPR %s uses CSS compensation and an unscaled native job',
    (dpr) => {
      vi.stubGlobal('navigator', { platform: 'Win32' })
      document.body.innerHTML = '<div class="pagination-preview"></div>'
      setDpr(dpr)
      const root = document.querySelector<HTMLElement>('.pagination-preview')!
      expect(setPrintZoom('printer')).toBe(1)
      expect(root.classList.contains('pv-print-native-scale')).toBe(dpr !== 1)
      expect(root.style.getPropertyValue('--pv-print-scale')).toBe(dpr === 1 ? '' : String(1 / dpr))
      expect(root.style.getPropertyValue('--pv-print-zoom')).toBe(dpr === 1 ? '' : String(dpr))
      clearPrintZoom()
      expect(root.classList.contains('pv-print-native-scale')).toBe(false)
      expect(root.style.cssText).toBe('')
    },
  )

  it('a PDF job after Windows printing restores the PDF pipeline', () => {
    vi.stubGlobal('navigator', { platform: 'Win32' })
    document.body.innerHTML = '<div class="pagination-preview"></div>'
    setDpr(1.5)
    setPrintZoom('printer')
    expect(setPrintZoom('pdf')).toBe(1 / 1.5)
    const root = document.querySelector<HTMLElement>('.pagination-preview')!
    expect(root.classList.contains('pv-print-native-scale')).toBe(false)
    expect(root.style.getPropertyValue('--pv-print-scale')).toBe('')
    expect(root.style.getPropertyValue('--pv-print-zoom')).toBe('1.5')
  })

  afterEach(() => {
    document.body.innerHTML = ''
    setDpr(1)
    vi.unstubAllGlobals()
  })

  it('zooms the preview root by the device scale and returns the inverse print scale', () => {
    document.body.innerHTML = '<div class="pagination-preview"></div>'
    setDpr(2)
    expect(setPrintZoom()).toBe(0.5)
    const root = document.querySelector<HTMLElement>('.pagination-preview')!
    expect(root.style.getPropertyValue('--pv-print-zoom')).toBe('2')
    clearPrintZoom()
    expect(root.style.getPropertyValue('--pv-print-zoom')).toBe('')
  })

  it('leaves the preview untouched on standard-density screens', () => {
    document.body.innerHTML = '<div class="pagination-preview"></div>'
    setDpr(1)
    expect(setPrintZoom()).toBe(1)
    expect(
      document
        .querySelector<HTMLElement>('.pagination-preview')!
        .style.getPropertyValue('--pv-print-zoom'),
    ).toBe('')
  })
})
