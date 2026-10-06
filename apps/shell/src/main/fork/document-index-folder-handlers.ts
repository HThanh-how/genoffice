import type { IpcMain } from 'electron'
import { availableParallelism, totalmem } from 'node:os'
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
import { DEFAULT_PDF_PAGES, LARGE_PDF_PAGES } from '../document-memory/chunks'
import {
  isKnownSearchSource,
  type KnownSearchSourceEntry,
} from '../document-memory/known-sources'
import type { DocumentIndexIpcDeps } from './document-index-ipc'

export function registerFolderAndModelHandlers(
  deps: DocumentIndexIpcDeps,
  invalidateCounts: () => void,
): void {
  const { ipcMain, getDocumentMemory, getFolderScan } = deps

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
    if (!isKnownSearchSource(id) || typeof enabled !== 'boolean') throw new Error('Invalid known search source id')
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
    return {
      profile: getDocumentMemory()?.embeddingSettings().profile ?? 'standard',
      recommended: advice.profile,
      ...(advice.limit ? { limit: advice.limit } : {}),
      machine,
      profiles: { standard: info('standard'), high: info('high') },
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
  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.getPdfPages, () => pdfPagesState(getDocumentMemory()?.getPdfMaxPages() ?? DEFAULT_PDF_PAGES))
  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.setPdfPages, (_event, pages: unknown) => {
    if (typeof pages !== 'number' || !Number.isFinite(pages)) throw new Error('Invalid page count')
    const memory = getDocumentMemory()
    if (!memory) return { ...pdfPagesState(DEFAULT_PDF_PAGES), requeued: 0 }
    const res = memory.setPdfMaxPages(pages)
    invalidateCounts()
    return { ...pdfPagesState(res), requeued: res }
  })
}
