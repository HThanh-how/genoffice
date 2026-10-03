import { describe, expect, it } from 'vitest'
import { fitChatPanel } from '../src/renderer/src/home-chat/panel-size'

describe('saved chat panel size', () => {
  it('keeps a chosen size on a screen with enough room', () => {
    expect(fitChatPanel(800, 600, 1440, 1000)).toEqual({ w: 800, h: 600 })
  })
  it('fits a phone-width or short window instead of overflowing its minimum', () => {
    const fitted = fitChatPanel(880, 660, 390, 320)
    expect(fitted.w).toBeLessThanOrEqual(390 - 32)
    expect(fitted.h).toBeLessThanOrEqual(320 - 96)
    expect(fitted.w).toBeGreaterThan(0)
    expect(fitted.h).toBeGreaterThan(0)
  })
  it('recovers from invalid saved values and accidental tiny resize gestures', () => {
    expect(fitChatPanel(NaN, Infinity, 1440, 1000)).toEqual({ w: 880, h: 660 })
    expect(fitChatPanel(-10, 0, 1440, 1000)).toEqual({ w: 460, h: 380 })
  })
})
