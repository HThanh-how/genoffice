/**
 * Chromium lays print jobs out at device scale 1, but pagination measured the
 * canvas at the screen's scale, and Blink rounds font ascent/descent to device
 * pixels: a line whose height comes from a taller secondary-font run is up to
 * half a pixel shorter in print than on a Retina screen. Across a document the
 * drift reaches several pixels and the fixed page clips cut through glyphs at
 * the seams. Zooming the sheets by the screen ratio and printing at the inverse
 * scale reproduces the screen rounding, so print geometry equals measurement.
 *
 * The printer job's scale is a whole percent, so its zoom is that percent's
 * exact inverse (1.5 against 67% spills a 0.5% strip onto a blank page), and
 * Windows ignores `scaleFactor` (genoffice#1970). Its printer sheets keep the
 * zoom for text layout, then undo it with a paint-only transform inside an
 * unzoomed paper box. The native job therefore needs no scale compensation.
 */

export type PrintJob = 'pdf' | 'printer'

// Chromium accepts printToPDF scales in 0.1..2
const MAX_ZOOM = 10
const MIN_ZOOM = 0.5

const isWindows = (platform: string) => /^win/i.test(platform)

export function printZoom(
  dpr: number = window.devicePixelRatio,
  job: PrintJob = 'pdf',
  platform: string = navigator.platform,
): number {
  if (!(dpr > 0) || Math.abs(dpr - 1) < 1e-3) return 1
  const zoom = Math.min(Math.max(dpr, MIN_ZOOM), MAX_ZOOM)
  return job === 'printer' && !isWindows(platform) ? 100 / Math.round(100 / zoom) : zoom
}

const previewRoot = () => document.querySelector<HTMLElement>('.pagination-preview')

/** Zooms the preview sheets for print (print media only) and returns the job's print scale. */
export function setPrintZoom(job: PrintJob = 'pdf'): number {
  const zoom = printZoom(undefined, job)
  const root = previewRoot()
  const nativeScale = job === 'printer' && isWindows(navigator.platform) && zoom !== 1
  root?.classList.toggle('pv-print-native-scale', nativeScale)
  if (zoom !== 1) root?.style.setProperty('--pv-print-zoom', String(zoom))
  else root?.style.removeProperty('--pv-print-zoom')
  if (nativeScale) root?.style.setProperty('--pv-print-scale', String(1 / zoom))
  else root?.style.removeProperty('--pv-print-scale')
  return nativeScale ? 1 : 1 / zoom
}

export function clearPrintZoom(): void {
  const root = previewRoot()
  root?.classList.remove('pv-print-native-scale')
  root?.style.removeProperty('--pv-print-zoom')
  root?.style.removeProperty('--pv-print-scale')
}
