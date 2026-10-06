import type { PageLayoutContext } from '../page-layout-actions'
import { t } from '../i18n/locale'
import { buildActiveSheetPrintPayload } from './print-payload'
import { needsWorkbookFullLoad } from './workbook-full-load'

export async function handlePrint(ctx: PageLayoutContext): Promise<boolean> {
  try {
    if (needsWorkbookFullLoad(ctx.lazyWorkbookRef.current)) {
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
      case 'failed':
        ctx.setMessage(t('appPrintFailed'))
        return false
      case 'stale-workbook':
        return false
      case 'ready': {
        if (!result.payload) {
          ctx.setMessage(t('appPrintFailed'))
          return false
        }
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
}

export async function handleExportPdf(ctx: PageLayoutContext, outPath?: string): Promise<boolean> {
  try {
    if (needsWorkbookFullLoad(ctx.lazyWorkbookRef.current)) {
      ctx.setMessage(t('appPdfLoadingWorkbook'))
    }
    const result = await buildActiveSheetPrintPayload(ctx, 'pdf-export')
    switch (result.status) {
      case 'too-large':
        ctx.setMessage(t('appPdfWorkbookTooLarge'))
        return false
      case 'timeout':
        ctx.setMessage(t('appPdfLoadTimedOut'))
        return false
      case 'failed':
        ctx.setMessage(t('appPdfExportFailed'))
        return false
      case 'stale-workbook':
        return false
      case 'ready': {
        if (!result.payload) {
          ctx.setMessage(t('appPdfExportFailed'))
          return false
        }
        ctx.setMessage(t('appPdfRendering'))
        const exportResult = await window.desktopApi.exportPdf({
          ...result.payload,
          ...(outPath ? { outPath } : {}),
        })
        ctx.setMessage(
          exportResult.canceled
            ? t('appPdfCanceled')
            : t('appPdfExported', { path: exportResult.path }),
        )
        return !exportResult.canceled
      }
    }
  } catch (error: unknown) {
    ctx.setMessage(error instanceof Error ? error.message : t('appPdfExportFailed'))
    return false
  }
}
