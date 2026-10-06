import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { ALL_FOLDERS } from '../src/main/document-memory/issue-reader'
import { registerDocumentIndexIpc } from '../src/main/fork/document-index-ipc'
import { DOCUMENT_INDEX_CHANNELS } from '../src/shared/fork/document-index-api'
import { HOME_CHANNELS } from '../src/shared/home-api'

type Handler = (event: unknown, ...args: unknown[]) => unknown

describe('Document index IPC result contracts', () => {
  let testDir: string
  let dbPath: string
  let handlers: Map<string, Handler>
  let closeIpc: (() => void) | null
  let store: DocumentMemoryStore | null

  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    },
  }

  const call = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) {
      throw new Error(`IPC handler not registered for channel: ${channel}`)
    }
    return await handler({}, ...args)
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'doc-index-ipc-'))
    dbPath = join(testDir, 'memory.db')
    handlers = new Map()
    closeIpc = null
    store = null
  })

  afterEach(() => {
    closeIpc?.()
    closeIpc = null
    store?.close()
    store = null
    rmSync(testDir, { recursive: true, force: true })
  })

  it('IPC-01: {ok:false} không làm tăng retry count (chống truthy bug)', async () => {
    const retryMock = vi.fn().mockReturnValue({ ok: false, error: 'File locked' })
    const memory = {
      retryDocument: retryMock,
    }

    closeIpc = registerDocumentIndexIpc({
      ipcMain,
      getDocumentMemory: () => memory as never,
      getFolderScan: () => null,
      dbPath: () => dbPath,
    })

    const res = await call(DOCUMENT_INDEX_CHANNELS.enqueueDocumentIndex, [10, 20])
    expect(res).toEqual({ queued: 0, skipped: 2, error: 'File locked' })
    expect(retryMock).toHaveBeenCalledTimes(2)
  })

  it('IPC-02: {ok:true} làm tăng retry count', async () => {
    const retryMock = vi.fn().mockReturnValue({ ok: true })
    const memory = {
      retryDocument: retryMock,
    }

    closeIpc = registerDocumentIndexIpc({
      ipcMain,
      getDocumentMemory: () => memory as never,
      getFolderScan: () => null,
      dbPath: () => dbPath,
    })

    const res = await call(DOCUMENT_INDEX_CHANNELS.enqueueDocumentIndex, [10, 20])
    expect(res).toEqual({ queued: 2, skipped: 0 })
    expect(retryMock).toHaveBeenCalledTimes(2)
  })

  it('IPC-03: mixed retry batch count (batch có cả ok:true và ok:false)', async () => {
    const retryMock = vi.fn().mockImplementation((id: number) => {
      if (id === 2) return { ok: false, error: 'Disk full' }
      return { ok: true }
    })
    const memory = {
      retryDocument: retryMock,
    }

    closeIpc = registerDocumentIndexIpc({
      ipcMain,
      getDocumentMemory: () => memory as never,
      getFolderScan: () => null,
      dbPath: () => dbPath,
    })

    const res = await call(DOCUMENT_INDEX_CHANNELS.enqueueDocumentIndex, [1, 2, 3])
    expect(res).toEqual({ queued: 2, skipped: 1, error: 'Disk full' })
    expect(retryMock).toHaveBeenCalledTimes(3)
  })

  it('IPC-04: group retry count đếm chuẩn xác các item thành công', async () => {
    store = new DocumentMemoryStore(dbPath)
    store.markError(join(testDir, 'doc1.pdf'), 'Extraction failed', null)
    store.markError(join(testDir, 'doc2.pdf'), 'Corrupted file', null)
    store.markError(join(testDir, 'doc3.pdf'), 'Format error', null)

    const retryMock = vi.fn().mockImplementation((id: number) => {
      // Simulate id 2 failing to retry
      if (id === 2) return { ok: false, error: 'Busy' }
      return { ok: true }
    })

    const memory = {
      retryDocument: retryMock,
      isEnabled: () => true,
    }

    closeIpc = registerDocumentIndexIpc({
      ipcMain,
      getDocumentMemory: () => memory as never,
      getFolderScan: () => null,
      dbPath: () => dbPath,
    })

    const res = await call(DOCUMENT_INDEX_CHANNELS.retryDocumentIndexGroup, ALL_FOLDERS)
    expect(res).toEqual({ ok: true, retried: 2 })
    expect(retryMock).toHaveBeenCalledTimes(3)
  })

  it('IPC-05: defer failure được propagated đúng {ok:false, error:...}', async () => {
    const deferMock = vi.fn().mockImplementation((id: number) => {
      if (id === 42) return { ok: false, error: 'Cannot defer running job' }
      return { ok: true }
    })

    const memory = {
      deferDocument: deferMock,
    }

    closeIpc = registerDocumentIndexIpc({
      ipcMain,
      getDocumentMemory: () => memory as never,
      getFolderScan: () => null,
      dbPath: () => dbPath,
    })

    const failed = await call(DOCUMENT_INDEX_CHANNELS.deferIndexFile, 42)
    expect(failed).toEqual({ ok: false, error: 'Cannot defer running job' })
    expect(deferMock).toHaveBeenCalledWith(42)

    const succeeded = await call(DOCUMENT_INDEX_CHANNELS.deferIndexFile, 7)
    expect(succeeded).toEqual({ ok: true })
    expect(deferMock).toHaveBeenCalledWith(7)
  })

  it('IPC-06: unavailable manager trả về failure có kiểm soát {ok:false, error:\'unavailable\'}', async () => {
    closeIpc = registerDocumentIndexIpc({
      ipcMain,
      getDocumentMemory: () => null,
      getFolderScan: () => null,
      dbPath: () => dbPath,
    })

    // Enqueue document index returns { queued: 0, skipped: N, error: 'unavailable' }
    const enqueueRes = await call(DOCUMENT_INDEX_CHANNELS.enqueueDocumentIndex, [10, 20])
    expect(enqueueRes).toEqual({ queued: 0, skipped: 2, error: 'unavailable' })

    // Group retry returns { ok: false, retried: 0, error: 'unavailable' }
    const groupRes = await call(DOCUMENT_INDEX_CHANNELS.retryDocumentIndexGroup, ALL_FOLDERS)
    expect(groupRes).toEqual({ ok: false, retried: 0, error: 'unavailable' })

    // Defer file returns { ok: false, error: 'unavailable' }
    const deferRes = await call(DOCUMENT_INDEX_CHANNELS.deferIndexFile, 1)
    expect(deferRes).toEqual({ ok: false, error: 'unavailable' })

    // Stop index file returns { ok: false, error: 'unavailable' }
    const stopRes = await call(DOCUMENT_INDEX_CHANNELS.stopIndexFile, 1)
    expect(stopRes).toEqual({ ok: false, error: 'unavailable' })

    // Retry single document index returns { ok: false, error: 'unavailable' }
    const retryDocRes = await call(HOME_CHANNELS.retryDocumentIndex, 1)
    expect(retryDocRes).toEqual({ ok: false, error: 'unavailable' })
  })

  it('IPC-07: PDF page result trả về đúng pages thực tế và requeued độc lập', async () => {
    const setPdfMaxPagesMock = vi.fn().mockReturnValue({ pages: 45, requeued: 3 })
    const memory = {
      setPdfMaxPages: setPdfMaxPagesMock,
      getPdfMaxPages: () => 45,
    }

    closeIpc = registerDocumentIndexIpc({
      ipcMain,
      getDocumentMemory: () => memory as never,
      getFolderScan: () => null,
      dbPath: () => dbPath,
    })

    // Case 1: Memory manager returns object with { pages, requeued }
    const resObject = await call(DOCUMENT_INDEX_CHANNELS.setPdfPages, 50)
    expect(resObject).toEqual({
      pages: 45,
      default: 30,
      max: 400,
      requeued: 3,
    })
    expect(setPdfMaxPagesMock).toHaveBeenCalledWith(50)

    // Case 2: Memory manager returns legacy number (requeued only)
    setPdfMaxPagesMock.mockReturnValue(5)
    const resLegacy = await call(DOCUMENT_INDEX_CHANNELS.setPdfPages, 70)
    expect(resLegacy).toEqual({
      pages: 70,
      default: 30,
      max: 400,
      requeued: 5,
    })
    expect(setPdfMaxPagesMock).toHaveBeenCalledWith(70)
  })
})
