// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ensurePrintWorkbookLoaded,
  handleExportPdf,
  handlePrint,
  type PageLayoutContext,
  type PrintReadinessMessages,
} from '../src/renderer/page-layout-actions'
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

function createMockContext(state: LazyWorkbookState) {
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

describe('print-workbook-readiness (PRINT-01 to PRINT-13)', () => {
  const printWorkbookMock = vi.fn().mockResolvedValue({ ok: true })
  const exportPdfMock = vi.fn().mockResolvedValue({ canceled: false, path: '/tmp/test.pdf' })
  const readWorkbookMediaMock = vi.fn().mockResolvedValue({ mediaType: 'image/png', base64: '' })

  const testPrintMessages: PrintReadinessMessages = {
    notLoaded: t('appPrintNeedsFullLoad'),
    loading: t('appPrintLoadingWorkbook'),
    tooLarge: t('appPrintWorkbookTooLarge'),
    timedOut: t('appPrintLoadTimedOut'),
    failed: t('appPrintFailed'),
    preparing: t('appPrintPreparing'),
  }

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

  it('PRINT-04: two callers enter while preload starts -> only one preloadEntireWorkbook invocation', async () => {
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
    expect(printWorkbookMock).toHaveBeenCalledTimes(2)
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

    const success = await ensurePrintWorkbookLoaded(ctx, state, testPrintMessages)
    expect(success).toBe(true)
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

  it('PRINT-07: preloadRunning stops but preloadComplete remains false -> no print -> notLoaded', async () => {
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
    expect(messages).toContain(t('appPrintNeedsFullLoad'))
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

  it('PRINT-09B: self-started preload (preloadRunning=false at start) hangs indefinitely -> after 185s timeout -> appPrintLoadTimedOut', async () => {
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

  it('PRINT-10: lazyWorkbookRef changes during preload -> stale state rejected -> old workbook never printed', async () => {
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

  it('PRINT-11: handleExportPdf under limit -> preload -> exportPdf called', async () => {
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

  it('PRINT-12: handleExportPdf over limit -> no exportPdf call -> PDF-specific too-large message', async () => {
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

  it('PRINT-13: normal already-loaded workbook -> output identical to baseline', async () => {
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

  it('PDF-14: self-started preload for PDF export hangs indefinitely -> after 185s timeout -> appPdfLoadTimedOut', async () => {
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

  it('PDF-15: preload promise rejects during PDF export -> no export -> appPdfExportFailed', async () => {
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
})
