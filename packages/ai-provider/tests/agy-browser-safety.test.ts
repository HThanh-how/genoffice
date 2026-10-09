import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = (file: string) => readFileSync(join(__dirname, '..', 'src', file), 'utf8')

// Renderer bundles import the provider list (registry.ts, providers.ts) and the media settings
// (media.ts, types.ts, browser.ts). agy-cli.ts pulls in Node built-ins (child_process, fs), which
// Vite cannot bundle for the browser, so those files must only use the browser-safe agy-meta.ts.
const RENDERER_REACHABLE = [
  'registry.ts',
  'providers.ts',
  'agy-meta.ts',
  'agy-default.ts',
  'media.ts',
  'types.ts',
  'browser.ts',
]
const NODE_ONLY = ['agy-cli', 'agy-image', 'agy-media', 'media-protocols']

describe('Antigravity provider browser safety', () => {
  for (const file of RENDERER_REACHABLE) {
    for (const mod of NODE_ONLY) {
      it(`${file} does not import the Node-only ${mod} module`, () => {
        expect(src(file)).not.toMatch(new RegExp(`from\\s+['"]\\./${mod}['"]`))
      })
    }
  }

  it('agy-meta.ts, media.ts, types.ts and browser.ts have no Node built-in imports', () => {
    for (const file of ['agy-meta.ts', 'agy-default.ts', 'media.ts', 'types.ts', 'browser.ts']) {
      expect(src(file)).not.toMatch(/from\s+['"]node:/)
    }
  })

  it('only media-protocols.ts (main process) imports the media-side agy modules', () => {
    expect(src('media-protocols.ts')).toMatch(/from\s+['"]\.\/agy-image['"]/)
    for (const file of ['registry.ts', 'providers.ts', 'media.ts', 'browser.ts', 'chat.ts']) {
      expect(src(file)).not.toMatch(/from\s+['"]\.\/agy-(image|media)['"]/)
    }
  })
})
