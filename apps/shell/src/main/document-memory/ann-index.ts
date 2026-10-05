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
}
