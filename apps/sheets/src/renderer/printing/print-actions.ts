import type { LazyWorkbookState } from '../univer-state'
import { t } from '../i18n/locale'
import { buildActiveSheetPrintPayload } from './print-payload'
import type { PrintContext, WorkbookFullLoadPurpose } from './types'
import { needsWorkbookFullLoad } from './workbook-full-load'

const inFlightPrintActions = new WeakMap<LazyWorkbookState, Promise<boolean>>()
let inFlightPrintActionNullState: Promise<boolean> | null = null

let inFlightPdfDialog: Promise<boolean> | null = null
const inFlightHeadlessExports = new Map<string, Promise<boolean>>()

export function pdfExportPurpose(outPath?: string): WorkbookFullLoadPurpose {
  return outPath === undefined ? 'pdf-export' : 'headless-export'
}

export async function handlePrint(ctx: PrintContext): Promise<boolean> {
  const state = ctx.lazyWorkbookRef.current
  const existing = state !== null ? inFlightPrintActions.get(state) : inFlightPrintActionNullState
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

  if (state !== null) {
    inFlightPrintActions.set(state, actionPromise)
  } else {
    inFlightPrintActionNullState = actionPromise
  }

  try {
    return await actionPromise
  } finally {
    if (state !== null) {
      if (inFlightPrintActions.get(state) === actionPromise) {
        inFlightPrintActions.delete(state)
      }
    } else {
      if (inFlightPrintActionNullState === actionPromise) {
        inFlightPrintActionNullState = null
      }
    }
  }
}

export async function handleExportPdf(ctx: PrintContext, outPath?: string): Promise<boolean> {
  const state = ctx.lazyWorkbookRef.current
  const normalizedPath = outPath !== undefined ? outPath.trim().toLowerCase() : undefined

  if (outPath === undefined) {
    if (inFlightPdfDialog) {
      return inFlightPdfDialog
    }
  } else {
    const existing = inFlightHeadlessExports.get(normalizedPath!)
    if (existing) {
      return existing
    }
  }

  const purpose = pdfExportPurpose(outPath)

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

  if (outPath === undefined) {
    inFlightPdfDialog = actionPromise
  } else {
    inFlightHeadlessExports.set(normalizedPath!, actionPromise)
  }

  try {
    return await actionPromise
  } finally {
    if (outPath === undefined) {
      if (inFlightPdfDialog === actionPromise) {
        inFlightPdfDialog = null
      }
    } else {
      if (inFlightHeadlessExports.get(normalizedPath!) === actionPromise) {
        inFlightHeadlessExports.delete(normalizedPath!)
      }
    }
  }
}
