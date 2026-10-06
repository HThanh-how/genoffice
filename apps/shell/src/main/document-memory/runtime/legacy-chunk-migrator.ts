import type { DocumentMemoryStore } from '../store'
import type { FreshnessCoordinator } from './freshness-coordinator'
import type { ExtractionCoordinator } from './extraction-coordinator'
import type { MaintenanceScheduler } from './maintenance-scheduler'
import type { ChunkUpgradeCoordinator, DocumentNeedingUpgrade } from '../chunk-upgrade'

export interface LegacyChunkMigratorOptions {
  store: DocumentMemoryStore
  freshnessCoord: FreshnessCoordinator
  extractionCoord: ExtractionCoordinator
  maintScheduler: MaintenanceScheduler
  chunkUpgrade: ChunkUpgradeCoordinator
  askExtract: (path: string) => Promise<any>
  enqueue: (path: string, prioritize?: boolean) => void
  currentGeneration: (path: string) => number
  isCurrent: (path: string, generation: number, epoch: number) => boolean
  getEpoch: () => number
  isStoppedOrPaused: () => boolean
}

/**
 * Executes zero-downtime rolling upgrades for legacy V1 documents to Chunker V2.
 * Adheres strictly to Zero Overlap Corruption, Offline Source Retention, and Stale Race Prevention.
 */
export class LegacyChunkMigrator {
  constructor(private readonly options: LegacyChunkMigratorOptions) {}

  async migrate(doc: DocumentNeedingUpgrade, skippedDocs: Set<number>): Promise<boolean> {
    const {
      store,
      freshnessCoord,
      extractionCoord,
      maintScheduler,
      chunkUpgrade,
      askExtract,
      enqueue,
      currentGeneration,
      isCurrent,
      getEpoch,
      isStoppedOrPaused,
    } = this.options

    if (isStoppedOrPaused()) return false

    const meta = await freshnessCoord.statOutcome(doc.path)
    if (meta.kind !== 'file' || (await freshnessCoord.sourceUnavailable(doc.path))) {
      skippedDocs.add(doc.id)
      return false
    }

    const stored = store.documentByPath(doc.path)
    if (!stored) {
      skippedDocs.add(doc.id)
      return false
    }

    if (stored.mtimeMs !== meta.mtimeMs || stored.sizeBytes !== meta.sizeBytes) {
      skippedDocs.add(doc.id)
      enqueue(doc.path, true)
      return false
    }

    const generation = currentGeneration(doc.path)
    const epoch = getEpoch()

    const reply = await askExtract(doc.path)
    if (isStoppedOrPaused() || !isCurrent(doc.path, generation, epoch)) return false

    if (!reply || !('result' in reply) || !reply.result || typeof reply.result !== 'object') {
      if (await freshnessCoord.sourceUnavailable(doc.path)) return false
      skippedDocs.add(doc.id)
      return false
    }

    const extracted = reply.result as any
    const after = await freshnessCoord.statOutcome(doc.path)
    if (after.kind !== 'file' || after.mtimeMs !== extracted.mtimeMs || after.sizeBytes !== extracted.sizeBytes) {
      if (after.kind === 'file') enqueue(doc.path, true)
      return false
    }

    const written = await store.replaceDocumentSliced(
      doc.path,
      {
        hash: extracted.hash,
        mtimeMs: extracted.mtimeMs,
        sizeBytes: extracted.sizeBytes,
        chunks: extracted.chunks ?? [],
        embeddingModel: null,
        status: extracted.status ?? 'ready',
        error: extracted.error,
        truncated: extracted.truncated,
        truncatedReason: extracted.truncatedReason ?? null,
      },
      { shouldContinue: () => isCurrent(doc.path, generation, epoch) },
    )
    if (!written) return false

    const postStat = await freshnessCoord.statOutcome(doc.path)
    if (postStat.kind !== 'file' || postStat.mtimeMs !== extracted.mtimeMs || postStat.sizeBytes !== extracted.sizeBytes) {
      enqueue(doc.path, true)
      return false
    }

    extractionCoord.recordScanInfo(doc.path, extracted)
    maintScheduler.scheduleFtsMaintenance()
    chunkUpgrade.markDocumentUpgraded(doc.id)
    skippedDocs.delete(doc.id)

    if (extracted.chunks?.length && !extracted.skipEmbeddings) {
      enqueue(doc.path, true)
    }

    return true
  }
}
