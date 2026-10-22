import { describe, expect, it } from 'vitest'
import { AppActionSequence, spotlightRect } from '../src/app-action-steps'

describe('spotlight viewport geometry', () => {
  it('pads and clips the measured rectangle to its own viewport', () => {
    expect(spotlightRect({ x: -5, y: 10, width: 30, height: 40 }, 100, 50)).toEqual({
      x: 0,
      y: 4,
      width: 31,
      height: 46,
    })
    expect(spotlightRect({ x: 90, y: 40, width: 30, height: 30 }, 100, 50, 0)).toEqual({
      x: 90,
      y: 40,
      width: 10,
      height: 10,
    })
  })
  it.each([
    { x: 150, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: 0, height: 10 },
    { x: NaN, y: 0, width: 10, height: 10 },
    { x: 0, y: Infinity, width: 10, height: 10 },
  ])('does not invent a rectangle for invisible/invalid geometry', (rect) =>
    expect(spotlightRect(rect, 100, 100)).toBeNull(),
  )
})
describe('observed step sequencing', () => {
  it('ignores out-of-order and wrong events, then completes in order', () => {
    const guide = new AppActionSequence([
      { label: 'File', event: 'click' },
      { label: 'PDF', event: 'click' },
      { label: 'Dialog', event: 'observe' },
    ])
    expect(guide.observe(1, 'click')).toBe(false)
    expect(guide.observe(0, 'observe')).toBe(false)
    expect(guide.index).toBe(0)
    expect(guide.observe(0, 'click')).toBe(true)
    expect(guide.observe(0, 'click')).toBe(false)
    guide.observe(1, 'click')
    expect(guide.done).toBe(false)
    guide.observe(2, 'observe')
    expect(guide.done).toBe(true)
  })
  it('cancellation permanently blocks further advancement', () => {
    const guide = new AppActionSequence([{ label: 'File', event: 'click' }])
    guide.cancel()
    expect(guide.observe(0, 'click')).toBe(false)
    expect(guide.done).toBe(false)
  })
})
