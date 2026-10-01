import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Renderer bundles import the provider list (registry.ts, providers.ts). agy-cli.ts pulls in Node
// built-ins (child_process, fs), which Vite cannot bundle for the browser, so those two files
// must only use the browser-safe agy-meta.ts.
describe('Antigravity provider browser safety', () => {
  for (const file of ['registry.ts', 'providers.ts', 'agy-meta.ts']) {
    it(`${file} does not import the Node-only agy-cli module`, () => {
      const source = readFileSync(join(__dirname, '..', 'src', file), 'utf8')
      expect(source).not.toMatch(/from\s+['"]\.\/agy-cli['"]/)
    })
  }

  it('agy-meta.ts has no Node built-in imports', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'agy-meta.ts'), 'utf8')
    expect(source).not.toMatch(/from\s+['"]node:/)
  })
})
