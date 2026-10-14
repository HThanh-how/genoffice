import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_MEDIA_ASSET_BYTES,
  deleteMediaAsset,
  getAssetDataUrl,
  isSafeAssetId,
  listMediaAssets,
  resolveSafeAssetPath,
  sniffImageSignature,
  storeMediaAssetFromBuffer,
  validateAndDecodeImage,
} from '../src/main/fork/opening-media-storage'

// Valid minimal image headers
const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
])
const JPEG_HEADER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
])
const WEBP_HEADER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
])
const GIF_HEADER = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x0a, 0x00, 0x0a, 0x00, 0x80, 0x00,
])

export const VALID_1X1_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

export const VALID_1X1_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
)

export const VALID_1X1_WEBP = Buffer.from(
  'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/v3AgAA=',
  'base64',
)

export const VALID_1X1_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
)

function createLargeValidPng(width = 400, height = 300, minBytes = 140 * 1024): Buffer {
  const raw = randomBytes(Math.max(minBytes, height * (1 + width * 3)))
  const compressed = deflateSync(raw)

  function makeChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const t = Buffer.from(type)
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])))
    return Buffer.concat([len, t, data, crcBuf])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 8-bit depth
  ihdr[9] = 2 // RGB color
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    header,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ])
}

describe('Opening Card Studio: Media Storage Security & Magic Bytes Sniffing', () => {
  let tempUserData: string

  beforeEach(() => {
    tempUserData = mkdtempSync(join(tmpdir(), 'genoffice-media-test-'))
  })

  afterEach(() => {
    rmSync(tempUserData, { recursive: true, force: true })
  })

  it('accurately identifies genuine PNG, JPEG, WebP, and GIF magic bytes', () => {
    expect(sniffImageSignature(PNG_HEADER)).toEqual({ mime: 'image/png', ext: '.png' })
    expect(sniffImageSignature(JPEG_HEADER)).toEqual({ mime: 'image/jpeg', ext: '.jpg' })
    expect(sniffImageSignature(WEBP_HEADER)).toEqual({ mime: 'image/webp', ext: '.webp' })
    expect(sniffImageSignature(GIF_HEADER)).toEqual({ mime: 'image/gif', ext: '.gif' })
  })

  it('strictly rejects malicious payloads, scripts, or executables disguised as images', () => {
    const bashScript = Buffer.from('#!/bin/bash\necho "pwned"\n')
    const htmlPayload = Buffer.from('<!DOCTYPE html><html><script>alert(1)</script></html>')
    const windowsExe = Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff')

    expect(sniffImageSignature(bashScript)).toBeNull()
    expect(sniffImageSignature(htmlPayload)).toBeNull()
    expect(sniffImageSignature(windowsExe)).toBeNull()
  })

  it('rejects files exceeding the 10 MB maximum size cap', async () => {
    const oversizedBuffer = Buffer.alloc(MAX_MEDIA_ASSET_BYTES + 1024)
    PNG_HEADER.copy(oversizedBuffer, 0)

    await expect(storeMediaAssetFromBuffer(tempUserData, oversizedBuffer)).rejects.toThrow(
      'File exceeds maximum limit',
    )
  })

  it('rejects empty files', async () => {
    await expect(storeMediaAssetFromBuffer(tempUserData, Buffer.alloc(0))).rejects.toThrow(
      'File is empty',
    )
  })

  it('validates safe asset IDs and rejects path traversal attempts', () => {
    expect(isSafeAssetId('asset_1728860000_0123456789abcdef.png')).toBe(true)
    expect(isSafeAssetId('asset_1728860000_0123456789abcdef.jpg')).toBe(true)

    // Path traversal attacks
    expect(isSafeAssetId('../../etc/passwd')).toBe(false)
    expect(isSafeAssetId('..\\..\\windows\\system32')).toBe(false)
    expect(isSafeAssetId('asset_1728860000_0123456789abcdef.exe')).toBe(false)
    expect(isSafeAssetId('asset_1728860000_0123456789abcdef.png/sub')).toBe(false)

    expect(() => resolveSafeAssetPath(tempUserData, '../../etc/passwd')).toThrow(
      'Invalid asset ID format',
    )
  })

  it('T1-T4: stores real PNG (> 128 KB), generates bounded thumbnail, and validates MIME', async () => {
    const largePng = createLargeValidPng(400, 300, 140 * 1024)
    expect(largePng.length).toBeGreaterThan(128 * 1024)

    const stored = await storeMediaAssetFromBuffer(tempUserData, largePng)

    expect(stored.assetId).toMatch(/^asset_[0-9]+_[0-9a-f]{16}\.png$/)
    expect(stored.mime).toBe('image/png')
    expect(stored.sizeBytes).toBe(largePng.length)
    expect(stored.thumbnailUrl.startsWith('data:image/png;base64,')).toBe(true)

    // T10: Verify stored bytes on disk match source exactly
    const storedPath = resolveSafeAssetPath(tempUserData, stored.assetId)
    const onDiskBytes = readFileSync(storedPath)
    expect(onDiskBytes.length).toBe(largePng.length)
    expect(onDiskBytes.equals(largePng)).toBe(true)
  })

  it('T5-T7: imports valid JPEG, WebP, and GIF images and assigns correct metadata', async () => {
    const jpegAsset = await storeMediaAssetFromBuffer(tempUserData, VALID_1X1_JPEG)
    expect(jpegAsset.mime).toBe('image/jpeg')
    expect(jpegAsset.sizeBytes).toBe(VALID_1X1_JPEG.length)

    const webpAsset = await storeMediaAssetFromBuffer(tempUserData, VALID_1X1_WEBP)
    expect(webpAsset.mime).toBe('image/webp')
    expect(webpAsset.sizeBytes).toBe(VALID_1X1_WEBP.length)

    const gifAsset = await storeMediaAssetFromBuffer(tempUserData, VALID_1X1_GIF)
    expect(gifAsset.mime).toBe('image/gif')
    expect(gifAsset.sizeBytes).toBe(VALID_1X1_GIF.length)

    const allAssets = listMediaAssets(tempUserData)
    expect(allAssets).toHaveLength(3)
  })

  it('T8: strictly rejects file containing only PNG header without decodable pixel data', async () => {
    // Header only payload
    await expect(storeMediaAssetFromBuffer(tempUserData, PNG_HEADER)).rejects.toThrow(
      'Corrupt or undecodable image payload',
    )

    // Truncated payload after IHDR
    const truncatedIhdr = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52,
    ])
    await expect(storeMediaAssetFromBuffer(tempUserData, truncatedIhdr)).rejects.toThrow(
      'Corrupt or undecodable image payload',
    )
  })

  it('stores valid assets, generates base64 data URLs, and lists assets correctly', async () => {
    const stored = await storeMediaAssetFromBuffer(tempUserData, VALID_1X1_PNG)

    expect(stored.assetId).toMatch(/^asset_[0-9]+_[0-9a-f]{16}\.png$/)
    expect(stored.mime).toBe('image/png')
    expect(stored.sizeBytes).toBe(VALID_1X1_PNG.length)

    // Data URL verification
    const dataUrl = getAssetDataUrl(tempUserData, stored.assetId)
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true)

    // Listing
    const assets = listMediaAssets(tempUserData)
    expect(assets).toHaveLength(1)
    expect(assets[0]?.assetId).toBe(stored.assetId)

    // Deletion
    const deleted = deleteMediaAsset(tempUserData, stored.assetId)
    expect(deleted).toBe(true)
    expect(listMediaAssets(tempUserData)).toHaveLength(0)
  })

  it('validateAndDecodeImage parses dimensions and generates valid thumbnail', () => {
    const res = validateAndDecodeImage(VALID_1X1_PNG, 'image/png')
    expect(res.width).toBe(1)
    expect(res.height).toBe(1)
    expect(res.thumbnailDataUrl).toContain('data:image/png;base64,')
  })
})
