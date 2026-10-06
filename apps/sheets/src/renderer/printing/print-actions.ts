import { t } from '../i18n/locale'
import { buildActiveSheetPrintPayload } from './print-payload'
import type { PrintContext, WorkbookFullLoadPurpose } from './types'
import { needsWorkbookFullLoad } from './workbook-full-load'

export type PrintTargetToken = object

export function printTarget(ctx: PrintContext): PrintTargetToken | null {
  const workbook = ctx.univerRef.current?.univerAPI.getActiveWorkbook()
  return (
    (workbook?.getWorkbook?.() as PrintTargetToken | undefined) ??
    (workbook as unknown as PrintTargetToken | undefined) ??
    null
  )
}

const inFlightPrint = new WeakMap<PrintTargetToken, Promise<boolean>>()
const inFlightPdfForTarget = new WeakMap<PrintTargetToken, Promise<boolean>>()
let activePdfDialogTarget: PrintTargetToken | null = null
const inFlightHeadless = new WeakMap<PrintTargetToken, Map<string, Promise<boolean>>>()

export function pdfExportPurpose(outPath?: string): WorkbookFullLoadPurpose {
  return outPath === undefined ? 'pdf-export' : 'headless-export'
}

export async function handlePrint(ctx: PrintContext): Promise<boolean> {
  const target = printTarget(ctx)
  if (!target) {
    ctx.setMessage(t('appActiveSheetUnavailable'))
    return false
  }

  const existing = inFlightPrint.get(target)
  if (existing) {
    return existing
  }

  const state = ctx.lazyWorkbookRef.current

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

  inFlightPrint.set(target, actionPromise)

  try {
    return await actionPromise
  } finally {
    if (inFlightPrint.get(target) === actionPromise) {
      inFlightPrint.delete(target)
    }
  }
}

export async function handleExportPdf(ctx: PrintContext, outPath?: string): Promise<boolean> {
  if (outPath !== undefined && outPath.trim().length === 0) {
    return false
  }

  const target = printTarget(ctx)
  if (!target) {
    ctx.setMessage(t('appActiveSheetUnavailable'))
    return false
  }

  const pathKey = outPath !== undefined ? outPath.trim() : undefined
  let targetMap: Map<string, Promise<boolean>> | undefined

  if (outPath === undefined) {
    const existing = inFlightPdfForTarget.get(target)
    if (existing) {
      return existing
    }
    if (activePdfDialogTarget !== null && activePdfDialogTarget !== target) {
      ctx.setMessage(t('appPdfExportFailed'))
      return false
    }
  } else {
    targetMap = inFlightHeadless.get(target)
    if (!targetMap) {
      targetMap = new Map()
      inFlightHeadless.set(target, targetMap)
    }
    const existing = targetMap.get(pathKey!)
    if (existing) {
      return existing
    }
  }

  const state = ctx.lazyWorkbookRef.current
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
    inFlightPdfForTarget.set(target, actionPromise)
    activePdfDialogTarget = target
  } else {
    targetMap!.set(pathKey!, actionPromise)
  }

  try {
    return await actionPromise
  } finally {
    if (outPath === undefined) {
      if (inFlightPdfForTarget.get(target) === actionPromise) {
        inFlightPdfForTarget.delete(target)
      }
      if (activePdfDialogTarget === target) {
        activePdfDialogTarget = null
      }
    } else {
      const currentTargetMap = inFlightHeadless.get(target)
      if (currentTargetMap?.get(pathKey!) === actionPromise) {
        currentTargetMap.delete(pathKey!)
      }
    }
  }
}
