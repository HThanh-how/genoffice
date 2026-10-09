/**
 * Where the bundled OCR resources live.
 *   packaged: <Resources>/ocr/vision-ocr (macOS helper, already shipped for the PDF app) and
 *             <Resources>/ocr/tessdata/vie.traineddata (electron-builder extraResources)
 *   dev/test: packages/pdf2docx/ocr-helper/vision-ocr and apps/shell/resources/ocr/tessdata,
 *             found by walking up from this file / the working directory.
 * Nothing is ever downloaded: a missing resource simply makes the engine unavailable.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function resourceRoots(): string[] {
  const roots: string[] = []
  const env = process.env.GENOFFICE_RESOURCES_PATH
  if (env) roots.push(join(env, 'ocr'))
  const packaged = (process as { resourcesPath?: string }).resourcesPath
  if (packaged) roots.push(join(packaged, 'ocr'))
  return roots
}

function walkUp(relative: string): string | null {
  const starts: string[] = [process.cwd()]
  try {
    starts.push(dirname(fileURLToPath(import.meta.url)))
  } catch {
    // bundled without import.meta.url: cwd and Resources are enough
  }
  for (const start of starts) {
    let dir = start
    for (let depth = 0; depth < 10; depth++) {
      const candidate = join(dir, relative)
      if (existsSync(candidate)) return candidate
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

/** Path of the compiled macOS Vision helper, or null. */
export function findVisionHelper(): string | null {
  for (const root of resourceRoots()) {
    const candidate = join(root, 'vision-ocr')
    if (existsSync(candidate)) return candidate
  }
  return walkUp(join('packages', 'pdf2docx', 'ocr-helper', 'vision-ocr'))
}

/** Directory holding vie.traineddata (tessdata_fast), or null. */
export function findTessdataDir(): string | null {
  for (const root of resourceRoots()) {
    const candidate = join(root, 'tessdata')
    if (existsSync(join(candidate, 'vie.traineddata'))) return candidate
  }
  const dev = walkUp(join('apps', 'shell', 'resources', 'ocr', 'tessdata'))
  return dev && existsSync(join(dev, 'vie.traineddata')) ? dev : null
}

/**
 * The Tesseract.js worker script as a real file. Packaged builds unpack it (electron-builder asarUnpack)
 * so a worker thread can be started from it; undefined = let tesseract.js use its own default (dev, tests).
 */
export function findTesseractWorkerScript(): string | null {
  const resources = (process as { resourcesPath?: string }).resourcesPath
  if (!resources) return null
  const candidate = join(
    resources,
    'app.asar.unpacked',
    'node_modules',
    'tesseract.js',
    'src',
    'worker-script',
    'node',
    'index.js',
  )
  return existsSync(candidate) ? candidate : null
}

/** The `.js` + `.wasm` pairs tesseract.js may load, whichever CPU features and OEM it picks. */
const TESSERACT_CORE_BUILDS = [
  'tesseract-core',
  'tesseract-core-simd',
  'tesseract-core-relaxedsimd',
  'tesseract-core-lstm',
  'tesseract-core-simd-lstm',
  'tesseract-core-relaxedsimd-lstm',
]

/**
 * True when every tesseract.js-core build sits next to the unpacked worker script. A missing core
 * is a `require` failure inside the worker thread, which the main process reports as an uncaught
 * exception, so an incomplete package must make the engine unavailable instead.
 * `workerPath` is .../node_modules/tesseract.js/src/worker-script/node/index.js.
 */
export function tesseractCoresPresent(workerPath: string): boolean {
  const coreDir = join(dirname(workerPath), '..', '..', '..', '..', 'tesseract.js-core')
  return TESSERACT_CORE_BUILDS.every(
    (name) => existsSync(join(coreDir, `${name}.js`)) && existsSync(join(coreDir, `${name}.wasm`)),
  )
}
