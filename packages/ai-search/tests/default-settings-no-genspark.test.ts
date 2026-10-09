import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFile = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile,
}))

import { setAgyUsable } from '@genoffice/ai-provider'
import { gskApiKey, hasGskAuth } from '../src/gsk'
import { analyzeMediaTool, generateImageTool } from '../src/media-tools'

const saved: Record<string, string | undefined> = {}
const fetchSpy = vi.fn()

beforeEach(() => {
  for (const key of ['HOME', 'USERPROFILE', 'GSK_API_KEY', 'GENOFFICE_AUTH_DIR'])
    saved[key] = process.env[key]
  const home = mkdtempSync(join(tmpdir(), 'no-genspark-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.GENOFFICE_AUTH_DIR = join(home, 'auth')
  delete process.env.GSK_API_KEY
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.unstubAllGlobals()
  fetchSpy.mockClear()
  execFile.mockClear()
  setAgyUsable(null)
})

// A user with default settings and no Genspark sign-in must never reach genspark.ai or the gsk CLI.
describe('default settings without a Genspark sign-in', () => {
  it('reports no Genspark login', () => {
    expect(gskApiKey()).toBe('')
    expect(hasGskAuth()).toBe(false)
  })

  it('image generation and media analysis never touch Genspark when agy is not usable', async () => {
    setAgyUsable(false)
    const missing = join(process.env.HOME!, 'ai-settings.json')
    const image = await generateImageTool(missing, { prompt: 'a red circle' })
    const analysis = await analyzeMediaTool(missing, {
      mediaUrls: ['/nonexistent/a.png'],
      requirements: 'describe',
    })
    expect(image.error).toBeTruthy()
    expect(analysis.error).toBeTruthy()
    expect(execFile).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('media analysis with agy as the default stops at the missing local file, off Genspark', async () => {
    setAgyUsable(true)
    // a nonexistent file fails while loading, before any provider (agy or otherwise) is run
    const analysis = await analyzeMediaTool(join(process.env.HOME!, 'ai-settings.json'), {
      mediaUrls: ['/nonexistent/a.png'],
      requirements: 'describe',
    })
    expect(analysis.error).toBeTruthy()
    expect(execFile).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
