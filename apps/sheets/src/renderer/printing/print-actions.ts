import type { LazyWorkbookState } from '../univer-state'
import { t } from '../i18n/locale'
import { buildActiveSheetPrintPayload } from './print-payload'
import type { PrintContext, WorkbookFullLoadPurpose } from './types'
import { needsWorkbookFullLoad } from './workbook-full-load'

const inFlightPrintActions = new WeakMap<LazyWorkbookState, Promise<boolean>>()
const inFlightPdfActions = new WeakMap<LazyWorkbookState, Promise<boolean>>()

export async function handlePrint(ctx: PrintContext): Promise<boolean> {
  const state = ctx.lazyWorkbookRef.current
  if (!state) {
    ctx.setMessage(t('appPrintCanceled'))
    return false
  }

  const existing = inFlightPrintActions.get(state)
  if (existing) {
    return existing
  }

  const actionPromise = (async (): Promise<boolean> => {
    try {
      if (needsWorkbookFullLoad(state)) {
        ctx.setMessage(t('appPrintLoadingWorkbook'))
      }
      const result = await buildActiveSheetPrintPayload(ctx, 'print')
      switch (result.status) {
        case 'too-large':
          ctx.setMessage(t('appPrintWorkbookTooLarge'))
          return false
        case 'timeout':
          ctx.setMessage(t('appPrintLoadTimedOut'))
          return false
        case 'stale-workbook':
          ctx.setMessage(t('appPrintCanceled'))
          return false
        case 'active-sheet-unavailable':
          ctx.setMessage(t('appActiveSheetUnavailable'))
          return false
        case 'failed':
          ctx.setMessage(t('appPrintFailed'))
          return false
        case 'ready': {
          ctx.setMessage(t('appPrintPreparing'))
          const printResult = await window.desktopApi.printWorkbook(result.payload)
          if (printResult.ok) {
            ctx.setMessage(t('appPrintSent'))
            return true
          }
          ctx.setMessage(
            printResult.error === undefined ? t('appPrintCanceled') : t('appPrintFailed'),
          )
          return false
        }
      }
    } catch (error: unknown) {
      ctx.setMessage(error instanceof Error ? error.message : t('appPrintFailed'))
      return false
    }
  })()

  inFlightPrintActions.set(state, actionPromise)
  try {
    return await actionPromise
  } finally {
    if (inFlightPrintActions.get(state) === actionPromise) {
      inFlightPrintActions.delete(state)
    }
  }
}

export async function handleExportPdf(ctx: PrintContext, outPath?: string): Promise<boolean> {
  const state = ctx.lazyWorkbookRef.current
  if (!state) {
    ctx.setMessage(t('appPdfCanceled'))
    return false
  }

  const existing = inFlightPdfActions.get(state)
  if (existing) {
    return existing
  }

  const purpose: WorkbookFullLoadPurpose = outPath === undefined ? 'pdf-export' : 'headless-export'

  const actionPromise = (async (): Promise<boolean> => {
    try {
      if (needsWorkbookFullLoad(state)) {
        ctx.setMessage(t('appPdfLoadingWorkbook'))
      }
      const result = await buildActiveSheetPrintPayload(ctx, purpose)
      switch (result.status) {
        case 'too-large':
          ctx.setMessage(t('appPdfWorkbookTooLarge'))
          return false
        case 'timeout':
          ctx.setMessage(t('appPdfLoadTimedOut'))
          return false
        case 'stale-workbook':
          ctx.setMessage(t('appPdfCanceled'))
          return false
        case 'active-sheet-unavailable':
          ctx.setMessage(t('appActiveSheetUnavailable'))
          return false
        case 'failed':
          ctx.setMessage(t('appPdfExportFailed'))
          return false
        case 'ready': {
          ctx.setMessage(t('appPdfRendering'))
          const exportResult = await window.desktopApi.exportPdf({
            ...result.payload,
            ...(outPath !== undefined ? { outPath } : {}),
          })
          if (exportResult.canceled) {
            ctx.setMessage(t('appPdfCanceled'))
            return false
          }
          ctx.setMessage(t('appPdfExported', { path: exportResult.path }))
          return true
        }
      }
    } catch (error: unknown) {
      ctx.setMessage(error instanceof Error ? error.message : t('appPdfExportFailed'))
      return false
    }
  })()

  inFlightPdfActions.set(state, actionPromise)
  try {
    return await actionPromise
  } finally {
    if (inFlightPdfActions.get(state) === actionPromise) {
      inFlightPdfActions.delete(state)
    }
  }
}
