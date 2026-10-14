import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteHtmlCardAsset,
  isSafeHtmlAssetId,
  listHtmlCardAssets,
  readHtmlCardAsset,
  resolveSafeHtmlAssetPath,
  storeHtmlCardAsset,
} from '../src/main/fork/opening-html-storage'

describe('opening-html-storage', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opening-html-storage-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('validates safe HTML asset IDs and rejects path traversal', () => {
    expect(isSafeHtmlAssetId('html_1728888888_0123456789abcdef.json')).toBe(true)
    expect(isSafeHtmlAssetId('../evil.json')).toBe(false)
    expect(isSafeHtmlAssetId('html_123.txt')).toBe(false)

    expect(() => resolveSafeHtmlAssetPath(tempDir, '../evil.json')).toThrow(/Invalid HTML asset ID/)
  })

  it('stores and reads an HTML card asset atomically', async () => {
    const html = '<div class="banner"><h1>{{title}}</h1><p>{{fileName}}</p></div>'
    const css = '.banner { background: #111; color: #fff; }'

    const stored = await storeHtmlCardAsset(tempDir, html, css)
    expect(stored.assetId).toMatch(/^html_[0-9]+_[0-9a-f]{16}\.json$/)
    expect(stored.html).toContain('{{title}}')
    expect(stored.css).toBe(css)

    const read = readHtmlCardAsset(tempDir, stored.assetId)
    expect(read).not.toBeNull()
    expect(read?.html).toBe(stored.html)
    expect(read?.css).toBe(stored.css)
  })

  it('lists stored HTML assets and deletes cleanly', async () => {
    const stored1 = await storeHtmlCardAsset(tempDir, '<div>1</div>', '.c1{}')
    const stored2 = await storeHtmlCardAsset(tempDir, '<div>2</div>', '.c2{}')

    const list = listHtmlCardAssets(tempDir)
    expect(list.length).toBe(2)
    expect(list.some((a) => a.assetId === stored1.assetId)).toBe(true)
    expect(list.some((a) => a.assetId === stored2.assetId)).toBe(true)

    const deleted = deleteHtmlCardAsset(tempDir, stored1.assetId)
    expect(deleted).toBe(true)
    expect(readHtmlCardAsset(tempDir, stored1.assetId)).toBeNull()

    const listAfter = listHtmlCardAssets(tempDir)
    expect(listAfter.length).toBe(1)
    expect(listAfter[0].assetId).toBe(stored2.assetId)
  })

  it('rejects malicious HTML or CSS during storage', async () => {
    await expect(storeHtmlCardAsset(tempDir, '<script>alert(1)</script>', '.a{}')).rejects.toThrow()

    await expect(
      storeHtmlCardAsset(tempDir, '<div>ok</div>', '@import "evil.css";'),
    ).rejects.toThrow()
  })
})
