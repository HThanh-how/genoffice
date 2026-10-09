import { vi } from 'vitest'

/**
 * Loads the real shell preload (src/preload/index.ts) against a stub `electron` module and returns what it exposes
 * to the page. `invoke` answers every channel with `undefined`, which is what an idle main process looks like to
 * the preload's own normalisers (pass `answers` for the few channels whose reply the renderer indexes into) — so a renderer mounted on this surface exercises the real contract, not a mock
 * written to match the renderer.
 */
export interface PreloadHarness {
  exposed: Record<string, Record<string, unknown>>
  invoked: string[]
}

export async function loadShellPreload(
  target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
  answers: Record<string, unknown> = {},
): Promise<PreloadHarness> {
  const exposed: Record<string, Record<string, unknown>> = {}
  const invoked: string[] = []
  vi.resetModules()
  vi.doMock('electron', () => ({
    contextBridge: {
      exposeInMainWorld: (name: string, api: Record<string, unknown>) => {
        exposed[name] = api
        target[name] = api
      },
    },
    ipcRenderer: {
      invoke: async (channel: string) => {
        invoked.push(channel)
        return answers[channel]
      },
      send: () => undefined,
      sendSync: () => undefined,
      on: () => undefined,
      once: () => undefined,
      off: () => undefined,
      removeListener: () => undefined,
      removeAllListeners: () => undefined,
    },
    webUtils: { getPathForFile: () => '' },
  }))
  await import('../../src/preload/index')
  return { exposed, invoked }
}
