import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = (file: string) => readFileSync(join(__dirname, '..', 'src', file), 'utf8')

// The renderer bundles reach agy-errors / agy-effort / agy-choice / agy-error-text (the editors'
// transports call agyErrorText); none of them may pull in Node built-ins or the process-spawning
// modules.
const PURE = ['agy-errors.ts', 'agy-effort.ts', 'agy-choice.ts', 'agy-error-text.ts']
const NODE_ONLY = ['agy-cli', 'agy-lock', 'agy-capabilities', 'agy-usage', 'agy-image', 'agy-media']

describe('agy runtime layer browser safety', () => {
  for (const file of PURE) {
    it(`${file} has no Node imports and no Node-only agy module`, () => {
      const text = src(file)
      expect(text).not.toMatch(/from\s+['"]node:/)
      for (const mod of NODE_ONLY) {
        expect(text).not.toMatch(new RegExp(`from\\s+['"]\\./${mod}['"]`))
      }
    })
  }

  it('the browser entry exposes the message helper but none of the Node-side modules', () => {
    const browser = src('browser.ts')
    expect(browser).toMatch(/agy-error-text/)
    for (const mod of ['agy-lock', 'agy-capabilities', 'agy-cli']) {
      expect(browser).not.toMatch(new RegExp(`['"]\\./${mod}['"]`))
    }
  })

  it('the lock and capability modules are Node-side only (not reachable from the settings/registry files)', () => {
    for (const file of ['registry.ts', 'providers.ts', 'media.ts', 'types.ts', 'browser.ts']) {
      const text = src(file)
      expect(text).not.toMatch(/from\s+['"]\.\/agy-(lock|capabilities)['"]/)
    }
  })
})
