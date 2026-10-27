import type { RenderSlide } from '@genoffice/pptx-render'
import type { SlideUpdate } from './ipc'

/** Merge by stable part identity, including when a full broadcast arrived first. */
export function mergeSlideUpdate(current: RenderSlide[], update: SlideUpdate): RenderSlide[] {
  const byPath = new Map(current.map((slide) => [slide.partPath, slide]))
  for (const slide of update.slides) byPath.set(slide.partPath, slide)
  return update.order.map((path) => {
    const slide = byPath.get(path)
    if (!slide) throw new Error(`Missing slide in render update: ${path}`)
    return slide
  })
}
