import { describe, expect, it, vi } from 'vitest'
import { registerIndexBrowserHandlers } from '../src/main/fork/document-index-browser-handlers'
import { DOCUMENT_INDEX_CHANNELS } from '../src/shared/fork/document-index-api'
import type { DocumentIndexIpcDeps } from '../src/main/fork/document-index-ipc'
import type { IndexIssueReader } from '../src/main/document-memory/issue-reader'
import type { IndexFileDetail } from '../src/shared/fork/document-index-api'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { rootAvailability } from '../src/main/document-memory/root-availability'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  stat: vi.fn(async () => ({ isFile: () => true })),
}))

describe('Index browser IPC boundary', () => {
  function setup() {
    const handlers = new Map<string, (event: unknown, value: unknown) => Promise<unknown>>()
    const browse = vi.fn(async () => ({ items: [], total: 0, sizeBytes: 0, maxId: 0 }))
    const detail = vi.fn(async (): Promise<Omit<IndexFileDetail, 'exists'> | null> => null)
    const deps = {
      ipcMain: {
        handle: (channel: string, handler: (event: unknown, value: unknown) => Promise<unknown>) =>
          handlers.set(channel, handler),
      },
      getDocumentMemory: () => ({ aggregates: { browse, detail } }),
    } as unknown as DocumentIndexIpcDeps
    const reader = vi.fn(() => {
      throw new Error('Main-thread reader must not run')
    }) as () => IndexIssueReader
    registerIndexBrowserHandlers(deps, reader)
    return { handlers, browse, detail, reader }
  }
  it('validates query controls before dispatching one bounded request to the reader worker', async () => {
    const { handlers, browse, reader } = setup()
    const read = handlers.get(DOCUMENT_INDEX_CHANNELS.getIndexBrowserPage)!
    await expect(read({}, { offset: -1 })).rejects.toThrow()
    expect(browse).not.toHaveBeenCalled()
    await read({}, { root: '*', reasons: ['permission'], offset: 100 })
    expect(browse).toHaveBeenCalledWith({ root: '*', reasons: ['permission'], offset: 100 })
    expect(reader).not.toHaveBeenCalled()
  })
  it('validates detail ids and keeps database detail work in the worker', async () => {
    const { handlers, detail, reader } = setup()
    const read = handlers.get(DOCUMENT_INDEX_CHANNELS.getIndexFileDetail)!
    await expect(read({}, 0)).rejects.toThrow()
    await expect(read({}, 1.5)).rejects.toThrow()
    expect(await read({}, 12)).toBeNull()
    expect(detail).toHaveBeenCalledExactlyOnceWith(12)
    expect(reader).not.toHaveBeenCalled()
  })
  it('returns cached metadata without repeating filesystem calls for a known offline root', async () => {
    const { handlers, detail } = setup()
    const root = resolve('seed/offline')
    rootAvailability.register(root)
    rootAvailability.observe(root, false)
    try {
      detail.mockResolvedValue({
        id: 7,
        path: resolve(root, 'seed.md'),
        name: 'seed.md',
        status: 'error',
        error: 'File missing',
        updatedAt: 1,
        truncated: false,
        chunkTotal: 0,
        chunkDone: 0,
      })
      expect(await handlers.get(DOCUMENT_INDEX_CHANNELS.getIndexFileDetail)!({}, 7)).toMatchObject({
        sourceOffline: true,
        exists: false,
      })
      expect(stat).not.toHaveBeenCalled()
    } finally {
      rootAvailability.unregister(root)
    }
  })
})
