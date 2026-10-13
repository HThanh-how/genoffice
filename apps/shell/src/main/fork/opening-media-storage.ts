import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { atomicWriteFile } from '../atomic-write'

export const MAX_MEDIA_ASSET_BYTES = 10 * 1024 * 1024 // 10 MB cap

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

export interface StoredMediaAsset {
  assetId: string
  mime: string
  sizeBytes: number
  dataUrl?: string
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

  const nonce = randomBytes(8).toString('hex')
  const assetId = `asset_${Date.now()}_${nonce}${sniffed.ext}`
  const targetPath = resolveSafeAssetPath(userDataPath, assetId)

  await atomicWriteFile(targetPath, buffer)

  return {
    assetId,
    mime: sniffed.mime,
    sizeBytes: buffer.length,
  }
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
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Lists all existing valid media assets in storage.
 */
export function listMediaAssets(userDataPath: string): StoredMediaAsset[] {
  const dir = getOpeningAssetsDir(userDataPath)
  try {
    const files = readdirSync(dir)
    const result: StoredMediaAsset[] = []
    for (const f of files) {
      if (isSafeAssetId(f)) {
        try {
          const s = statSync(join(dir, f))
          const fd = readFileSync(join(dir, f))
          const sniffed = sniffImageSignature(fd.subarray(0, 16))
          result.push({
            assetId: f,
            mime: sniffed?.mime ?? 'image/png',
            sizeBytes: s.size,
          })
        } catch {
          // ignore corrupted unstat-able file
        }
      }
    }
    return result
  } catch {
    return []
  }
}
