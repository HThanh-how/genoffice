import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { loadShellPreload } from './helpers/preload-harness'

/**
 * The shell renderer reaches the main process only through `window.aiOffice` (and `aiOfficeTabs`, ...), which the
 * preload builds from several hand-merged pieces. A method the renderer calls but the preload no longer exposes
 * (a conflict resolved the wrong way in a merge, a rename on one side) is a TypeError at the first call — and when
 * that call is on the start-up path, a window that never paints. This pins the two sides together.
 */

const RENDERER_SRC = resolve(__dirname, '../src/renderer/src')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full)
  }
  return out
}

/** every `window.<api>.<method>` the renderer source names, with the files that name it */
function rendererCalls(api: string): Map<string, string[]> {
  const found = new Map<string, string[]>()
  const pattern = new RegExp(`window\\.${api}\\??\\.([A-Za-z_$][\\w$]*)`, 'g')
  for (const file of sourceFiles(RENDERER_SRC)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(pattern)) {
      const name = match[1]!
      found.set(name, [...(found.get(name) ?? []), file.slice(RENDERER_SRC.length + 1)])
    }
  }
  return found
}

afterAll(() => {
  vi.doUnmock('electron')
})

describe('shell preload contract', () => {
  it('exposes every window.aiOffice method the renderer calls', async () => {
    const { exposed } = await loadShellPreload({})
    const api = exposed.aiOffice
    expect(api).toBeTruthy()
    // the scan itself must see the renderer's calls, or an empty result proves nothing
    expect(rendererCalls('aiOffice').size).toBeGreaterThan(40)
    const missing = [...rendererCalls('aiOffice')]
      .filter(([name]) => typeof api![name] !== 'function')
      .map(([name, files]) => `${name} (used in ${[...new Set(files)].join(', ')})`)
    expect(missing).toEqual([])
  })

  it('exposes every window.aiOfficeTabs method the renderer calls', async () => {
    const { exposed } = await loadShellPreload({})
    const api = exposed.aiOfficeTabs
    expect(api).toBeTruthy()
    expect(rendererCalls('aiOfficeTabs').size).toBeGreaterThan(3)
    const missing = [...rendererCalls('aiOfficeTabs')]
      .filter(([name]) => typeof api![name] !== 'function')
      .map(([name, files]) => `${name} (used in ${[...new Set(files)].join(', ')})`)
    expect(missing).toEqual([])
  })

  it('exposes the start-up calls main.tsx makes before the first paint', async () => {
    const { exposed } = await loadShellPreload({})
    for (const name of ['getLanguage', 'onboardingSeen', 'getTheme', 'onThemeChanged']) {
      expect(typeof exposed.aiOffice![name], name).toBe('function')
    }
    for (const name of ['list', 'onChanged']) {
      expect(typeof exposed.aiOfficeTabs![name], name).toBe('function')
    }
  })

  it('exposes the storage start-up progress the banner follows', async () => {
    const { exposed } = await loadShellPreload({})
    expect(typeof exposed.aiOffice!.getStorageStartupState).toBe('function')
    expect(typeof exposed.aiOffice!.onStorageStartupChanged).toBe('function')
    await expect(
      (exposed.aiOffice!.getStorageStartupState as () => Promise<unknown>)(),
    ).resolves.toEqual({
      phase: 'ready',
      percent: null,
    })
  })
})
