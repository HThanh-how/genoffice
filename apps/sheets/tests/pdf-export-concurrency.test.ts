import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  workbookExportPdfResultSchema,
  type WorkbookExportPdfRequest,
} from '../src/shared/desktop-api'

const {
  mockPrintToPDF,
  mockDestroy,
  mockIsDestroyed,
  mockLoadFile,
  MockBrowserWindow,
  mockIsHeadlessMode,
  mockShowSaveDialogWithMemory,
  mockAtomicWriteFile,
} = vi.hoisted(() => {
  const mockPrintToPDF = vi.fn()
  const mockDestroy = vi.fn()
  const mockIsDestroyed = vi.fn(() => false)
  const mockLoadFile = vi.fn()

  class MockBrowserWindow {
    webContents = {
      printToPDF: mockPrintToPDF,
    }
    destroy = mockDestroy
    isDestroyed = mockIsDestroyed
    loadFile = mockLoadFile
    static fromWebContents = vi.fn(() => ({}))
  }

  const mockIsHeadlessMode = vi.fn(() => false)
  const mockShowSaveDialogWithMemory = vi.fn()
  const mockAtomicWriteFile = vi.fn()

  return {
    mockPrintToPDF,
    mockDestroy,
    mockIsDestroyed,
    mockLoadFile,
    MockBrowserWindow,
    mockIsHeadlessMode,
    mockShowSaveDialogWithMemory,
    mockAtomicWriteFile,
  }
})

vi.mock('electron', () => ({
  BrowserWindow: MockBrowserWindow,
  dialog: {},
}))

vi.mock('@genoffice/electron-utils', () => ({
  isHeadlessMode: () => mockIsHeadlessMode(),
  showSaveDialogWithMemory: (...args: unknown[]) => mockShowSaveDialogWithMemory(...args),
}))

vi.mock('../src/main/atomic-write', () => ({
  atomicWriteFile: (...args: unknown[]) => mockAtomicWriteFile(...args),
}))

// Import exportPdf and tryAcquirePdfDestination after mocks
import { exportPdf } from '../src/main/pdf-export'
import { tryAcquirePdfDestination } from '../src/main/pdf-destination-lock'

describe('pdf-export concurrency and destination locking', () => {
  const dummyEvent = { sender: {} } as any
  const baseRequest: WorkbookExportPdfRequest = {
    fileName: 'sheet.pdf',
    html: '<html><body>Test Content</body></html>',
    landscape: false,
    pageSize: 'A4',
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    scale: 1,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsHeadlessMode.mockReturnValue(false)
    mockPrintToPDF.mockResolvedValue(Buffer.from('%PDF-1.4 test'))
    mockLoadFile.mockResolvedValue(undefined)
    mockAtomicWriteFile.mockResolvedValue(undefined)
    mockIsDestroyed.mockReturnValue(false)
  })

  it('PDFMAIN-01: returns destination-busy when target path is currently locked', async () => {
    const targetPath = 'D:\\exports\\locked-report.pdf'

    // Pre-acquire the lock to simulate an active operation
    const existingLease = tryAcquirePdfDestination(targetPath)
    expect(existingLease).not.toBeNull()

    mockShowSaveDialogWithMemory.mockResolvedValue({
      canceled: false,
      filePath: targetPath,
    })

    const result = await exportPdf(dummyEvent, baseRequest)
    expect(result).toEqual({ canceled: false, error: 'destination-busy' })

    // Release pre-acquired lock
    existingLease?.release()
  })

  it('PDFMAIN-02: lock is released after successful export', async () => {
    const targetPath = 'D:\\exports\\success-report.pdf'
    mockShowSaveDialogWithMemory.mockResolvedValue({
      canceled: false,
      filePath: targetPath,
    })

    const result = await exportPdf(dummyEvent, baseRequest)
    expect(result).toEqual({ canceled: false, path: targetPath })

    // Destination lock must be released now, allowing re-acquire
    const lease = tryAcquirePdfDestination(targetPath)
    expect(lease).not.toBeNull()
    lease?.release()
  })

  it('PDFMAIN-03: lock is released even if atomicWriteFile fails with error', async () => {
    const targetPath = 'D:\\exports\\failed-write.pdf'
    mockShowSaveDialogWithMemory.mockResolvedValue({
      canceled: false,
      filePath: targetPath,
    })
    mockAtomicWriteFile.mockRejectedValue(new Error('EACCES: permission denied'))

    await expect(exportPdf(dummyEvent, baseRequest)).rejects.toThrow('EACCES: permission denied')

    // Verify lock is released despite the uncaught rejection in exportPdf
    const lease = tryAcquirePdfDestination(targetPath)
    expect(lease).not.toBeNull()
    lease?.release()
  })

  it('PDFMAIN-04: lock is released even if renderPdf fails with error', async () => {
    const targetPath = 'D:\\exports\\failed-render.pdf'
    mockShowSaveDialogWithMemory.mockResolvedValue({
      canceled: false,
      filePath: targetPath,
    })
    mockPrintToPDF.mockRejectedValue(new Error('Chromium printToPDF crashed'))

    await expect(exportPdf(dummyEvent, baseRequest)).rejects.toThrow('Chromium printToPDF crashed')

    // Verify lock was released
    const lease = tryAcquirePdfDestination(targetPath)
    expect(lease).not.toBeNull()
    lease?.release()
  })

  it('PDFMAIN-05: collision between GUI export and headless export on same destination', async () => {
    const targetPath = 'D:\\exports\\shared-destination.pdf'

    mockShowSaveDialogWithMemory.mockResolvedValue({
      canceled: false,
      filePath: targetPath,
    })

    let signalWriteStarted: (() => void) | undefined
    let releaseWrite: (() => void) | undefined

    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve
    })
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })

    mockAtomicWriteFile.mockImplementationOnce(async () => {
      signalWriteStarted?.()
      await writeGate
    })

    const guiPromise = exportPdf(dummyEvent, baseRequest)

    // Wait until atomicWriteFile has been reached (lease guaranteed acquired)
    await writeStarted

    mockIsHeadlessMode.mockReturnValue(true)

    const headlessResult = await exportPdf(dummyEvent, {
      ...baseRequest,
      outPath: targetPath,
    })

    expect(headlessResult).toEqual({
      canceled: false,
      error: 'destination-busy',
    })

    releaseWrite?.()

    expect(await guiPromise).toEqual({
      canceled: false,
      path: targetPath,
    })
  })

  it('PDFMAIN-06: parallel exports to different destinations are allowed and succeed', async () => {
    const pathA = 'D:\\exports\\file-a.pdf'
    const pathB = 'D:\\exports\\file-b.pdf'

    let resolveA: () => void = () => {}
    let resolveB: () => void = () => {}
    const gateA = new Promise<void>((resolve) => {
      resolveA = resolve
    })
    const gateB = new Promise<void>((resolve) => {
      resolveB = resolve
    })

    mockShowSaveDialogWithMemory
      .mockResolvedValueOnce({ canceled: false, filePath: pathA })
      .mockResolvedValueOnce({ canceled: false, filePath: pathB })

    mockAtomicWriteFile.mockImplementationOnce(() => gateA).mockImplementationOnce(() => gateB)

    const promiseA = exportPdf(dummyEvent, baseRequest)
    const promiseB = exportPdf(dummyEvent, baseRequest)

    // Both should be in-flight concurrently without blocking each other
    resolveA()
    resolveB()

    const [resA, resB] = await Promise.all([promiseA, promiseB])
    expect(resA).toEqual({ canceled: false, path: pathA })
    expect(resB).toEqual({ canceled: false, path: pathB })
  })

  it('validates workbookExportPdfResultSchema with destination-busy and rejects unknown error', () => {
    const busyResult = { canceled: false, error: 'destination-busy' }
    const parsedBusy = workbookExportPdfResultSchema.safeParse(busyResult)
    expect(parsedBusy.success).toBe(true)

    const successResult = { canceled: false, path: 'C:\\test.pdf' }
    const parsedSuccess = workbookExportPdfResultSchema.safeParse(successResult)
    expect(parsedSuccess.success).toBe(true)

    const canceledResult = { canceled: true }
    const parsedCanceled = workbookExportPdfResultSchema.safeParse(canceledResult)
    expect(parsedCanceled.success).toBe(true)

    // Invalid error code
    const invalidResult = { canceled: false, error: 'random-error' }
    const parsedInvalid = workbookExportPdfResultSchema.safeParse(invalidResult)
    expect(parsedInvalid.success).toBe(false)
  })
})
