import { describe, expect, it } from 'vitest'

import { parsePdfExportResult } from '../src/preload/pdf-export-result'
import type { WorkbookExportPdfResult } from '../src/shared/desktop-api'

describe('parsePdfExportResult contract tests', () => {
  it('PRELOAD-PDF-01: Cancel { canceled: true } -> parses { canceled: true }', () => {
    const input = { canceled: true }
    const result = parsePdfExportResult(input)
    expect(result).toEqual({ canceled: true })
  })

  it('PRELOAD-PDF-02: Success { canceled: false, path: "D:\\\\output.pdf" } -> parses { canceled: false, path: "D:\\\\output.pdf" }', () => {
    const input = { canceled: false, path: 'D:\\output.pdf' }
    const result = parsePdfExportResult(input)
    expect(result).toEqual({ canceled: false, path: 'D:\\output.pdf' })
  })

  it('PRELOAD-PDF-03: Destination busy { canceled: false, error: "destination-busy" } -> parses { canceled: false, error: "destination-busy" }', () => {
    const input = { canceled: false, error: 'destination-busy' }
    const result = parsePdfExportResult(input)
    expect(result).toEqual({ canceled: false, error: 'destination-busy' })
  })

  it('PRELOAD-PDF-04: Missing result payload { canceled: false } -> throws "Invalid PDF export response."', () => {
    const input = { canceled: false }
    expect(() => parsePdfExportResult(input)).toThrow('Invalid PDF export response.')
  })

  it('PRELOAD-PDF-05: Unknown error { canceled: false, error: "random-error" } -> throws "Invalid PDF export response."', () => {
    const input = { canceled: false, error: 'random-error' }
    expect(() => parsePdfExportResult(input)).toThrow('Invalid PDF export response.')
  })

  it('PRELOAD-PDF-06: Both path and error { canceled: false, path: "D:\\\\x.pdf", error: "destination-busy" } -> throws "Invalid PDF export response."', () => {
    const input = { canceled: false, path: 'D:\\x.pdf', error: 'destination-busy' }
    expect(() => parsePdfExportResult(input)).toThrow('Invalid PDF export response.')
  })

  it('PRELOAD-PDF-07: canceled with path { canceled: true, path: "D:\\\\x.pdf" } -> throws "Invalid PDF export response."', () => {
    const input = { canceled: true, path: 'D:\\x.pdf' }
    expect(() => parsePdfExportResult(input)).toThrow('Invalid PDF export response.')
  })

  it('PRELOAD-PDF-07b: canceled with error { canceled: true, error: "destination-busy" } -> throws "Invalid PDF export response."', () => {
    const input = { canceled: true, error: 'destination-busy' }
    expect(() => parsePdfExportResult(input)).toThrow('Invalid PDF export response.')
  })

  it('PRELOAD-PDF-08: Malformed inputs (null, undefined, [], {}, { canceled: "false" }, empty path) -> throws "Invalid PDF export response."', () => {
    const malformedInputs: unknown[] = [
      null,
      undefined,
      [],
      {},
      { canceled: 'false' },
      { canceled: 'true' },
      { canceled: 1 },
      { canceled: 0 },
      { canceled: false, path: '' },
      { canceled: false, path: 123 },
      { canceled: false, error: null },
      { canceled: false, error: 123 },
      'string',
      12345,
      true,
      false,
    ]

    for (const input of malformedInputs) {
      expect(() => parsePdfExportResult(input)).toThrow('Invalid PDF export response.')
    }
  })

  it('COMPOSITION: Test composition flow from main result { canceled: false, error: "destination-busy" } through parsePdfExportResult to renderer handling', async () => {
    // Simulate IPC invoke resolution from Main process
    const simulateMainProcessIpc = async (): Promise<unknown> => {
      return { canceled: false, error: 'destination-busy' }
    }

    // Preload wrapper execution
    const preloadExportPdf = async (): Promise<WorkbookExportPdfResult> => {
      const rawIpcResult = await simulateMainProcessIpc()
      return parsePdfExportResult(rawIpcResult)
    }

    // Renderer handling logic
    const handleExportPdfInRenderer = async (
      onBusyDialog: () => void,
      onSuccess: (path: string) => void,
      onCanceled: () => void,
    ) => {
      const result = await preloadExportPdf()
      if (result.canceled) {
        onCanceled()
      } else if ('error' in result && result.error === 'destination-busy') {
        onBusyDialog()
      } else if ('path' in result) {
        onSuccess(result.path)
      }
    }

    let busyDialogShown = false
    let successPath = ''
    let wasCanceled = false

    await handleExportPdfInRenderer(
      () => {
        busyDialogShown = true
      },
      (path) => {
        successPath = path
      },
      () => {
        wasCanceled = true
      },
    )

    expect(busyDialogShown).toBe(true)
    expect(successPath).toBe('')
    expect(wasCanceled).toBe(false)
  })
})
