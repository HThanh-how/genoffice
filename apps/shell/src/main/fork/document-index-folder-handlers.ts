import { availableParallelism, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import {
  DOCUMENT_INDEX_CHANNELS,
  type EmbeddingModelState,
  type IndexedFolder,
  type PdfPagesState,
} from '../../shared/fork/document-index-api'
import {
  EMBEDDING_PROFILES,
  isEmbeddingProfileId,
  recommendEmbeddingProfile,
  type EmbeddingProfileId,
} from '../document-memory/embedding-profiles'
import { clampPdfPages, DEFAULT_PDF_PAGES, LARGE_PDF_PAGES } from '../document-memory/chunks'
import { readPdfPages, writePdfPages } from '../document-memory/pdf-pages'
import {
  isKnownSearchSource,
  type KnownSearchSourceEntry,
} from '../document-memory/known-sources'
import type { DocumentIndexIpcDeps } from './document-index-ipc'

function resolvePdfPagesPath(deps: DocumentIndexIpcDeps): string {
  if (deps.settingsPath) {
    const sPath = typeof deps.settingsPath === 'function' ? deps.settingsPath() : deps.settingsPath
    const dir = sPath.endsWith('.json') ? dirname(sPath) : sPath
    return join(dir, 'document-memory-pdf.json')
  }
  return join(dirname(deps.dbPath()), 'document-memory-pdf.json')
}

export function registerFolderAndModelHandlers(
  deps: DocumentIndexIpcDeps,
  invalidateCounts: () => void,
): void {
  const { ipcMain, getDocumentMemory, getFolderScan } = deps
  const pdfConfigFile = resolvePdfPagesPath(deps)
  let synced = false

  const syncMemoryPdfPages = () => {
    const memory = getDocumentMemory()
    if (memory && typeof memory.setPdfMaxPages === 'function' && !synced) {
      const persisted = readPdfPages(pdfConfigFile)
      memory.setPdfMaxPages(persisted)
      synced = true
    }
  }

  syncMemoryPdfPages()

  const knownRoot = (root: unknown): string => {
    if (typeof root !== 'string' || !getFolderScan()?.folders().some((f) => f.root === root)) {
      throw new Error('Unknown folder')
    }
    return root
  }

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.listIndexedFolders, async (): Promise<IndexedFolder[]> => {
    const scan = getFolderScan()
    const memory = getDocumentMemory()
    if (!scan) return []
    return scan.folders().map((folder) => {
      const counts = memory?.getFolderIndexCounts(folder.root)
      return {
        ...folder,
        unavailable: false,
        totalFiles: counts?.totalFiles ?? 0,
        readyFiles: counts?.readyFiles ?? 0,
        pendingFiles: counts?.pendingFiles ?? 0,
        waitingFiles: counts?.waitingFiles ?? counts?.pendingFiles ?? 0,
        releasedFiles: counts?.releasedFiles ?? 0,
        errorFiles: counts?.errorFiles ?? 0,
        emptyFiles: counts?.emptyFiles ?? 0,
        completedChunks: counts?.completedChunks ?? 0,
        totalChunks: counts?.totalChunks ?? 0,
      }
    })
  })

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.setIndexedFolderPriority, (_event, root: unknown, priority: unknown) => {
    if (typeof priority !== 'boolean') return false
    const res = getFolderScan()?.setPriority(knownRoot(root), priority) ?? false
    invalidateCounts()
    return res
  })

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.rescanIndexedFolder, async (_event, root: unknown) => {
    const scan = getFolderScan()
    if (!scan) return { ok: false, error: 'unavailable' }
    const res = await scan.rescanExisting(knownRoot(root))
    invalidateCounts()
    return res
  })

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.forgetIndexedFolder, async (_event, root: unknown) => {
    const scan = getFolderScan()
    if (!scan) return false
    return scan.unregisterRoot(knownRoot(root), 'manual')
  })

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.getKnownSearchSources, async (): Promise<KnownSearchSourceEntry[]> => {
    return deps.getKnownSources?.()?.getKnownSearchSources() ?? []
  })

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.setKnownSearchSource, async (_event, id: unknown, enabled: unknown) => {
    if (!isKnownSearchSource(id)) throw new Error('Invalid known search source id')
    if (typeof enabled !== 'boolean') throw new Error('Invalid enabled state')
    const res = await deps.getKnownSources?.()?.setKnownSearchSource(id, enabled)
    invalidateCounts()
    return res!
  })

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.getEmbeddingModel, (): EmbeddingModelState => {
    const machine = { totalMemGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10, logicalCores: availableParallelism() }
    const advice = recommendEmbeddingProfile({ ...machine, arch: process.arch, platform: process.platform })
    const info = (id: EmbeddingProfileId) => {
      const p = EMBEDDING_PROFILES[id]
      return { name: p.repo, embeddingId: p.embeddingId, dimensions: p.dimensions, downloadMB: p.downloadMB, memoryMB: p.memoryMB }
    }
    const memory = getDocumentMemory()
    return {
      profile: memory?.embeddingSettings().profile ?? 'standard',
      recommended: advice.profile,
      ...(advice.limit ? { limit: advice.limit } : {}),
      ...(typeof memory?.embeddingModelCached === 'function' ? { modelCached: memory.embeddingModelCached() } : {}),
      machine,
      profiles: Object.fromEntries(
        (Object.keys(EMBEDDING_PROFILES) as EmbeddingProfileId[]).map((id) => [id, info(id)]),
      ) as EmbeddingModelState['profiles'],
    }
  })

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.setEmbeddingModel, (_event, profile: unknown) => {
    if (!isEmbeddingProfileId(profile)) throw new Error('Invalid search model')
    const memory = getDocumentMemory()
    if (!memory) return { ok: false, requeued: 0 }
    const res = memory.setEmbeddingProfile(profile)
    invalidateCounts()
    return res
  })

  const pdfPagesState = (pages: number): PdfPagesState => ({ pages, default: DEFAULT_PDF_PAGES, max: LARGE_PDF_PAGES })

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.getPdfPages, (): PdfPagesState => {
    syncMemoryPdfPages()
    const memory = getDocumentMemory()
    const pages = memory ? memory.getPdfMaxPages() : readPdfPages(pdfConfigFile)
    return pdfPagesState(pages)
  })

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.setPdfPages, (_event, rawPages: unknown) => {
    if (typeof rawPages !== 'number' || !Number.isFinite(rawPages)) throw new Error('Invalid page count')
    const pages = clampPdfPages(rawPages)
    writePdfPages(pdfConfigFile, pages)
    const memory = getDocumentMemory()
    let requeued = 0
    let activePages = pages
    if (memory) {
      const res = memory.setPdfMaxPages(pages)
      if (typeof res === 'number') {
        requeued = res
      } else if (typeof res === 'object' && res !== null) {
        if (typeof res.requeued === 'number') requeued = res.requeued
        if (typeof res.pages === 'number') activePages = res.pages
      }
      synced = true
      invalidateCounts()
    }
    return { ...pdfPagesState(activePages), requeued }
  })
}
