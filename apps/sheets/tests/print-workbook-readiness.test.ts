// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  handleExportPdf,
  handlePrint,
  type PageLayoutContext,
} from '../src/renderer/page-layout-actions'
import {
  DEFAULT_FULL_LOAD_TIMEOUT_MS,
  ensureWorkbookFullyLoaded,
  needsWorkbookFullLoad,
} from '../src/renderer/printing/workbook-full-load'
import { buildActiveSheetPrintPayload } from '../src/renderer/printing/print-payload'
import { pdfExportPurpose } from '../src/renderer/printing/print-actions'
import { FULL_LOAD_MAX_CELLS } from '../src/renderer/app-constants'
import { t } from '../src/renderer/i18n/locale'
import type { LazyWorkbookState, UniverRuntime } from '../src/renderer/univer-state'
import { preloadEntireWorkbook } from '../src/renderer/univer-sync'

vi.mock('../src/renderer/univer-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/univer-sync')>()
  return {
    ...actual,
    preloadEntireWorkbook: vi.fn(),
  }
})

function fakeState(
  sheets: Array<{ id: string; name: string; rowCount: number; columnCount: number }>,
  flags: { preloadComplete: boolean; preloadRunning?: boolean },
): LazyWorkbookState {
  return {
    file: {
      sessionId: 'session-test',
      name: 'TestReport.xlsx',
      sheets: sheets.map((s) => ({
        ...s,
        pivotRanges: [],
        tables: [],
        comments: [],
        columnWidths: {},
        styles: [],
      })),
      visuals: [],
      styles: [],
    },
    sheetFilePageSetups: new Map(),
    editJournal: {
      cells: new Map(),
      structuralOps: new Map(),
      pageSetup: new Map(),
      sheets: { added: new Set(), removed: new Set() },
      visualAdds: [],
      visualEdits: new Map(),
      tableAdds: [],
      noteDirty: new Set(),
    },
    loadedRanges: new Map(),
    hyperlinkTargets: new Map(),
    formulaMode: false,
    flags: {
      preloadComplete: flags.preloadComplete,
      preloadRunning: flags.preloadRunning ?? false,
    },
    filterOrigins: new Map(),
    appliedDvSheets: new Set(),
  } as unknown as LazyWorkbookState
}

function createMockContext(state: LazyWorkbookState | null) {
  const messages: string[] = []
  const usedGrid = [
    ['Col1', 'Col2'],
    ['Val1', 'Val2'],
  ]
  const worksheet = {
    getSheetId: () => 'sh1',
    getSheetName: () => 'Sheet1',
    getLastRow: () => 1,
    getLastColumn: () => 1,
    getRowHeight: () => 20,
    getColumnWidth: () => 100,
    getMergedRanges: () => [],
    getRange: (row: number, column: number, numRows?: number, numColumns?: number) => ({
      getDisplayValues: () =>
        usedGrid
          .slice(row, row + (numRows ?? 1))
          .map((cells) => cells.slice(column, column + (numColumns ?? 1))),
      getValues: () =>
        usedGrid
          .slice(row, row + (numRows ?? 1))
          .map((cells) => cells.slice(column, column + (numColumns ?? 1))),
      getCellStyleData: () => null,
    }),
  }
  const workbook = {
    getActiveSheet: () => worksheet,
    getSheetBySheetId: (_id: string) => worksheet,
  }
  const runtime = {
    univerAPI: {
      getActiveWorkbook: () => workbook,
    },
  } as unknown as UniverRuntime

  const ctx: PageLayoutContext = {
    univerRef: { current: runtime },
    lazyWorkbookRef: { current: state },
    setMessage: vi.fn((msg: string) => {
      messages.push(msg)
    }),
    setPendingEdits: vi.fn(),
    runOps: vi.fn(),
  }

  return { ctx, messages, worksheet, runtime }
}

describe('print-workbook-readiness (PRINT-01 to PRINT-21)', () => {
  const printWorkbookMock = vi.fn().mockResolvedValue({ ok: true })
  const exportPdfMock = vi.fn().mockResolvedValue({ canceled: false, path: '/tmp/test.pdf' })
  const readWorkbookMediaMock = vi.fn().mockResolvedValue({ mediaType: 'image/png', base64: '' })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      desktopApi: {
        printWorkbook: printWorkbookMock,
        exportPdf: exportPdfMock,
        readWorkbookMedia: readWorkbookMediaMock,
      },
    })
  })

  it('PRINT-01: preloadComplete=true -> preload NOT called -> print succeeds', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: true,
      preloadRunning: false,
    })
    expect(needsWorkbookFullLoad(state)).toBe(false)
    expect(needsWorkbookFullLoad(null)).toBe(false)
    const { ctx, messages } = createMockContext(state)

    const printed = await handlePrint(ctx)
    expect(printed).toBe(true)
    expect(preloadEntireWorkbook).not.toHaveBeenCalled()
    expect(printWorkbookMock).toHaveBeenCalledTimes(1)
    expect(messages).toContain(t('appPrintSent'))
  })

  it('PRINT-02: preloadComplete=false, preloadRunning=false, cells < limit -> preload called exactly once -> preloadComplete true -> print called', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: false,
      preloadRunning: false,
    })
    expect(needsWorkbookFullLoad(state)).toBe(true)
    const { ctx, messages } = createMockContext(state)

    vi.mocked(preloadEntireWorkbook).mockImplementation(async (_runtime, lazyRef) => {
      if (lazyRef.current) {
        lazyRef.current.flags.preloadRunning = true
        await new Promise((r) => setTimeout(r, 10))
        lazyRef.current.flags.preloadRunning = false
        lazyRef.current.flags.preloadComplete = true
      }
    })

    const printed = await handlePrint(ctx)
    expect(printed).toBe(true)
    expect(preloadEntireWorkbook).toHaveBeenCalledTimes(1)
    expect(state.flags.preloadComplete).toBe(true)
    expect(printWorkbookMock).toHaveBeenCalledTimes(1)
    expect(messages).toContain(t('appPrintLoadingWorkbook'))
    expect(messages).toContain(t('appPrintPreparing'))
    expect(messages).toContain(t('appPrintSent'))
  })

  it('PRINT-03: preloadRunning=true -> no second preload -> wait existing preload -> print after complete', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 50, columnCount: 20 }], {
      preloadComplete: false,
      preloadRunning: true,
    })
    const { ctx, messages } = createMockContext(state)

    setTimeout(() => {
      state.flags.preloadRunning = false
      state.flags.preloadComplete = true
    }, 60)

    const printed = await handlePrint(ctx)
    expect(printed).toBe(true)
    expect(preloadEntireWorkbook).not.toHaveBeenCalled()
    expect(printWorkbookMock).toHaveBeenCalledTimes(1)
    expect(messages).toContain(t('appPrintSent'))
  })

  it('PRINT-04: two callers enter while preload starts -> action-level single-flight dedupes print execution', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: false,
      preloadRunning: false,
    })
    const { ctx } = createMockContext(state)

    vi.mocked(preloadEntireWorkbook).mockImplementation(async (_runtime, lazyRef) => {
      if (lazyRef.current) {
        lazyRef.current.flags.preloadRunning = true
        await new Promise((r) => setTimeout(r, 80))
        lazyRef.current.flags.preloadRunning = false
        lazyRef.current.flags.preloadComplete = true
      }
    })

    const [result1, result2] = await Promise.all([handlePrint(ctx), handlePrint(ctx)])

    expect(result1).toBe(true)
    expect(result2).toBe(true)
    expect(preloadEntireWorkbook).toHaveBeenCalledTimes(1)
    expect(printWorkbookMock).toHaveBeenCalledTimes(1)
  })

  it('PRINT-05: exactly FULL_LOAD_MAX_CELLS (250_000) -> allowed', async () => {
    const state = fakeState([{ id: 'sh1', name: 'SheetExact', rowCount: 500, columnCount: 500 }], {
      preloadComplete: false,
      preloadRunning: false,
    })
    const firstSheet = state.file.sheets[0]!
    expect(firstSheet.rowCount * firstSheet.columnCount).toBe(FULL_LOAD_MAX_CELLS)
    const { ctx, messages } = createMockContext(state)

    vi.mocked(preloadEntireWorkbook).mockImplementation(async (_runtime, lazyRef) => {
      if (lazyRef.current) {
        lazyRef.current.flags.preloadRunning = true
        await new Promise((r) => setTimeout(r, 10))
        lazyRef.current.flags.preloadRunning = false
        lazyRef.current.flags.preloadComplete = true
      }
    })

    const result = await ensureWorkbookFullyLoaded(ctx, state, {
      purpose: 'print',
      maxCells: FULL_LOAD_MAX_CELLS,
      timeoutMs: DEFAULT_FULL_LOAD_TIMEOUT_MS,
    })
    expect(result.status).toBe('ready')
    expect(preloadEntireWorkbook).toHaveBeenCalledTimes(1)
    expect(messages).not.toContain(t('appPrintWorkbookTooLarge'))
  })

  it('PRINT-06: FULL_LOAD_MAX_CELLS + 1 (250_001) -> preload not called -> print not called -> appPrintWorkbookTooLarge', async () => {
    const state = fakeState(
      [
        { id: 'sh1', name: 'SheetPart1', rowCount: 500, columnCount: 500 }, // 250,000
        { id: 'sh2', name: 'SheetPart2', rowCount: 1, columnCount: 1 }, // 1 -> total 250,001
      ],
      {
        preloadComplete: false,
        preloadRunning: false,
      },
    )
    const totalCells = state.file.sheets.reduce((sum, s) => sum + s.rowCount * s.columnCount, 0)
    expect(totalCells).toBe(FULL_LOAD_MAX_CELLS + 1)

    const { ctx, messages } = createMockContext(state)

    const printed = await handlePrint(ctx)
    expect(printed).toBe(false)
    expect(preloadEntireWorkbook).not.toHaveBeenCalled()
    expect(printWorkbookMock).not.toHaveBeenCalled()
    expect(messages).toContain(t('appPrintWorkbookTooLarge'))
    expect(messages[messages.length - 1]).toBe(t('appPrintWorkbookTooLarge'))
  })

  it('PRINT-07: preloadRunning stops but preloadComplete remains false -> no print -> appPrintFailed', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: false,
      preloadRunning: true,
    })
    const { ctx, messages } = createMockContext(state)

    setTimeout(() => {
      state.flags.preloadRunning = false
      state.flags.preloadComplete = false
    }, 40)

    const printed = await handlePrint(ctx)
    expect(printed).toBe(false)
    expect(printWorkbookMock).not.toHaveBeenCalled()
    expect(messages).toContain(t('appPrintFailed'))
  })

  it('PRINT-08: preload promise rejects -> no print -> appPrintFailed', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: false,
      preloadRunning: false,
    })
    const { ctx, messages } = createMockContext(state)

    vi.mocked(preloadEntireWorkbook).mockRejectedValue(new Error('Preload failed fatally'))

    const printed = await handlePrint(ctx)
    expect(printed).toBe(false)
    expect(printWorkbookMock).not.toHaveBeenCalled()
    expect(messages).toContain(t('appPrintFailed'))
  })

  it('PRINT-09: preloadRunning never clears -> timeout -> no infinite promise -> no print -> timedOut', async () => {
    vi.useFakeTimers()
    try {
      const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
        preloadComplete: false,
        preloadRunning: true,
      })
      const { ctx, messages } = createMockContext(state)

      const printPromise = handlePrint(ctx)
      await vi.advanceTimersByTimeAsync(185_000)
      const printed = await printPromise

      expect(printed).toBe(false)
      expect(printWorkbookMock).not.toHaveBeenCalled()
      expect(messages).toContain(t('appPrintLoadTimedOut'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('PRINT-10: self-started preload (preloadRunning=false at start) hangs indefinitely -> after 185s timeout -> appPrintLoadTimedOut', async () => {
    vi.useFakeTimers()
    try {
      const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
        preloadComplete: false,
        preloadRunning: false,
      })
      const { ctx, messages } = createMockContext(state)

      vi.mocked(preloadEntireWorkbook).mockImplementation(async () => {
        state.flags.preloadRunning = true
        return new Promise(() => {})
      })

      const printPromise = handlePrint(ctx)
      await vi.advanceTimersByTimeAsync(185_000)
      const printed = await printPromise

      expect(printed).toBe(false)
      expect(printWorkbookMock).not.toHaveBeenCalled()
      expect(messages).toContain(t('appPrintLoadTimedOut'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('PRINT-11: lazyWorkbookRef changes during preload -> stale state rejected -> old workbook never printed', async () => {
    const stateOld = fakeState([{ id: 'sh1', name: 'SheetOld', rowCount: 100, columnCount: 10 }], {
      preloadComplete: false,
      preloadRunning: false,
    })
    const stateNew = fakeState([{ id: 'sh2', name: 'SheetNew', rowCount: 100, columnCount: 10 }], {
      preloadComplete: false,
      preloadRunning: false,
    })
    const { ctx } = createMockContext(stateOld)

    vi.mocked(preloadEntireWorkbook).mockImplementation(async () => {
      // User switched workbook during preload
      ctx.lazyWorkbookRef.current = stateNew
      stateOld.flags.preloadComplete = true
    })

    const printed = await handlePrint(ctx)
    expect(printed).toBe(false)
    expect(printWorkbookMock).not.toHaveBeenCalled()
  })

  it('PRINT-12: handleExportPdf under limit -> preload -> exportPdf called', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: false,
      preloadRunning: false,
    })
    const { ctx, messages } = createMockContext(state)

    vi.mocked(preloadEntireWorkbook).mockImplementation(async (_runtime, lazyRef) => {
      if (lazyRef.current) {
        lazyRef.current.flags.preloadRunning = true
        await new Promise((r) => setTimeout(r, 10))
        lazyRef.current.flags.preloadRunning = false
        lazyRef.current.flags.preloadComplete = true
      }
    })

    const exported = await handleExportPdf(ctx)
    expect(exported).toBe(true)
    expect(preloadEntireWorkbook).toHaveBeenCalledTimes(1)
    expect(exportPdfMock).toHaveBeenCalledTimes(1)
    expect(messages).toContain(t('appPdfLoadingWorkbook'))
    expect(messages).toContain(t('appPdfRendering'))
    expect(messages).toContain(t('appPdfExported', { path: '/tmp/test.pdf' }))
  })

  it('PRINT-13: handleExportPdf over limit -> no exportPdf call -> PDF-specific too-large message', async () => {
    const state = fakeState(
      [{ id: 'sh1', name: 'SheetHuge', rowCount: 1000, columnCount: 300 }], // 300,000 cells > 250,000
      { preloadComplete: false, preloadRunning: false },
    )
    const { ctx, messages } = createMockContext(state)

    const exported = await handleExportPdf(ctx)
    expect(exported).toBe(false)
    expect(preloadEntireWorkbook).not.toHaveBeenCalled()
    expect(exportPdfMock).not.toHaveBeenCalled()
    expect(messages).toContain(t('appPdfWorkbookTooLarge'))
    expect(messages[messages.length - 1]).toBe(t('appPdfWorkbookTooLarge'))
  })

  it('PRINT-14: normal already-loaded workbook -> output identical to baseline', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: true,
      preloadRunning: false,
    })
    const { ctx, messages } = createMockContext(state)

    const printed = await handlePrint(ctx)
    expect(printed).toBe(true)
    expect(preloadEntireWorkbook).not.toHaveBeenCalled()
    expect(printWorkbookMock).toHaveBeenCalledTimes(1)
    expect(messages).toContain(t('appPrintSent'))

    const exported = await handleExportPdf(ctx)
    expect(exported).toBe(true)
    expect(preloadEntireWorkbook).not.toHaveBeenCalled()
    expect(exportPdfMock).toHaveBeenCalledTimes(1)
    expect(messages).toContain(t('appPdfExported', { path: '/tmp/test.pdf' }))
  })

  it('PRINT-15: self-started preload for PDF export hangs indefinitely -> after 185s timeout -> appPdfLoadTimedOut', async () => {
    vi.useFakeTimers()
    try {
      const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
        preloadComplete: false,
        preloadRunning: false,
      })
      const { ctx, messages } = createMockContext(state)

      vi.mocked(preloadEntireWorkbook).mockImplementation(async () => {
        state.flags.preloadRunning = true
        return new Promise(() => {})
      })

      const exportPromise = handleExportPdf(ctx)
      await vi.advanceTimersByTimeAsync(185_000)
      const exported = await exportPromise

      expect(exported).toBe(false)
      expect(exportPdfMock).not.toHaveBeenCalled()
      expect(messages).toContain(t('appPdfLoadTimedOut'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('PRINT-16: preload promise rejects during PDF export -> no export -> appPdfExportFailed', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: false,
      preloadRunning: false,
    })
    const { ctx, messages } = createMockContext(state)

    vi.mocked(preloadEntireWorkbook).mockRejectedValue(new Error('PDF Preload failed fatally'))

    const exported = await handleExportPdf(ctx)
    expect(exported).toBe(false)
    expect(exportPdfMock).not.toHaveBeenCalled()
    expect(messages).toContain(t('appPdfExportFailed'))
  })

  it('PRINT-17: ensureWorkbookFullyLoaded non-poisoning retry: first call rejects, subsequent call retries and succeeds', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: false,
      preloadRunning: false,
    })
    const { ctx } = createMockContext(state)

    vi.mocked(preloadEntireWorkbook).mockRejectedValueOnce(new Error('First try network failure'))

    const firstResult = await ensureWorkbookFullyLoaded(ctx, state, {
      purpose: 'print',
      maxCells: FULL_LOAD_MAX_CELLS,
      timeoutMs: DEFAULT_FULL_LOAD_TIMEOUT_MS,
    })
    expect(firstResult.status).toBe('failed')
    expect(preloadEntireWorkbook).toHaveBeenCalledTimes(1)

    vi.mocked(preloadEntireWorkbook).mockImplementationOnce(async (_runtime, lazyRef) => {
      if (lazyRef.current) {
        lazyRef.current.flags.preloadRunning = true
        await new Promise((r) => setTimeout(r, 10))
        lazyRef.current.flags.preloadRunning = false
        lazyRef.current.flags.preloadComplete = true
      }
    })

    const secondResult = await ensureWorkbookFullyLoaded(ctx, state, {
      purpose: 'print',
      maxCells: FULL_LOAD_MAX_CELLS,
      timeoutMs: DEFAULT_FULL_LOAD_TIMEOUT_MS,
    })
    expect(secondResult.status).toBe('ready')
    expect(preloadEntireWorkbook).toHaveBeenCalledTimes(2)
  })

  it('PRINT-18: invalid workbook dimensions -> ensureWorkbookFullyLoaded returns failed', async () => {
    const stateNegative = fakeState(
      [{ id: 'sh1', name: 'Sheet1', rowCount: -5, columnCount: 10 }],
      {
        preloadComplete: false,
        preloadRunning: false,
      },
    )
    const { ctx } = createMockContext(stateNegative)

    const result = await ensureWorkbookFullyLoaded(ctx, stateNegative, {
      purpose: 'print',
      maxCells: FULL_LOAD_MAX_CELLS,
      timeoutMs: DEFAULT_FULL_LOAD_TIMEOUT_MS,
    })
    expect(result.status).toBe('failed')
    expect(result).toHaveProperty('error')
    expect((result as { error: Error }).error.message).toBe('Invalid workbook dimensions')
    expect(preloadEntireWorkbook).not.toHaveBeenCalled()
  })

  it('PRINT-19: runtime uninitialized -> ensureWorkbookFullyLoaded returns failed', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: false,
      preloadRunning: false,
    })
    const { ctx } = createMockContext(state)
    ;(ctx.univerRef as { current: UniverRuntime | null }).current = null

    const result = await ensureWorkbookFullyLoaded(ctx, state, {
      purpose: 'print',
      maxCells: FULL_LOAD_MAX_CELLS,
      timeoutMs: DEFAULT_FULL_LOAD_TIMEOUT_MS,
    })
    expect(result.status).toBe('failed')
    expect(result).toHaveProperty('error')
    expect((result as { error: Error }).error.message).toBe('Univer runtime not initialized')
    expect(preloadEntireWorkbook).not.toHaveBeenCalled()
  })

  it('PRINT-20: active sheet unavailable after preload -> buildActiveSheetPrintPayload returns active-sheet-unavailable -> handlePrint sets appActiveSheetUnavailable', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: true,
      preloadRunning: false,
    })
    const { ctx, messages, runtime } = createMockContext(state)
    vi.spyOn(runtime.univerAPI, 'getActiveWorkbook').mockReturnValue({
      getActiveSheet: () => null as unknown as any,
      getSheetBySheetId: () => null as unknown as any,
    } as any)

    const payloadResult = await buildActiveSheetPrintPayload(ctx, 'print')
    expect(payloadResult.status).toBe('active-sheet-unavailable')

    const printed = await handlePrint(ctx)
    expect(printed).toBe(false)
    expect(messages).toContain(t('appActiveSheetUnavailable'))
  })

  it('PRINT-21: stale workbook detected in buildActiveSheetPrintPayload -> returns stale-workbook', async () => {
    const stateOld = fakeState([{ id: 'sh1', name: 'SheetOld', rowCount: 100, columnCount: 10 }], {
      preloadComplete: false,
      preloadRunning: false,
    })
    const stateNew = fakeState([{ id: 'sh2', name: 'SheetNew', rowCount: 100, columnCount: 10 }], {
      preloadComplete: true,
      preloadRunning: false,
    })
    const { ctx } = createMockContext(stateOld)

    vi.mocked(preloadEntireWorkbook).mockImplementation(async () => {
      stateOld.flags.preloadComplete = true
      ctx.lazyWorkbookRef.current = stateNew
    })

    const payloadResult = await buildActiveSheetPrintPayload(ctx, 'print')
    expect(payloadResult.status).toBe('stale-workbook')
    expect('payload' in payloadResult).toBe(false)
  })

  it('PRINT-22: switch workbook while header/footer media (readWorkbookMedia) is loading -> returns stale-workbook, ctx.setMessage receives appPrintCanceled, printWorkbook not called', async () => {
    const stateOld = fakeState([{ id: 'sh1', name: 'SheetOld', rowCount: 100, columnCount: 10 }], {
      preloadComplete: true,
      preloadRunning: false,
    })
    stateOld.sheetFilePageSetups.set('sh1', {
      headerFooterPictures: [
        {
          id: 'media-header-logo',
          position: '&L',
          widthPt: 120,
          heightPt: 40,
          mediaType: 'image/png',
        },
      ],
    })
    const stateNew = fakeState([{ id: 'sh2', name: 'SheetNew', rowCount: 100, columnCount: 10 }], {
      preloadComplete: true,
      preloadRunning: false,
    })
    const { ctx, messages } = createMockContext(stateOld)

    readWorkbookMediaMock.mockImplementationOnce(async () => {
      // User switches workbook during media fetch
      ctx.lazyWorkbookRef.current = stateNew
      return {
        mediaType: 'image/png',
        base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      }
    })

    const printed = await handlePrint(ctx)
    expect(printed).toBe(false)
    expect(printWorkbookMock).not.toHaveBeenCalled()
    expect(messages).toContain(t('appPrintCanceled'))
  })

  it('PRINT-23: switch workbook while visual nodes are settling (settledVisualFrames) -> stale-workbook, no print', async () => {
    const stateOld = fakeState([{ id: 'sh1', name: 'SheetOld', rowCount: 100, columnCount: 10 }], {
      preloadComplete: true,
      preloadRunning: false,
    })
    stateOld.file.visuals.push({
      id: 'chart-1',
      sheetId: 'sh1',
      frame: { left: 10, top: 10, width: 200, height: 150 },
    } as any)
    const stateNew = fakeState([{ id: 'sh2', name: 'SheetNew', rowCount: 100, columnCount: 10 }], {
      preloadComplete: true,
      preloadRunning: false,
    })
    const { ctx, messages } = createMockContext(stateOld)
    ctx.requestVisualInstall = vi.fn(() => {
      // User switches workbook during visual settlement
      ctx.lazyWorkbookRef.current = stateNew
    })

    const printed = await handlePrint(ctx)
    expect(printed).toBe(false)
    expect(printWorkbookMock).not.toHaveBeenCalled()
    expect(messages).toContain(t('appPrintCanceled'))
  })

  it('PRINT-24: active sheet changes during visual preparation -> stale, no print', async () => {
    const state = fakeState(
      [
        { id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 },
        { id: 'sh2', name: 'Sheet2', rowCount: 100, columnCount: 10 },
      ],
      {
        preloadComplete: true,
        preloadRunning: false,
      },
    )
    state.file.visuals.push({
      id: 'chart-1',
      sheetId: 'sh1',
      frame: { left: 10, top: 10, width: 200, height: 150 },
    } as any)
    const { ctx, messages, runtime, worksheet } = createMockContext(state)

    const worksheet2 = {
      ...worksheet,
      getSheetId: () => 'sh2',
      getSheetName: () => 'Sheet2',
    }

    ctx.requestVisualInstall = vi.fn(() => {
      // User switches active sheet during visual preparation
      vi.spyOn(runtime.univerAPI.getActiveWorkbook()!, 'getActiveSheet').mockReturnValue(
        worksheet2 as any,
      )
    })

    const printed = await handlePrint(ctx)
    expect(printed).toBe(false)
    expect(printWorkbookMock).not.toHaveBeenCalled()
    expect(messages).toContain(t('appPrintCanceled'))
  })

  it('PRINT-25: Print + PDF share single physical preload -> preloadEntireWorkbook called exactly once', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: false,
      preloadRunning: false,
    })
    const { ctx } = createMockContext(state)

    vi.mocked(preloadEntireWorkbook).mockImplementation(async (_runtime, lazyRef) => {
      if (lazyRef.current) {
        lazyRef.current.flags.preloadRunning = true
        await new Promise((r) => setTimeout(r, 60))
        lazyRef.current.flags.preloadRunning = false
        lazyRef.current.flags.preloadComplete = true
      }
    })

    const [printOk, pdfOk] = await Promise.all([handlePrint(ctx), handleExportPdf(ctx)])

    expect(printOk).toBe(true)
    expect(pdfOk).toBe(true)
    expect(preloadEntireWorkbook).toHaveBeenCalledTimes(1)
    expect(printWorkbookMock).toHaveBeenCalledTimes(1)
    expect(exportPdfMock).toHaveBeenCalledTimes(1)
  })

  it('PRINT-26: double PDF calls share single physical preload -> preload exactly once', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: false,
      preloadRunning: false,
    })
    const { ctx } = createMockContext(state)

    vi.mocked(preloadEntireWorkbook).mockImplementation(async (_runtime, lazyRef) => {
      if (lazyRef.current) {
        lazyRef.current.flags.preloadRunning = true
        await new Promise((r) => setTimeout(r, 60))
        lazyRef.current.flags.preloadRunning = false
        lazyRef.current.flags.preloadComplete = true
      }
    })

    const [pdf1, pdf2] = await Promise.all([handleExportPdf(ctx), handleExportPdf(ctx)])

    expect(pdf1).toBe(true)
    expect(pdf2).toBe(true)
    expect(preloadEntireWorkbook).toHaveBeenCalledTimes(1)
    expect(exportPdfMock).toHaveBeenCalledTimes(1)
  })

  it('PRINT-27: Caller A (timeout 100ms) and Caller B (timeout 5000ms) have independent timeout policies while sharing one hanging preload', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: false,
      preloadRunning: false,
    })
    const { ctx } = createMockContext(state)

    vi.mocked(preloadEntireWorkbook).mockImplementation(async (_runtime, lazyRef) => {
      if (lazyRef.current) {
        lazyRef.current.flags.preloadRunning = true
        // Preload takes 250ms, longer than Caller A (100ms) but shorter than Caller B (5000ms)
        await new Promise((r) => setTimeout(r, 250))
        lazyRef.current.flags.preloadRunning = false
        lazyRef.current.flags.preloadComplete = true
      }
    })

    const [resultA, resultB] = await Promise.all([
      ensureWorkbookFullyLoaded(ctx, state, {
        purpose: 'print',
        maxCells: FULL_LOAD_MAX_CELLS,
        timeoutMs: 100,
      }),
      ensureWorkbookFullyLoaded(ctx, state, {
        purpose: 'pdf-export',
        maxCells: FULL_LOAD_MAX_CELLS,
        timeoutMs: 5000,
      }),
    ])

    expect(resultA.status).toBe('timeout')
    expect(resultB.status).toBe('ready')
    expect(preloadEntireWorkbook).toHaveBeenCalledTimes(1)
  })

  it('PRINT-28: successful preload cleans up shared operation in WeakMap -> second preload call starts fresh without stale promise', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: false,
      preloadRunning: false,
    })
    const { ctx } = createMockContext(state)

    vi.mocked(preloadEntireWorkbook).mockImplementation(async (_runtime, lazyRef) => {
      if (lazyRef.current) {
        lazyRef.current.flags.preloadRunning = true
        await new Promise((r) => setTimeout(r, 20))
        lazyRef.current.flags.preloadRunning = false
        lazyRef.current.flags.preloadComplete = true
      }
    })

    const firstResult = await ensureWorkbookFullyLoaded(ctx, state, {
      purpose: 'print',
      maxCells: FULL_LOAD_MAX_CELLS,
      timeoutMs: DEFAULT_FULL_LOAD_TIMEOUT_MS,
    })
    expect(firstResult.status).toBe('ready')
    expect(preloadEntireWorkbook).toHaveBeenCalledTimes(1)

    // Reset preloadComplete to test if second preload starts fresh
    state.flags.preloadComplete = false

    const secondResult = await ensureWorkbookFullyLoaded(ctx, state, {
      purpose: 'print',
      maxCells: FULL_LOAD_MAX_CELLS,
      timeoutMs: DEFAULT_FULL_LOAD_TIMEOUT_MS,
    })
    expect(secondResult.status).toBe('ready')
    expect(preloadEntireWorkbook).toHaveBeenCalledTimes(2)
  })

  it('PRINT-29: workbook declaring Number.MAX_SAFE_INTEGER cells fails safely with status failed', async () => {
    const state = fakeState(
      [{ id: 'sh1', name: 'SheetHuge', rowCount: Number.MAX_SAFE_INTEGER, columnCount: 1 }],
      {
        preloadComplete: false,
        preloadRunning: false,
      },
    )
    const { ctx } = createMockContext(state)

    const result = await ensureWorkbookFullyLoaded(ctx, state, {
      purpose: 'print',
      maxCells: FULL_LOAD_MAX_CELLS,
      timeoutMs: DEFAULT_FULL_LOAD_TIMEOUT_MS,
    })

    expect(result.status).toBe('failed')
    expect(result).toHaveProperty('error')
    expect((result as { error: Error }).error.message).toBe('Invalid workbook dimensions')
    expect(preloadEntireWorkbook).not.toHaveBeenCalled()
  })

  it('PRINT-30: workbook declaring Infinity or NaN dimensions fails safely', async () => {
    const stateInfinity = fakeState(
      [{ id: 'sh1', name: 'SheetInf', rowCount: Infinity, columnCount: 10 }],
      {
        preloadComplete: false,
        preloadRunning: false,
      },
    )
    const { ctx: ctxInf } = createMockContext(stateInfinity)

    const resultInf = await ensureWorkbookFullyLoaded(ctxInf, stateInfinity, {
      purpose: 'print',
      maxCells: FULL_LOAD_MAX_CELLS,
      timeoutMs: DEFAULT_FULL_LOAD_TIMEOUT_MS,
    })
    expect(resultInf.status).toBe('failed')
    expect((resultInf as { error: Error }).error.message).toBe('Invalid workbook dimensions')

    const stateNaN = fakeState([{ id: 'sh1', name: 'SheetNaN', rowCount: NaN, columnCount: 10 }], {
      preloadComplete: false,
      preloadRunning: false,
    })
    const { ctx: ctxNaN } = createMockContext(stateNaN)

    const resultNaN = await ensureWorkbookFullyLoaded(ctxNaN, stateNaN, {
      purpose: 'print',
      maxCells: FULL_LOAD_MAX_CELLS,
      timeoutMs: DEFAULT_FULL_LOAD_TIMEOUT_MS,
    })
    expect(resultNaN.status).toBe('failed')
    expect((resultNaN as { error: Error }).error.message).toBe('Invalid workbook dimensions')
    expect(preloadEntireWorkbook).not.toHaveBeenCalled()
  })

  it('PRINT-31: active sheet unavailable -> sets appActiveSheetUnavailable (NOT generic appPrintFailed)', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: true,
      preloadRunning: false,
    })
    const { ctx, messages, runtime } = createMockContext(state)
    vi.spyOn(runtime.univerAPI, 'getActiveWorkbook').mockReturnValue({
      getActiveSheet: () => null as unknown as any,
      getSheetBySheetId: () => null as unknown as any,
    } as any)

    const printed = await handlePrint(ctx)
    expect(printed).toBe(false)
    expect(messages).toContain(t('appActiveSheetUnavailable'))
    expect(messages).not.toContain(t('appPrintFailed'))
  })

  it('PRINT-32: stale workbook after loading message displayed -> clears stale loading message, sets appPrintCanceled or appPdfCanceled', async () => {
    const stateOld = fakeState([{ id: 'sh1', name: 'SheetOld', rowCount: 100, columnCount: 10 }], {
      preloadComplete: false,
      preloadRunning: false,
    })
    const stateNew = fakeState([{ id: 'sh2', name: 'SheetNew', rowCount: 100, columnCount: 10 }], {
      preloadComplete: true,
      preloadRunning: false,
    })
    const { ctx: ctxPrint, messages: messagesPrint } = createMockContext(stateOld)

    vi.mocked(preloadEntireWorkbook).mockImplementationOnce(async () => {
      // User switches workbook while loading message is displayed
      ctxPrint.lazyWorkbookRef.current = stateNew
    })

    const printed = await handlePrint(ctxPrint)
    expect(printed).toBe(false)
    expect(messagesPrint).toContain(t('appPrintLoadingWorkbook'))
    expect(messagesPrint[messagesPrint.length - 1]).toBe(t('appPrintCanceled'))

    const statePdfOld = fakeState(
      [{ id: 'sh1', name: 'SheetPdfOld', rowCount: 100, columnCount: 10 }],
      {
        preloadComplete: false,
        preloadRunning: false,
      },
    )
    const { ctx: ctxPdf, messages: messagesPdf } = createMockContext(statePdfOld)

    vi.mocked(preloadEntireWorkbook).mockImplementationOnce(async () => {
      ctxPdf.lazyWorkbookRef.current = stateNew
    })

    const exported = await handleExportPdf(ctxPdf)
    expect(exported).toBe(false)
    expect(messagesPdf).toContain(t('appPdfLoadingWorkbook'))
    expect(messagesPdf[messagesPdf.length - 1]).toBe(t('appPdfCanceled'))
  })

  it('PRINT-33: PDF with outPath -> routes to headless-export purpose and passes outPath to exportPdf', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: true,
      preloadRunning: false,
    })
    const { ctx, messages } = createMockContext(state)
    const targetPath = '/tmp/headless-automated-report.pdf'

    const exported = await handleExportPdf(ctx, targetPath)
    expect(exported).toBe(true)
    expect(pdfExportPurpose(targetPath)).toBe('headless-export')
    expect(exportPdfMock).toHaveBeenCalledTimes(1)
    expect(exportPdfMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outPath: targetPath,
      }),
    )
    expect(messages).toContain(t('appPdfExported', { path: '/tmp/test.pdf' }))
  })

  it('PRINT-34: double Print rapid clicks on same workbook -> action-level dedup: opens only 1 print dialog', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: true,
      preloadRunning: false,
    })
    const { ctx } = createMockContext(state)

    printWorkbookMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50))
      return { ok: true }
    })

    const [p1, p2] = await Promise.all([handlePrint(ctx), handlePrint(ctx)])

    expect(p1).toBe(true)
    expect(p2).toBe(true)
    expect(printWorkbookMock).toHaveBeenCalledTimes(1)
  })

  it('PRINT-35: double PDF export rapid clicks on same workbook -> action-level dedup: opens only 1 export dialog', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: true,
      preloadRunning: false,
    })
    const { ctx } = createMockContext(state)

    exportPdfMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50))
      return { canceled: false, path: '/tmp/test.pdf' }
    })

    const [pdf1, pdf2] = await Promise.all([handleExportPdf(ctx), handleExportPdf(ctx)])

    expect(pdf1).toBe(true)
    expect(pdf2).toBe(true)
    expect(exportPdfMock).toHaveBeenCalledTimes(1)
  })

  it('PRINT-36: Untitled/new workbook with lazyWorkbookRef.current = null and active worksheet -> Print succeeds', async () => {
    const { ctx, messages } = createMockContext(null)
    expect(ctx.lazyWorkbookRef.current).toBeNull()

    const printed = await handlePrint(ctx)
    expect(printed).toBe(true)
    expect(printWorkbookMock).toHaveBeenCalledTimes(1)
    expect(printWorkbookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: expect.any(String),
        html: expect.any(String),
      }),
    )
    expect(messages).toContain(t('appPrintSent'))
  })

  it('PRINT-37: Untitled/new workbook with lazyWorkbookRef.current = null and active worksheet -> Export PDF succeeds', async () => {
    const { ctx, messages } = createMockContext(null)
    expect(ctx.lazyWorkbookRef.current).toBeNull()

    const exported = await handleExportPdf(ctx)
    expect(exported).toBe(true)
    expect(exportPdfMock).toHaveBeenCalledTimes(1)
    expect(exportPdfMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: expect.any(String),
        html: expect.any(String),
      }),
    )
    expect(messages).toContain(t('appPdfExported', { path: '/tmp/test.pdf' }))
  })

  it('PRINT-38: concurrent headless exports with different outPaths run independently and are not swallowed', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: true,
      preloadRunning: false,
    })
    const { ctx } = createMockContext(state)

    exportPdfMock.mockImplementation(async (payload: any) => {
      await new Promise((r) => setTimeout(r, 30))
      return { canceled: false, path: payload.outPath }
    })

    const [pdfA, pdfB] = await Promise.all([
      handleExportPdf(ctx, 'D:/out-a.pdf'),
      handleExportPdf(ctx, 'D:/out-b.pdf'),
    ])

    expect(pdfA).toBe(true)
    expect(pdfB).toBe(true)
    expect(exportPdfMock).toHaveBeenCalledTimes(2)
    expect(exportPdfMock).toHaveBeenCalledWith(expect.objectContaining({ outPath: 'D:/out-a.pdf' }))
    expect(exportPdfMock).toHaveBeenCalledWith(expect.objectContaining({ outPath: 'D:/out-b.pdf' }))
  })

  it('PRINT-39: concurrent headless exports with same exact outPath are deduplicated', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: true,
      preloadRunning: false,
    })
    const { ctx } = createMockContext(state)

    exportPdfMock.mockImplementation(async (payload: any) => {
      await new Promise((r) => setTimeout(r, 50))
      return { canceled: false, path: payload.outPath }
    })

    const [pdf1, pdf2] = await Promise.all([
      handleExportPdf(ctx, 'D:/same.pdf'),
      handleExportPdf(ctx, 'D:/same.pdf'),
    ])

    expect(pdf1).toBe(true)
    expect(pdf2).toBe(true)
    expect(exportPdfMock).toHaveBeenCalledTimes(1)
    expect(exportPdfMock).toHaveBeenCalledWith(expect.objectContaining({ outPath: 'D:/same.pdf' }))
  })

  it('PRINT-40: concurrent GUI PDF export and headless export do not swallow each other', async () => {
    const state = fakeState([{ id: 'sh1', name: 'Sheet1', rowCount: 100, columnCount: 10 }], {
      preloadComplete: true,
      preloadRunning: false,
    })
    const { ctx } = createMockContext(state)

    exportPdfMock.mockImplementation(async (payload: any) => {
      await new Promise((r) => setTimeout(r, 50))
      return { canceled: false, path: payload.outPath ?? '/tmp/gui.pdf' }
    })

    const [guiResult, headlessResult] = await Promise.all([
      handleExportPdf(ctx),
      handleExportPdf(ctx, 'D:/headless.pdf'),
    ])

    expect(guiResult).toBe(true)
    expect(headlessResult).toBe(true)
    expect(exportPdfMock).toHaveBeenCalledTimes(2)
    const calls = exportPdfMock.mock.calls
    expect(calls.some(([arg]) => !('outPath' in arg))).toBe(true)
    expect(calls.some(([arg]) => arg.outPath === 'D:/headless.pdf')).toBe(true)
  })
})
