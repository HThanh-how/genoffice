import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const builder = createRequire(__filename)(join(root, 'electron-builder.cjs')) as {
  files: string[]
  asarUnpack: string[]
  extraResources: Array<{ from: string; to: string }>
}

describe('local OCR packaging', () => {
  it('ships the Vietnamese model to Resources/ocr/tessdata and keeps the Vision helper entry', () => {
    expect(builder.extraResources).toContainEqual({ from: 'resources/ocr/tessdata', to: 'ocr/tessdata' })
    expect(builder.extraResources).toContainEqual({ from: '../../packages/pdf2docx/ocr-helper/vision-ocr', to: 'ocr/vision-ocr' })
    expect(existsSync(join(root, 'resources/ocr/tessdata/vie.traineddata'))).toBe(true)
    expect(existsSync(join(root, 'resources/ocr/tessdata/LICENSE'))).toBe(true)
  })

  it('unpacks tesseract.js, its core and everything the worker-thread script requires', () => {
    for (const pkg of ['tesseract.js', 'tesseract.js-core', 'regenerator-runtime', 'is-url', 'bmp-js', 'wasm-feature-detect'])
      expect(builder.asarUnpack).toContain(`node_modules/${pkg}/**`)
    expect(builder.asarUnpack).toContain('node_modules/onnxruntime-node/**')
  })

  it('trims tesseract.js-core to the LSTM .wasm variants the engine loads', () => {
    const exclusions = builder.files.filter((pattern) => pattern.startsWith('!node_modules/tesseract.js-core/'))
    expect(exclusions.length).toBeGreaterThan(0)
    expect(builder.files).toContain('out/**')
    // nothing LSTM-only is excluded
    for (const pattern of exclusions) expect(pattern).not.toMatch(/lstm/)
  })

  it('keeps tesseract.js external to the main bundle and declares it as a dependency', () => {
    const config = readFileSync(join(root, 'electron.vite.config.ts'), 'utf8')
    expect(config).toMatch(/external:\s*\[[^\]]*'tesseract\.js'/)
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies['tesseract.js']).toBeTruthy()
  })
})
