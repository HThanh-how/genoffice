import { describe, expect, it } from 'vitest'
import * as core from '@genoffice/electron-utils/image-cutout-core'
import { removeBackground, sampleBackgroundColors } from '../src/cutout'

describe('cutout in the renderer dialogs', () => {
  it('is the single shared implementation from electron-utils', () => {
    expect(removeBackground).toBe(core.removeBackground)
    expect(sampleBackgroundColors).toBe(core.sampleBackgroundColors)
  })

  it('still cuts a flat backdrop away from the edge', () => {
    const data = new Uint8ClampedArray(16 * 16 * 4).fill(255)
    for (let y = 6; y < 10; y++)
      for (let x = 6; x < 10; x++) {
        const i = (y * 16 + x) * 4
        data[i] = 10
        data[i + 1] = 10
        data[i + 2] = 10
      }
    const out = removeBackground({ data, width: 16, height: 16 }, 10)
    expect(out.removedCount).toBe(16 * 16 - 16)
    expect(out.data[3]).toBe(0)
    expect(out.data[(8 * 16 + 8) * 4 + 3]).toBe(255)
  })
})
