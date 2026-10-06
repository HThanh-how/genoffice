import { isMetafileMime, metafileToDataUrl } from '@genoffice/docx-engine/metafile'
import type { WorkbookExportPdfRequest } from '../../shared/desktop-api'
import { FULL_LOAD_MAX_CELLS } from '../app-constants'
import type { PageLayoutContext } from '../page-layout-actions'
import {
  buildSheetPrintPayload,
  type HeaderFooterPictureImage,
  type PrintWorksheet,
} from '../print-html'
import { resolveEffectivePageSetup, type HeaderFooterPictureSlot } from '../print-settings'
import { settleVisualNodes, snapshotPrintVisuals } from '../print-visuals'
import type { LazyWorkbookState } from '../univer-state'
import { installedVisualFrames, type InstalledVisualFrame } from '../WorkbookVisuals'
import type { WorkbookFullLoadPurpose, WorkbookFullLoadResult } from './types'
import { DEFAULT_FULL_LOAD_TIMEOUT_MS, ensureWorkbookFullyLoaded } from './workbook-full-load'

export async function buildActiveSheetPrintPayload(
  ctx: PageLayoutContext,
  purpose: WorkbookFullLoadPurpose = 'print',
): Promise<{
  status: WorkbookFullLoadResult['status']
  payload?: WorkbookExportPdfRequest
  totalCells?: number
  error?: unknown
}> {
  const state = ctx.lazyWorkbookRef.current
  if (state) {
    const loadResult = await ensureWorkbookFullyLoaded(ctx, state, {
      purpose,
      maxCells: FULL_LOAD_MAX_CELLS,
      timeoutMs: DEFAULT_FULL_LOAD_TIMEOUT_MS,
    })
    if (loadResult.status !== 'ready') {
      return loadResult
    }
    if (ctx.lazyWorkbookRef.current !== state) {
      return { status: 'stale-workbook' }
    }
  }

  const runtime = ctx.univerRef.current
  const workbook = runtime?.univerAPI.getActiveWorkbook()
  const worksheet = workbook?.getActiveSheet()
  if (!runtime || !worksheet) {
    return { status: 'failed', error: new Error('Active sheet unavailable') }
  }

  const freshState = ctx.lazyWorkbookRef.current
  const sheetId = worksheet.getSheetId()
  const journal = freshState?.editJournal.pageSetup.get(sheetId) ?? {}
  const fileSetup = freshState?.sheetFilePageSetups.get(sheetId) ?? null
  const fileSheet = freshState?.file.sheets.find((sheet) => sheet.id === sheetId)
  const setup = resolveEffectivePageSetup(
    journal,
    fileSetup,
    {
      ...(fileSheet?.printArea === undefined ? {} : { printArea: fileSheet.printArea }),
      ...(fileSheet?.printTitles === undefined ? {} : { printTitles: fileSheet.printTitles }),
    },
    freshState?.editJournal.structuralOps.get(sheetId) ?? [],
  )
  const baseName = (freshState?.file.name ?? 'Book1').replace(/\.[^.]+$/, '')
  const pictures = freshState
    ? await loadHeaderFooterPictures(freshState.file.sessionId, setup.headerFooterPictures)
    : new Map<string, HeaderFooterPictureImage>()
  const frames = await settledVisualFrames(ctx, freshState, sheetId)
  const payload = buildSheetPrintPayload(
    worksheet as unknown as PrintWorksheet,
    setup,
    `${baseName}.pdf`,
    worksheet.getSheetName(),
    pictures,
    snapshotPrintVisuals(document, frames),
  )
  return { status: 'ready', payload }
}

async function settledVisualFrames(
  ctx: PageLayoutContext,
  state: LazyWorkbookState | null,
  sheetId: string,
): Promise<readonly InstalledVisualFrame[]> {
  const expected = state
    ? [...state.file.visuals, ...state.editJournal.visualAdds].filter(
        (visual) =>
          visual.sheetId === sheetId && !state.editJournal.visualEdits.get(visual.id)?.remove,
      ).length
    : 0
  if (expected === 0) return []
  if (installedVisualFrames(sheetId).length < expected) {
    ctx.requestVisualInstall?.()
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && installedVisualFrames(sheetId).length < expected) {
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
  }
  const frames = installedVisualFrames(sheetId)
  await settleVisualNodes(document, frames)
  return frames
}

async function loadHeaderFooterPictures(
  sessionId: string,
  slots: readonly HeaderFooterPictureSlot[],
): Promise<Map<string, HeaderFooterPictureImage>> {
  const pictures = new Map<string, HeaderFooterPictureImage>()
  await Promise.all(
    slots.map(async (slot) => {
      try {
        const media = await window.desktopApi.readWorkbookMedia({ sessionId, visualId: slot.id })
        const dataUrl = isMetafileMime(media.mediaType)
          ? await metafileToDataUrl(base64ToBytes(media.base64), media.mediaType)
          : `data:${media.mediaType};base64,${media.base64}`
        if (dataUrl) {
          pictures.set(slot.position, { dataUrl, widthPt: slot.widthPt, heightPt: slot.heightPt })
        }
      } catch (reason: unknown) {
        console.warn(`header/footer picture unavailable (${slot.position})`, reason)
      }
    }),
  )
  return pictures
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
