import { isMetafileMime, metafileToDataUrl } from '@genoffice/docx-engine/metafile'
import { FULL_LOAD_MAX_CELLS } from '../app-constants'
import {
  buildSheetPrintPayload,
  type HeaderFooterPictureImage,
  type PrintWorksheet,
} from '../print-html'
import { resolveEffectivePageSetup, type HeaderFooterPictureSlot } from '../print-settings'
import { settleVisualNodes, snapshotPrintVisuals } from '../print-visuals'
import type { LazyWorkbookState } from '../univer-state'
import { installedVisualFrames, type InstalledVisualFrame } from '../WorkbookVisuals'
import type { PrintContext, PrintPayloadResult, WorkbookFullLoadPurpose } from './types'
import { DEFAULT_FULL_LOAD_TIMEOUT_MS, ensureWorkbookFullyLoaded } from './workbook-full-load'

function isPrintTargetCurrent(
  ctx: PrintContext,
  expectedState: LazyWorkbookState | null,
  expectedSheetId: string,
): boolean {
  if (ctx.lazyWorkbookRef.current !== expectedState) {
    return false
  }
  const currentSheetId = ctx.univerRef.current?.univerAPI
    .getActiveWorkbook()
    ?.getActiveSheet()
    ?.getSheetId()
  return currentSheetId === expectedSheetId
}

export async function buildActiveSheetPrintPayload(
  ctx: PrintContext,
  purpose: WorkbookFullLoadPurpose = 'print',
): Promise<PrintPayloadResult> {
  const expectedState = ctx.lazyWorkbookRef.current
  if (expectedState) {
    const loadResult = await ensureWorkbookFullyLoaded(ctx, expectedState, {
      purpose,
      maxCells: FULL_LOAD_MAX_CELLS,
      timeoutMs: DEFAULT_FULL_LOAD_TIMEOUT_MS,
    })
    if (loadResult.status !== 'ready') {
      return loadResult
    }
    if (ctx.lazyWorkbookRef.current !== expectedState) {
      return { status: 'stale-workbook' }
    }
  }

  const runtime = ctx.univerRef.current
  const workbook = runtime?.univerAPI.getActiveWorkbook()
  const worksheet = workbook?.getActiveSheet()
  if (!runtime || !worksheet) {
    return { status: 'active-sheet-unavailable' }
  }

  const expectedSheetId = worksheet.getSheetId()
  const journal = expectedState?.editJournal.pageSetup.get(expectedSheetId) ?? {}
  const fileSetup = expectedState?.sheetFilePageSetups.get(expectedSheetId) ?? null
  const fileSheet = expectedState?.file.sheets.find((sheet) => sheet.id === expectedSheetId)
  const setup = resolveEffectivePageSetup(
    journal,
    fileSetup,
    {
      ...(fileSheet?.printArea === undefined ? {} : { printArea: fileSheet.printArea }),
      ...(fileSheet?.printTitles === undefined ? {} : { printTitles: fileSheet.printTitles }),
    },
    expectedState?.editJournal.structuralOps.get(expectedSheetId) ?? [],
  )
  const baseName = (expectedState?.file.name ?? 'Book1').replace(/\.[^.]+$/, '')
  const pictures = expectedState?.file.sessionId
    ? await loadHeaderFooterPictures(expectedState.file.sessionId, setup.headerFooterPictures)
    : new Map<string, HeaderFooterPictureImage>()

  if (!isPrintTargetCurrent(ctx, expectedState, expectedSheetId)) {
    return { status: 'stale-workbook' }
  }

  const framesResult = await settledVisualFrames(ctx, expectedState, expectedSheetId)

  if (!isPrintTargetCurrent(ctx, expectedState, expectedSheetId)) {
    return { status: 'stale-workbook' }
  }

  if (ctx.lazyWorkbookRef.current !== expectedState) {
    return { status: 'stale-workbook' }
  }

  const payload = buildSheetPrintPayload(
    worksheet as unknown as PrintWorksheet,
    setup,
    `${baseName}.pdf`,
    worksheet.getSheetName(),
    pictures,
    snapshotPrintVisuals(document, framesResult),
  )
  return { status: 'ready', payload }
}

async function settledVisualFrames(
  ctx: PrintContext,
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
