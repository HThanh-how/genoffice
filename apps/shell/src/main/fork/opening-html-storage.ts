/**
 * Opening Card Studio — HTML Asset Storage & Management
 * Stores, retrieves, and validates AI-generated and custom HTML opening cards
 * in isolated, app-managed storage with atomic writes and path-traversal guards.
 */

import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { atomicWriteFile } from '../atomic-write'
import type { StoredHtmlAsset } from '../../shared/opening-card-types'
import { sanitizeOpeningCss, sanitizeOpeningHtml } from './opening-card-html-sanitizer'

const HTML_ASSET_ID_REGEX = /^html_[0-9]+_[0-9a-f]{16}\.json$/i

export function isSafeHtmlAssetId(assetId: string): boolean {
  return typeof assetId === 'string' && HTML_ASSET_ID_REGEX.test(assetId)
}

export function getOpeningHtmlDir(userDataPath: string): string {
  const dir = join(userDataPath, 'opening-card-assets', 'html')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function resolveSafeHtmlAssetPath(userDataPath: string, assetId: string): string {
  if (!isSafeHtmlAssetId(assetId)) {
    throw new Error(`Invalid HTML asset ID format: ${assetId}`)
  }
  const root = resolve(getOpeningHtmlDir(userDataPath))
  const target = resolve(root, assetId)
  if (!target.startsWith(root) || dirname(target) !== root) {
    throw new Error('Path traversal attempt detected')
  }
  return target
}

function getHtmlRegistryPath(userDataPath: string): string {
  return join(userDataPath, 'opening-card-assets', 'registry-html.json')
}

function readHtmlRegistry(userDataPath: string): StoredHtmlAsset[] | null {
  try {
    const regPath = getHtmlRegistryPath(userDataPath)
    if (!existsSync(regPath)) return null
    const content = readFileSync(regPath, 'utf8')
    const list = JSON.parse(content)
    if (Array.isArray(list)) {
      return list.filter(
        (a): a is StoredHtmlAsset =>
          a && typeof a.assetId === 'string' && isSafeHtmlAssetId(a.assetId),
      )
    }
  } catch {
    // fallback
  }
  return null
}

function writeHtmlRegistrySync(userDataPath: string, list: StoredHtmlAsset[]): void {
  try {
    const regPath = getHtmlRegistryPath(userDataPath)
    writeFileSync(regPath, JSON.stringify(list, null, 2), 'utf8')
  } catch {
    // best-effort
  }
}

/**
 * Validates, saves, and registers an HTML card asset into isolated storage.
 */
export async function storeHtmlCardAsset(
  userDataPath: string,
  rawHtml: string,
  rawCss: string,
): Promise<StoredHtmlAsset> {
  const htmlResult = sanitizeOpeningHtml(rawHtml)
  if (!htmlResult.ok || !htmlResult.sanitizedHtml) {
    throw new Error(htmlResult.error || 'HTML validation failed')
  }

  const cssResult = sanitizeOpeningCss(rawCss)
  if (!cssResult.ok || typeof cssResult.sanitizedCss !== 'string') {
    throw new Error(cssResult.error || 'CSS validation failed')
  }

  const nonce = randomBytes(8).toString('hex')
  const assetId = `html_${Date.now()}_${nonce}.json`
  const targetPath = resolveSafeHtmlAssetPath(userDataPath, assetId)

  const record: StoredHtmlAsset = {
    assetId,
    html: htmlResult.sanitizedHtml,
    css: cssResult.sanitizedCss,
    createdAt: Date.now(),
    sizeBytes:
      Buffer.byteLength(htmlResult.sanitizedHtml, 'utf8') +
      Buffer.byteLength(cssResult.sanitizedCss, 'utf8'),
  }

  await atomicWriteFile(targetPath, Buffer.from(JSON.stringify(record, null, 2), 'utf8'))

  const current = readHtmlRegistry(userDataPath) || []
  const updated = [...current.filter((a) => a.assetId !== assetId), record]
  writeHtmlRegistrySync(userDataPath, updated)

  return record
}

/**
 * Reads an HTML asset by ID and returns its validated HTML and CSS content.
 */
export function readHtmlCardAsset(userDataPath: string, assetId: string): StoredHtmlAsset | null {
  try {
    const filePath = resolveSafeHtmlAssetPath(userDataPath, assetId)
    if (!existsSync(filePath)) return null
    const content = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(content)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.html === 'string' &&
      typeof parsed.css === 'string'
    ) {
      return {
        assetId,
        html: parsed.html,
        css: parsed.css,
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
        sizeBytes: typeof parsed.sizeBytes === 'number' ? parsed.sizeBytes : content.length,
      }
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * Safely deletes an HTML card asset.
 */
export function deleteHtmlCardAsset(userDataPath: string, assetId: string): boolean {
  try {
    const filePath = resolveSafeHtmlAssetPath(userDataPath, assetId)
    if (existsSync(filePath)) {
      unlinkSync(filePath)
      const current = readHtmlRegistry(userDataPath)
      if (current) {
        writeHtmlRegistrySync(
          userDataPath,
          current.filter((a) => a.assetId !== assetId),
        )
      }
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Lists all existing valid HTML card assets in storage.
 */
export function listHtmlCardAssets(userDataPath: string): StoredHtmlAsset[] {
  const dir = getOpeningHtmlDir(userDataPath)
  const cached = readHtmlRegistry(userDataPath)
  if (cached) {
    const valid = cached.filter((a) => existsSync(join(dir, a.assetId)))
    if (valid.length === cached.length) {
      return valid
    }
  }

  try {
    const files = readdirSync(dir)
    const result: StoredHtmlAsset[] = []
    for (const f of files) {
      if (isSafeHtmlAssetId(f)) {
        const item = readHtmlCardAsset(userDataPath, f)
        if (item) {
          result.push(item)
        }
      }
    }
    writeHtmlRegistrySync(userDataPath, result)
    return result
  } catch {
    return []
  }
}
