import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { whenReady: () => Promise.resolve() },
  shell: { openExternal: vi.fn() },
}))
vi.mock('@genoffice/ai-provider/agy-usage', () => ({
  readAgyUsage: vi.fn(async () => null),
  agyUsageNeedsLogin: () => false,
  agyUsageCliMissing: () => false,
}))
vi.mock('@genoffice/ai-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-provider')>()),
  // never start the real `agy models` probe from a test
  probeAgyUsable: vi.fn(async () => false),
}))

import { probeAgyUsable, setAgyUsable } from '@genoffice/ai-provider'
import { readAgyUsage } from '@genoffice/ai-provider/agy-usage'
import { registerAgyChat, shouldReadAgyUsageAtLaunch } from '../src/main/fork/agy-chat-ipc'

const dirs: string[] = []
let workDir = ''
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'agy-launch-'))
  dirs.push(workDir)
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  setAgyUsable(null)
  vi.clearAllMocks()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

async function launch(aiSettings: unknown): Promise<void> {
  const aiSettingsPath = join(workDir, 'ai-settings.json')
  if (aiSettings !== undefined) writeFileSync(aiSettingsPath, JSON.stringify(aiSettings))
  registerAgyChat({
    ipcMain: { handle: vi.fn() },
    settingsPath: () => join(workDir, 'app-settings.json'),
    aiSettingsPath: () => aiSettingsPath,
    cachePath: () => join(workDir, 'usage-cache.json'),
  })
  // past the 4 s startup delay and the probe's promise hops
  await vi.advanceTimersByTimeAsync(10_000)
}

const decidedWithoutAgy = {
  provider: 'gemini',
  providers: {},
  media: { imageProvider: 'gemini', analysisProvider: 'gemini', videoAnalysisProvider: 'gemini' },
  search: { provider: 'parallel' },
}

describe('launch-time `agy -p /usage` poll', () => {
  it('does not start agy for someone who chose other providers', async () => {
    await launch(decidedWithoutAgy)
    expect(readAgyUsage).not.toHaveBeenCalled()
    expect(probeAgyUsable).not.toHaveBeenCalled()
  })

  it('reads the quota once at launch when chat uses Antigravity', async () => {
    await launch({ ...decidedWithoutAgy, provider: 'agy' })
    expect(readAgyUsage).toHaveBeenCalledTimes(1)
    expect(probeAgyUsable).not.toHaveBeenCalled()
  })

  it('also reads it when only web search or media is on Antigravity', async () => {
    await launch({ ...decidedWithoutAgy, search: { provider: 'agy' } })
    expect(readAgyUsage).toHaveBeenCalledTimes(1)
  })

  it('a fresh install checks `agy models` once and polls only if Antigravity is usable', async () => {
    vi.mocked(probeAgyUsable).mockResolvedValueOnce(false)
    await launch(undefined)
    expect(probeAgyUsable).toHaveBeenCalledTimes(1)
    expect(readAgyUsage).not.toHaveBeenCalled()
  })

  it('a fresh install with a usable Antigravity (the agy-first default) does poll', async () => {
    vi.mocked(probeAgyUsable).mockResolvedValueOnce(true)
    await launch({})
    expect(readAgyUsage).toHaveBeenCalledTimes(1)
  })

  it('does not run the probe again when the startup probe already answered', async () => {
    setAgyUsable(true)
    await launch({})
    expect(probeAgyUsable).not.toHaveBeenCalled()
    expect(readAgyUsage).toHaveBeenCalledTimes(1)
  })
})

describe('shouldReadAgyUsageAtLaunch', () => {
  it('skips the probe when the file already decides', async () => {
    const probe = vi.fn(async () => true)
    expect(await shouldReadAgyUsageAtLaunch({ provider: 'agy' }, probe)).toBe(true)
    expect(await shouldReadAgyUsageAtLaunch(decidedWithoutAgy, probe)).toBe(false)
    expect(probe).not.toHaveBeenCalled()
  })

  it('hands the stored CLI path to the probe and follows its answer', async () => {
    const probe = vi.fn(async () => true)
    expect(
      await shouldReadAgyUsageAtLaunch({ providers: { agy: { cliPath: ' /opt/agy ' } } }, probe),
    ).toBe(true)
    expect(probe).toHaveBeenCalledWith(' /opt/agy ')
    expect(await shouldReadAgyUsageAtLaunch({}, async () => false)).toBe(false)
  })

  it('treats a failing probe as "not chosen"', async () => {
    expect(
      await shouldReadAgyUsageAtLaunch({}, async () => {
        throw new Error('boom')
      }),
    ).toBe(false)
  })
})
