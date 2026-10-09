export const ANN_MIN_VECTORS = 20_000

export interface AnnHit {
  chunkId: number
  distance: number
}

export interface AnnPreauthorizedPermit {
  id?: string
  ownerToken?: string
  expiresAt?: number
  reservedBytes?: number
  measurementValid?: boolean
  budgetBytes?: number
  dimensions?: number
  vectorCount?: number
  generation?: number
  indexPath?: string
  configVersion?: number
}

export interface AnnRebuildOptions {
  precheckedAdmission?: boolean
  permit?: AnnPreauthorizedPermit
  beforeSaveHook?: (tempPath: string, permit: AnnPreauthorizedPermit) => Promise<boolean> | boolean
  beforeRenameHook?: (tempPath: string, permit: AnnPreauthorizedPermit, actualBytes: number) => Promise<boolean> | boolean
}

export interface AnnIndex {
  open(): Promise<void>
  search(vector: number[], limit: number): Promise<AnnHit[]>
  add(chunkIds: number[], vectors: number[][]): Promise<void>
  remove(chunkIds: number[]): Promise<void>
  rebuild(): Promise<void>
  close(): Promise<void>
  getLoadedGeneration?(): number
  setLoadedGeneration?(gen: number): void
  reloadSync?(generation: number): boolean
  isHealthy?(): boolean
  isAvailable?(): boolean
  searchSync?(vector: number[], limit: number): AnnHit[]
  addSync?(chunkIds: number[], vectors: number[][]): void
  removeSync?(chunkIds: number[]): void
  rebuildAtomic?(
    chunkIds: number[],
    vectors: number[][],
    generation?: number,
    options?: AnnRebuildOptions,
  ): Promise<boolean>
  getState?(): 'ready' | 'dirty'
  saveAtomic?(generation?: number): void
  markDirty?(): void
  size?(): number
  preauthorizeSave?(permit: AnnPreauthorizedPermit): void
  consumeSavePermit?(): AnnPreauthorizedPermit | null
  clearSavePermit?(): void
  setWritePolicy?(policy: 'fail-closed' | 'permissive'): void
  getWritePolicy?(): 'fail-closed' | 'permissive'
}

/**
 * Rigorously validates an AnnPreauthorizedPermit against live and structural parameters.
 * Rejects empty objects {}, expired tokens, budget/config version mismatches, and negative/overflow sizes.
 */
export function validateAnnPreauthorizedPermit(
  permit: unknown,
  expectedDimensions?: number,
  expectedIndexPath?: string,
  expectedVectorCount?: number,
  expectedGeneration?: number,
  liveConfigVersion?: number,
  liveBudgetBytes?: number,
): permit is AnnPreauthorizedPermit {
  if (!permit || typeof permit !== 'object') return false
  const p = permit as Partial<AnnPreauthorizedPermit>
  if (typeof p.id !== 'string' || !p.id.trim()) return false
  if (typeof p.ownerToken !== 'string' || !p.ownerToken.trim()) return false
  if (typeof p.expiresAt !== 'number' || !Number.isFinite(p.expiresAt) || p.expiresAt <= Date.now()) return false
  if (p.measurementValid !== true) return false
  if (typeof p.reservedBytes !== 'number' || !Number.isSafeInteger(p.reservedBytes) || p.reservedBytes <= 0) return false
  if (typeof p.budgetBytes !== 'number' || !Number.isSafeInteger(p.budgetBytes) || p.budgetBytes <= 0) return false
  if (liveBudgetBytes !== undefined && p.budgetBytes !== liveBudgetBytes) return false
  if (liveConfigVersion !== undefined) {
    if (
      typeof p.configVersion !== 'number' ||
      !Number.isSafeInteger(p.configVersion) ||
      p.configVersion < 0 ||
      p.configVersion !== liveConfigVersion
    ) {
      return false
    }
  }
  if (expectedGeneration !== undefined && p.generation !== expectedGeneration) return false
  if (expectedDimensions !== undefined && p.dimensions !== expectedDimensions) return false
  if (expectedIndexPath && p.indexPath && p.indexPath !== expectedIndexPath) return false
  if (expectedVectorCount !== undefined && typeof p.vectorCount === 'number' && p.vectorCount < expectedVectorCount) return false
  return true
}
