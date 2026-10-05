export const ANN_MIN_VECTORS = 20_000

export interface AnnHit {
  chunkId: number
  distance: number
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
  rebuildAtomic?(chunkIds: number[], vectors: number[][], generation?: number): Promise<boolean>
  getState?(): 'ready' | 'dirty'
  saveAtomic?(generation?: number): void
  markDirty?(): void
  size?(): number
}
