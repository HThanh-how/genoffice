import { describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ empty: false }))
vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: () => ({
      isEmpty: () => native.empty,
      getSize: () => ({ width: 2, height: 1 }),
      // BGRA, the order Chromium hands out
      toBitmap: () => Buffer.from([30, 20, 10, 255, 3, 2, 1, 0]),
    }),
  },
}))

import { decodeWithElectron } from '../src/image-cutout-electron'

describe('decodeWithElectron', () => {
  it('converts the BGRA bitmap to RGBA', async () => {
    native.empty = false
    const img = await decodeWithElectron(new Uint8Array([1, 2, 3]))
    expect(img?.width).toBe(2)
    expect(img?.height).toBe(1)
    expect(Array.from(img!.data)).toEqual([10, 20, 30, 255, 1, 2, 3, 0])
  })

  it('answers null for bytes Chromium cannot read', async () => {
    native.empty = true
    expect(await decodeWithElectron(new Uint8Array([1]))).toBeNull()
  })
})
