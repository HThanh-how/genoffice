import { deflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'

const calls: Array<{ maxOutputLength?: number } | undefined> = []
vi.mock('node:zlib', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:zlib')>()
  const inflateSync = (buffer: Parameters<typeof real.inflateSync>[0], options?: object) => {
    calls.push(options)
    return real.inflateSync(buffer, options)
  }
  return { ...real, inflateSync, default: { ...real, inflateSync } }
})

import { decodePngGray } from '../src/main/document-memory/local-ocr/gray-image'

const crcTable = Array.from({ length: 256 }, (_x, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc(bytes: Buffer): number {
  let c = 0xffffffff
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, tail])
}

/** a PNG whose header says width x height (8-bit RGB) and whose data is `inflated` bytes of zeros */
function png(width: number, height: number, inflated: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(inflated, 0))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

describe('decodePngGray', () => {
  it('asks zlib for no more than the header says the picture holds', () => {
    calls.length = 0
    // 100 x 100 RGB is 30,100 bytes with the filter bytes; the data says 40 MB
    expect(decodePngGray(png(100, 100, 40 * 1024 * 1024))).toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.maxOutputLength).toBe((100 * 3 + 1) * 100)
  })

  it('still decodes a picture whose data is what the header says', () => {
    const image = decodePngGray(png(40, 30, (40 * 3 + 1) * 30))
    expect(image).toMatchObject({ width: 40, height: 30 })
  })
})
