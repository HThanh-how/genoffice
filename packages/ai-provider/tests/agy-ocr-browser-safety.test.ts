import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = (file: string) => readFileSync(join(__dirname, '..', 'src', file), 'utf8')
const shellSrc = join(__dirname, '..', '..', '..', 'apps', 'shell', 'src')

// agy-ocr.ts is shared with the Settings UI (model ranking, floor validation), so it must stay
// free of Node built-ins. agy-usage.ts and agy-cli.ts spawn the CLI and are main-process only.
describe('scanned-PDF reader browser safety', () => {
  it('agy-ocr.ts has no Node built-in imports and does not reach the Node-only modules', () => {
    const source = src('agy-ocr.ts')
    expect(source).not.toMatch(/from\s+['"]node:/)
    expect(source).not.toMatch(/from\s+['"]\.\/agy-(cli|usage|image|media)['"]/)
    expect(source).not.toMatch(/\brequire\(/)
  })

  it('no renderer-reachable provider file imports agy-usage', () => {
    for (const file of [
      'registry.ts',
      'providers.ts',
      'agy-meta.ts',
      'media.ts',
      'types.ts',
      'browser.ts',
    ])
      expect(src(file)).not.toMatch(/from\s+['"]\.\/agy-usage['"]/)
  })

  it('renderer and shared fork files only use the browser-safe agy-ocr entry', () => {
    const dirs = [
      join(shellSrc, 'renderer', 'src', 'fork'),
      join(shellSrc, 'shared', 'fork'),
      join(shellSrc, 'renderer', 'src', 'indexing-activity'),
    ]
    for (const dir of dirs)
      for (const name of readdirSync(dir).filter((n) => /\.(ts|tsx)$/.test(n))) {
        const text = readFileSync(join(dir, name), 'utf8')
        expect(text, `${name} must not import agy-cli`).not.toMatch(/ai-provider\/agy-cli/)
        expect(text, `${name} must not import agy-usage`).not.toMatch(/ai-provider\/agy-usage/)
      }
  })
})
