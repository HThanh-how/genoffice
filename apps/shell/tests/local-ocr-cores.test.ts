import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TesseractEngine } from '../src/main/document-memory/local-ocr/tesseract-engine'
import { tesseractCoresPresent } from '../src/main/document-memory/local-ocr/resources'

const BUILDS = [
  'tesseract-core',
  'tesseract-core-simd',
  'tesseract-core-relaxedsimd',
  'tesseract-core-lstm',
  'tesseract-core-simd-lstm',
  'tesseract-core-relaxedsimd-lstm',
]

describe('packaged tesseract.js cores', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function layout(skip: string[] = []) {
    const root = mkdtempSync(join(tmpdir(), 'genoffice-cores-'))
    dirs.push(root)
    const worker = join(root, 'node_modules', 'tesseract.js', 'src', 'worker-script', 'node')
    const core = join(root, 'node_modules', 'tesseract.js-core')
    mkdirSync(worker, { recursive: true })
    mkdirSync(core, { recursive: true })
    writeFileSync(join(worker, 'index.js'), '')
    for (const name of BUILDS) {
      for (const ext of ['js', 'wasm'])
        if (!skip.includes(`${name}.${ext}`)) writeFileSync(join(core, `${name}.${ext}`), '')
    }
    return join(worker, 'index.js')
  }

  it('is complete only when every build has its .js and .wasm', () => {
    expect(tesseractCoresPresent(layout())).toBe(true)
    expect(tesseractCoresPresent(layout(['tesseract-core-relaxedsimd.js']))).toBe(false)
    expect(tesseractCoresPresent(layout(['tesseract-core-simd.wasm']))).toBe(false)
    expect(tesseractCoresPresent(layout(['tesseract-core-lstm.wasm']))).toBe(false)
  })

  it('makes the engine unavailable (instead of crashing the main process) when a core is missing', () => {
    const tessdata = mkdtempSync(join(tmpdir(), 'genoffice-tessdata-'))
    dirs.push(tessdata)
    const options = (workerPath: string) => ({ langPath: tessdata, workerPath })
    expect(new TesseractEngine(options(layout())).isAvailable('win32', 8000)).toBe(true)
    expect(
      new TesseractEngine(options(layout(['tesseract-core-relaxedsimd.js']))).isAvailable(
        'win32',
        8000,
      ),
    ).toBe(false)
  })
})
