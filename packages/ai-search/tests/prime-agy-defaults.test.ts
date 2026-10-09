import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => vi.fn(async (_cliPath?: string) => true))
vi.mock('@genoffice/ai-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-provider')>()),
  agyUsableForDefaults: probe,
}))

import { primeAgyDefaults } from '../src/media-tools'

const dir = mkdtempSync(join(tmpdir(), 'prime-agy-'))
let counter = 0
function file(content: unknown): string {
  const path = join(dir, `ai-settings-${counter++}.json`)
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
  return path
}

beforeEach(() => probe.mockClear())

describe('primeAgyDefaults', () => {
  it('checks Antigravity when there is no settings file, or it is unreadable', async () => {
    await primeAgyDefaults(join(dir, 'missing.json'))
    await primeAgyDefaults(file('{ not json'))
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('checks it when the file leaves a choice open, passing the stored CLI path', async () => {
    await primeAgyDefaults(
      file({ provider: 'openai', providers: { agy: { cliPath: '/opt/agy' } } }),
    )
    expect(probe).toHaveBeenCalledWith('/opt/agy')
  })

  it('skips the check when the file already makes every choice', async () => {
    await primeAgyDefaults(
      file({
        provider: 'anthropic',
        providers: {},
        media: { imageProvider: 'openai', analysisProvider: 'gemini' },
        search: { provider: 'serper' },
      }),
    )
    expect(probe).not.toHaveBeenCalled()
  })
})
