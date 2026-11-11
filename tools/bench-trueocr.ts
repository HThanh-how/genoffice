/** Read-only benchmark adapter. Run with tsx: <manifest.json> <manifest-root>.
 * Writes raw OCR JSONL to stdout: redirect to a private, ignored directory.
 * A manifest is [{ id, path }]; paths are resolved relative to manifest-root.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { TrueOcrEngine } from '../apps/shell/src/main/document-memory/local-ocr/trueocr-engine'

async function main(): Promise<void> {
  const [manifest, root] = process.argv.slice(2)
  if (!manifest || !root)
    throw new Error('Usage: tsx tools/bench-trueocr.ts manifest.json manifest-root')
  const rows = JSON.parse(await readFile(manifest, 'utf8')) as Array<{ id: string; path: string }>
  const engine = new TrueOcrEngine()
  try {
    // Match the reference harness: model load and warm-up are excluded from page timings.
    await engine.recognizePage({
      imagePath: resolve('apps/shell/tests/fixtures/ocr/trueocr-synth.png'),
      dpi: 150,
      lang: 'vie',
    })
    for (const row of rows) {
      const bytes = await readFile(resolve(root, row.path))
      process.stdout.write(JSON.stringify({ event: 'start', id: row.id }) + '\n')
      const page = await engine.recognizePage({ bytes, dpi: 150, lang: 'vie' })
      process.stdout.write(
        JSON.stringify({
          event: 'end',
          id: row.id,
          ...page,
          rss: process.memoryUsage().rss,
          processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
        }) + '\n',
      )
    }
  } finally {
    await engine.dispose()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
