import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { atomicWriteFile } from '../atomic-write'
import type { StoredMediaAsset } from '../../shared/opening-card-types'

export const MAX_MEDIA_ASSET_BYTES = 10 * 1024 * 1024 // 10 MB cap
export const MAX_BASE64_MEDIA_CHARS = 14 * 1024 * 1024 // ~14 MB string cap

export function isBase64PayloadLengthSafe(str: unknown): boolean {
  return typeof str === 'string' && str.length > 0 && str.length <= MAX_BASE64_MEDIA_CHARS
}

const ASSET_ID_REGEX = /^asset_[0-9]+_[0-9a-f]{16}\.(png|jpg|webp|gif)$/i

export interface SniffedMediaFormat {
  mime: string
  ext: string
}

/**
 * Validates file signature (magic bytes) to guarantee the asset is a genuine image
 * and not executable code, HTML, SVG with scripts, or an arbitrary binary.
 */
export function sniffImageSignature(buffer: Buffer): SniffedMediaFormat | null {
  if (buffer.length < 12) return null

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: '.png' }
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', ext: '.jpg' }
  }

  // WebP: 'RIFF' .... 'WEBP'
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { mime: 'image/webp', ext: '.webp' }
  }

  // GIF: 'GIF87a' or 'GIF89a'
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return { mime: 'image/gif', ext: '.gif' }
  }

  return null
}

export function getOpeningAssetsDir(userDataPath: string): string {
  const dir = join(userDataPath, 'opening-card-assets')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function isSafeAssetId(assetId: string): boolean {
  return typeof assetId === 'string' && ASSET_ID_REGEX.test(assetId)
}

export function resolveSafeAssetPath(userDataPath: string, assetId: string): string {
  if (!isSafeAssetId(assetId)) {
    throw new Error(`Invalid asset ID format: ${assetId}`)
  }
  const root = resolve(getOpeningAssetsDir(userDataPath))
  const target = resolve(root, assetId)
  if (!target.startsWith(root) || dirname(target) !== root) {
    throw new Error('Path traversal attempt detected')
  }
  return target
}

function getRegistryPath(userDataPath: string): string {
  return join(getOpeningAssetsDir(userDataPath), 'registry.json')
}

function readRegistry(userDataPath: string): StoredMediaAsset[] | null {
  try {
    const regPath = getRegistryPath(userDataPath)
    if (!existsSync(regPath)) return null
    const content = readFileSync(regPath, 'utf8')
    const list = JSON.parse(content)
    if (Array.isArray(list)) {
      return list.filter(
        (a): a is StoredMediaAsset =>
          a && typeof a.assetId === 'string' && isSafeAssetId(a.assetId),
      )
    }
  } catch {
    // fallback
  }
  return null
}

function writeRegistrySync(userDataPath: string, list: StoredMediaAsset[]): void {
  try {
    const dir = getOpeningAssetsDir(userDataPath)
    if (!existsSync(dir)) return
    const regPath = getRegistryPath(userDataPath)
    writeFileSync(regPath, JSON.stringify(list, null, 2), 'utf8')
  } catch {
    // best-effort
  }
}

function updateRegistryWithAsset(userDataPath: string, asset: StoredMediaAsset): void {
  const current = readRegistry(userDataPath) || []
  const updated = [...current.filter((a) => a.assetId !== asset.assetId), asset]
  writeRegistrySync(userDataPath, updated)
}

function removeAssetFromRegistry(userDataPath: string, assetId: string): void {
  const current = readRegistry(userDataPath)
  if (!current) return
  const updated = current.filter((a) => a.assetId !== assetId)
  writeRegistrySync(userDataPath, updated)
}

export const MAX_IMAGE_DIMENSION_PX = 8192
export const TARGET_THUMBNAIL_MAX_WIDTH = 320
export const TARGET_THUMBNAIL_MAX_HEIGHT = 180

export interface DecodedImageResult {
  width: number
  height: number
  thumbnailDataUrl: string
}

function parseImageDimensions(
  buffer: Buffer,
  mime: string,
): { width: number; height: number } | null {
  if (mime === 'image/png') {
    if (buffer.length < 24) return null
    if (buffer[12] === 0x49 && buffer[13] === 0x48 && buffer[14] === 0x44 && buffer[15] === 0x52) {
      const width = buffer.readUInt32BE(16)
      const height = buffer.readUInt32BE(20)
      if (width > 0 && height > 0 && buffer.length >= 33) {
        return { width, height }
      }
    }
    return null
  }

  if (mime === 'image/gif') {
    if (buffer.length < 10) return null
    const width = buffer.readUInt16LE(6)
    const height = buffer.readUInt16LE(8)
    if (width > 0 && height > 0 && buffer.length >= 14) {
      return { width, height }
    }
    return null
  }

  if (mime === 'image/jpeg') {
    let offset = 2
    while (offset < buffer.length - 8) {
      if (buffer[offset] !== 0xff) {
        offset++
        continue
      }
      const marker = buffer[offset + 1]
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        const height = buffer.readUInt16BE(offset + 5)
        const width = buffer.readUInt16BE(offset + 7)
        if (width > 0 && height > 0) {
          return { width, height }
        }
        return null
      }
      const length = buffer.readUInt16BE(offset + 2)
      offset += 2 + length
    }
    return null
  }

  if (mime === 'image/webp') {
    if (buffer.length < 30) return null
    if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x20) {
      const width = buffer.readUInt16LE(26) & 0x3fff
      const height = buffer.readUInt16LE(28) & 0x3fff
      if (width > 0 && height > 0) return { width, height }
    }
    if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x4c) {
      if (buffer[20] === 0x2f) {
        const b0 = buffer[21]
        const b1 = buffer[22]
        const b2 = buffer[23]
        const b3 = buffer[24]
        const width = 1 + (((b1 & 0x3f) << 8) | b0)
        const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
        if (width > 0 && height > 0) return { width, height }
      }
    }
    if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x58) {
      const width = 1 + buffer.readUIntLE(24, 3)
      const height = 1 + buffer.readUIntLE(27, 3)
      if (width > 0 && height > 0) return { width, height }
    }
    return null
  }

  return null
}

function getNativeImageApi() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron')
    if (electron && typeof electron.nativeImage?.createFromBuffer === 'function') {
      return electron.nativeImage
    }
  } catch {
    // fallback
  }
  return null
}

export function validateAndDecodeImage(buffer: Buffer, mime: string): DecodedImageResult {
  const nativeApi = getNativeImageApi()
  if (nativeApi) {
    const img = nativeApi.createFromBuffer(buffer)
    if (img.isEmpty()) {
      throw new Error(
        'Corrupt or undecodable image payload: image contains no decodable pixel data',
      )
    }
    const size = img.getSize()
    if (size.width <= 0 || size.height <= 0) {
      throw new Error('Corrupt or undecodable image payload: invalid image dimensions')
    }
    if (size.width > MAX_IMAGE_DIMENSION_PX || size.height > MAX_IMAGE_DIMENSION_PX) {
      throw new Error(
        `Image dimensions exceed the maximum allowed limit of ${MAX_IMAGE_DIMENSION_PX}x${MAX_IMAGE_DIMENSION_PX} pixels`,
      )
    }

    let thumbW = size.width
    let thumbH = size.height
    if (thumbW > TARGET_THUMBNAIL_MAX_WIDTH || thumbH > TARGET_THUMBNAIL_MAX_HEIGHT) {
      const scale = Math.min(
        TARGET_THUMBNAIL_MAX_WIDTH / thumbW,
        TARGET_THUMBNAIL_MAX_HEIGHT / thumbH,
      )
      thumbW = Math.max(1, Math.round(thumbW * scale))
      thumbH = Math.max(1, Math.round(thumbH * scale))
    }
    const thumbImg =
      thumbW === size.width && thumbH === size.height
        ? img
        : img.resize({ width: thumbW, height: thumbH, quality: 'good' })
    const thumbPngBuffer = thumbImg.toPNG()
    const thumbnailDataUrl = `data:image/png;base64,${thumbPngBuffer.toString('base64')}`

    return {
      width: size.width,
      height: size.height,
      thumbnailDataUrl,
    }
  }

  const dims = parseImageDimensions(buffer, mime)
  if (!dims || dims.width <= 0 || dims.height <= 0) {
    throw new Error('Corrupt or undecodable image payload: image contains no decodable pixel data')
  }
  if (dims.width > MAX_IMAGE_DIMENSION_PX || dims.height > MAX_IMAGE_DIMENSION_PX) {
    throw new Error(
      `Image dimensions exceed the maximum allowed limit of ${MAX_IMAGE_DIMENSION_PX}x${MAX_IMAGE_DIMENSION_PX} pixels`,
    )
  }

  const fallbackPng =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  return {
    width: dims.width,
    height: dims.height,
    thumbnailDataUrl: fallbackPng,
  }
}

/**
 * Validates, saves, and registers personal media into app-managed isolated storage.
 */
export async function storeMediaAssetFromBuffer(
  userDataPath: string,
  buffer: Buffer,
): Promise<StoredMediaAsset> {
  if (buffer.length === 0) {
    throw new Error('File is empty')
  }
  if (buffer.length > MAX_MEDIA_ASSET_BYTES) {
    throw new Error(`File exceeds maximum limit of ${MAX_MEDIA_ASSET_BYTES / (1024 * 1024)} MB`)
  }

  const sniffed = sniffImageSignature(buffer)
  if (!sniffed) {
    throw new Error('Unsupported image format. Allowed formats: PNG, JPEG, WebP, GIF.')
  }

  const decoded = validateAndDecodeImage(buffer, sniffed.mime)

  const nonce = randomBytes(8).toString('hex')
  const assetId = `asset_${Date.now()}_${nonce}${sniffed.ext}`
  const targetPath = resolveSafeAssetPath(userDataPath, assetId)

  await atomicWriteFile(targetPath, buffer)

  const assetRecord: StoredMediaAsset = {
    assetId,
    mime: sniffed.mime,
    sizeBytes: buffer.length,
    thumbnailUrl: decoded.thumbnailDataUrl,
    createdAt: Date.now(),
  }

  updateRegistryWithAsset(userDataPath, assetRecord)

  return assetRecord
}

/**
 * Reads an asset by ID and returns a safe data URL for rendering in CSP-restricted pages.
 */
export function getAssetDataUrl(userDataPath: string, assetId: string): string {
  const filePath = resolveSafeAssetPath(userDataPath, assetId)
  if (!existsSync(filePath)) {
    throw new Error(`Asset not found: ${assetId}`)
  }
  const buf = readFileSync(filePath)
  const sniffed = sniffImageSignature(buf)
  const mime = sniffed?.mime ?? 'image/png'
  return `data:${mime};base64,${buf.toString('base64')}`
}

/**
 * Safely deletes a media asset owned by this feature.
 */
export function deleteMediaAsset(userDataPath: string, assetId: string): boolean {
  try {
    const filePath = resolveSafeAssetPath(userDataPath, assetId)
    if (existsSync(filePath)) {
      unlinkSync(filePath)
      removeAssetFromRegistry(userDataPath, assetId)
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Lists all existing valid media assets in storage.
 * Uses registry cache to avoid reading full image buffers from disk.
 */
export function listMediaAssets(userDataPath: string): StoredMediaAsset[] {
  const dir = getOpeningAssetsDir(userDataPath)
  const cached = readRegistry(userDataPath)
  if (cached) {
    const valid = cached.filter((a) => existsSync(join(dir, a.assetId)))
    if (valid.length === cached.length) {
      return valid
    }
  }

  try {
    const files = readdirSync(dir)
    const result: StoredMediaAsset[] = []
    for (const f of files) {
      if (isSafeAssetId(f)) {
        try {
          const filePath = join(dir, f)
          const s = statSync(filePath)
          const fd = openSync(filePath, 'r')
          const header = Buffer.alloc(16)
          readSync(fd, header, 0, 16, 0)
          closeSync(fd)

          const sniffed = sniffImageSignature(header)
          if (sniffed) {
            result.push({
              assetId: f,
              mime: sniffed.mime,
              sizeBytes: s.size,
              createdAt: s.mtimeMs,
            })
          }
        } catch {
          // ignore corrupted unstat-able file
        }
      }
    }
    writeRegistrySync(userDataPath, result)
    return result
  } catch {
    return []
  }
}
