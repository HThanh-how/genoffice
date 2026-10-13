import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('stores valid assets, generates base64 data URLs, and lists assets correctly', async () => {
    const pngData = Buffer.concat([PNG_HEADER, Buffer.from('sample png data payload')])
    const stored = await storeMediaAssetFromBuffer(tempUserData, pngData)

    expect(stored.assetId).toMatch(/^asset_[0-9]+_[0-9a-f]{16}\.png$/)
    expect(stored.mime).toBe('image/png')
    expect(stored.sizeBytes).toBe(pngData.length)

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
})
