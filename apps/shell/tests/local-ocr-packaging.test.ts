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
    expect(builder.extraResources).toContainEqual({
      from: 'resources/ocr/tessdata',
      to: 'ocr/tessdata',
    })
    expect(builder.extraResources).toContainEqual({
      from: '../../packages/pdf2docx/ocr-helper/vision-ocr',
      to: 'ocr/vision-ocr',
    })
    expect(existsSync(join(root, 'resources/ocr/tessdata/vie.traineddata'))).toBe(true)
    expect(existsSync(join(root, 'resources/ocr/tessdata/LICENSE'))).toBe(true)
  })

  it('unpacks tesseract.js, its core and everything the worker-thread script requires', () => {
    for (const pkg of [
      'tesseract.js',
      'tesseract.js-core',
      'regenerator-runtime',
      'is-url',
      'bmp-js',
      'wasm-feature-detect',
    ])
      expect(builder.asarUnpack).toContain(`node_modules/${pkg}/**`)
    expect(builder.asarUnpack).toContain('node_modules/onnxruntime-node/**')
  })

  it('keeps every tesseract.js-core build that the installed tesseract.js can require', () => {
    // tesseract.js 7.0.0's Node getCore receives a boolean where it expects an OEM number, so it
    // asks for the non-LSTM build even when LSTM only is requested: a trimmed package crashes at runtime.
    const getCore = readFileSync(
      join(root, '../../node_modules/tesseract.js/src/worker-script/node/getCore.js'),
      'utf8',
    )
    const required = [...getCore.matchAll(/require\('tesseract\.js-core\/([^']+)'\)/g)].map(
      (m) => m[1]!,
    )
    expect(required.length).toBeGreaterThanOrEqual(6)
    const exclusions = builder.files.filter((pattern) =>
      pattern.startsWith('!node_modules/tesseract.js-core/'),
    )
    // the only trimming left is the browser-only base64 twin (*.wasm.js), which no `require` above names
    expect(exclusions).toEqual(['!node_modules/tesseract.js-core/*.wasm.js'])
    for (const name of required) {
      expect(name.endsWith('.wasm')).toBe(false)
      expect(existsSync(join(root, '../../node_modules/tesseract.js-core', `${name}.js`))).toBe(
        true,
      )
      expect(existsSync(join(root, '../../node_modules/tesseract.js-core', `${name}.wasm`))).toBe(
        true,
      )
    }
    expect(builder.files).toContain('out/**')
  })

  it('keeps tesseract.js external to the main bundle and declares it as a dependency', () => {
    const config = readFileSync(join(root, 'electron.vite.config.ts'), 'utf8')
    expect(config).toMatch(/external:\s*\[[^\]]*'tesseract\.js'/)
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(pkg.dependencies['tesseract.js']).toBeTruthy()
  })
})
