import { existsSync, renameSync, unlinkSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AnnHit, AnnIndex, AnnPreauthorizedPermit, AnnRebuildOptions } from './ann-index'
import { ExactVectorIndex } from './exact-vector-index'
import { estimateAnnIndexBytes } from './runtime/ann-write-budget'

function isValidUsearchHeader(filePath: string): boolean {
  try {
    const stat = statSync(filePath)
    if (stat.size < 64) return false
    const fd = openSync(filePath, 'r')
    try {
      const head = Buffer.alloc(16)
      readSync(fd, head, 0, 16, 0)
      if (head.subarray(0, 7).toString('ascii') === 'usearch') return true

      const rows32 = head.readUInt32LE(0)
      const cols32 = head.readUInt32LE(4)
      const offset32 = 8 + rows32 * cols32
      if (offset32 + 7 <= stat.size) {
        const magicBuf = Buffer.alloc(7)
        readSync(fd, magicBuf, 0, 7, offset32)
        if (magicBuf.toString('ascii') === 'usearch') return true
      }

      const rows64 = Number(head.readBigUInt64LE(0))
      const cols64 = Number(head.readBigUInt64LE(8))
      const offset64 = 16 + rows64 * cols64
      if (offset64 + 7 <= stat.size) {
        const magicBuf = Buffer.alloc(7)
        readSync(fd, magicBuf, 0, 7, offset64)
        if (magicBuf.toString('ascii') === 'usearch') return true
      }

      return false
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

interface USearchNativeIndex {
  dimensions: number
  metric: string
  connectivity?: number
  expansion_add?: number
  expansion_search?: number
  add(key: bigint | number, vector: Float32Array | number[]): void
  search(vector: Float32Array | number[], count: number): {
    keys: BigUint64Array | number[]
    distances: Float32Array | number[]
  }
  remove?(key: bigint | number): void
  save(path: string): void
  load(path: string): void
  view?(path: string): void
  size?(): number
}

interface USearchModule {
  Index: new (options: {
    dimensions: number
    metric: 'cos' | 'ip' | 'l2sq'
    connectivity?: number
    expansion_add?: number
    expansion_search?: number
  }) => USearchNativeIndex
}

let cachedUsearch: USearchModule | null | undefined

function getUsearchModule(): USearchModule | null {
  if (cachedUsearch !== undefined) return cachedUsearch
  try {
    // Dynamic require so packaging without native usearch won't crash Electron
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedUsearch = require('usearch') as USearchModule
  } catch {
    cachedUsearch = null
  }
  return cachedUsearch
}

export interface USearchIndexOptions {
  writePolicy?: 'fail-closed' | 'permissive'
  failClosed?: boolean
  allowUnpermittedWrites?: boolean
  rebuildAdmissionHook?: (
    indexPath: string,
    vectorCount: number,
    dimensions: number,
  ) => Promise<{ admitted: boolean; reason?: string }>
}

export class USearchIndex implements AnnIndex {
  private nativeIndex: USearchNativeIndex | null = null
  private fallbackExact: ExactVectorIndex | null = null
  private state: 'ready' | 'dirty' = 'ready'
  private loadedGeneration = 0
  private isOpen = false
  private activePermit: AnnPreauthorizedPermit | null = null
  private writePolicy: 'fail-closed' | 'permissive'
  private readonly options?: USearchIndexOptions

  readonly dimensions: number
  readonly indexPath: string

  constructor(
    dimensions: number,
    indexPath: string,
    options?: USearchIndexOptions,
  ) {
    this.dimensions = dimensions
    this.indexPath = indexPath
    this.options = options

    if (options?.allowUnpermittedWrites === true || options?.writePolicy === 'permissive') {
      this.writePolicy = 'permissive'
    } else {
      this.writePolicy = 'fail-closed'
    }
  }

  private validatePermit(
    permit: unknown,
    expectedDimensions?: number,
    expectedPath?: string,
    expectedCount?: number,
    expectedGeneration?: number,
  ): permit is AnnPreauthorizedPermit {
    if (!permit || typeof permit !== 'object') return false
    const p = permit as Partial<AnnPreauthorizedPermit>
    if (typeof p.id !== 'string' || p.id.trim().length === 0) return false
    if (typeof p.reservedBytes !== 'number' || !Number.isSafeInteger(p.reservedBytes) || p.reservedBytes <= 0) return false
    if (typeof p.budgetBytes !== 'number' || !Number.isSafeInteger(p.budgetBytes) || p.budgetBytes <= 0) return false
    if (p.measurementValid !== true) return false
    if (typeof p.expiresAt !== 'number' || !Number.isSafeInteger(p.expiresAt) || Date.now() >= p.expiresAt) return false
    if (expectedDimensions !== undefined && p.dimensions !== undefined && p.dimensions !== expectedDimensions) return false
    if (expectedPath !== undefined && p.indexPath !== undefined && p.indexPath !== expectedPath) return false
    if (expectedCount !== undefined && p.vectorCount !== undefined && p.vectorCount !== expectedCount) return false
    if (expectedGeneration !== undefined && p.generation !== undefined && p.generation !== expectedGeneration) return false
    return true
  }

  async open(): Promise<void> {
    if (this.isOpen) return
    const mod = getUsearchModule()
    if (!mod) {
      this.nativeIndex = null
      this.fallbackExact = new ExactVectorIndex()
      await this.fallbackExact.open()
      this.state = 'ready'
      this.isOpen = true
      return
    }

    try {
      this.nativeIndex = new mod.Index({
        dimensions: this.dimensions,
        metric: 'cos',
      })
      if (existsSync(this.indexPath)) {
        if (!isValidUsearchHeader(this.indexPath)) {
          this.nativeIndex = null
          this.fallbackExact = new ExactVectorIndex()
          await this.fallbackExact.open()
          this.state = 'dirty'
          this.isOpen = true
          return
        }
        this.nativeIndex.load(this.indexPath)
      }
      this.state = 'ready'
    } catch {
      this.nativeIndex = null
      this.fallbackExact = new ExactVectorIndex()
      await this.fallbackExact.open()
      this.state = 'dirty'
    }
    this.isOpen = true
  }

  openSync(): void {
    if (this.isOpen) return
    const mod = getUsearchModule()
    if (!mod) {
      this.nativeIndex = null
      this.fallbackExact = new ExactVectorIndex()
      this.state = 'ready'
      this.isOpen = true
      return
    }

    try {
      this.nativeIndex = new mod.Index({
        dimensions: this.dimensions,
        metric: 'cos',
      })
      if (existsSync(this.indexPath)) {
        if (!isValidUsearchHeader(this.indexPath)) {
          this.nativeIndex = null
          this.fallbackExact = new ExactVectorIndex()
          this.state = 'dirty'
          this.isOpen = true
          return
        }
        this.nativeIndex.load(this.indexPath)
      }
      this.state = 'ready'
    } catch {
      this.nativeIndex = null
      this.fallbackExact = new ExactVectorIndex()
      this.state = 'dirty'
    }
    this.isOpen = true
  }

  isAvailable(): boolean {
    if (!this.isOpen) this.openSync()
    return this.nativeIndex !== null
  }

  isHealthy(): boolean {
    return this.state === 'ready'
  }

  getState(): 'ready' | 'dirty' {
    return this.state
  }

  markDirty(): void {
    this.state = 'dirty'
  }

  getLoadedGeneration(): number {
    return this.loadedGeneration
  }

  setLoadedGeneration(gen: number): void {
    this.loadedGeneration = gen
  }

  reloadSync(generation: number): boolean {
    const mod = getUsearchModule()
    if (!mod) {
      this.loadedGeneration = generation
      return false
    }
    try {
      const nextIndex = new mod.Index({
        dimensions: this.dimensions,
        metric: 'cos',
      })
      if (existsSync(this.indexPath)) {
        if (!isValidUsearchHeader(this.indexPath)) {
          this.state = 'dirty'
          return false
        }
        nextIndex.load(this.indexPath)
      }
      this.nativeIndex = nextIndex
      this.loadedGeneration = generation
      this.state = 'ready'
      this.isOpen = true
      return true
    } catch {
      this.state = 'dirty'
      return false
    }
  }

  searchSync(vector: number[], limit: number): AnnHit[] {
    if (!this.isOpen) this.openSync()
    if (this.nativeIndex) {
      if (limit <= 0) return []

      try {
        const results = this.nativeIndex.search(new Float32Array(vector), limit)
        const hits: AnnHit[] = []
        const keys = results.keys
        const distances = results.distances

        for (let i = 0; i < keys.length; i++) {
          const rawKey = keys[i]!
          const key = typeof rawKey === 'bigint' ? Number(rawKey) : Number(rawKey)
          const dist = Number(distances[i] ?? 0)
          hits.push({ chunkId: key, distance: dist })
        }
        return hits
      } catch {
        this.state = 'dirty'
        return []
      }
    }

    if (this.fallbackExact) {
      const entries = Array.from(this.fallbackExact.getAllEntries())
      const scored = entries.map(([chunkId, vec]) => {
        let dot = 0, normA = 0, normB = 0
        for (let i = 0; i < vector.length; i++) {
          const a = vector[i]!, b = vec[i] ?? 0
          dot += a * b; normA += a * a; normB += b * b
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB)
        return { id: chunkId, score: denom ? dot / denom : 0 }
      })
      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, limit).map((h) => ({ chunkId: h.id, distance: 1 - h.score }))
    }

    return []
  }

  addSync(chunkIds: number[], vectors: number[][]): void {
    if (!this.isOpen) this.openSync()
    if (this.fallbackExact) {
      try {
        void this.fallbackExact.add(chunkIds, vectors)
      } catch {
        this.state = 'dirty'
      }
      return
    }

    if (!this.nativeIndex) return

    try {
      for (let i = 0; i < chunkIds.length; i++) {
        const id = chunkIds[i]!
        const vec = vectors[i]
        if (vec) {
          if (vec.length !== this.dimensions) {
            throw new Error(`Vector dimension mismatch: expected ${this.dimensions}, got ${vec.length}`)
          }
          this.nativeIndex.add(id, new Float32Array(vec))
        }
      }
      this.saveAtomic()
    } catch {
      this.state = 'dirty'
    }
  }

  removeSync(chunkIds: number[]): void {
    if (!this.isOpen) this.openSync()
    if (this.fallbackExact) {
      try {
        void this.fallbackExact.remove(chunkIds)
      } catch {
        this.state = 'dirty'
      }
      return
    }

    if (!this.nativeIndex) return

    if (typeof this.nativeIndex.remove !== 'function') {
      this.state = 'dirty'
      return
    }

    try {
      for (const id of chunkIds) {
        this.nativeIndex.remove(id)
      }
      this.saveAtomic()
    } catch {
      this.state = 'dirty'
    }
  }

  async search(vector: number[], limit: number): Promise<AnnHit[]> {
    return this.searchSync(vector, limit)
  }

  async add(chunkIds: number[], vectors: number[][]): Promise<void> {
    if (!this.isOpen) await this.open()
    this.addSync(chunkIds, vectors)
  }

  async remove(chunkIds: number[]): Promise<void> {
    if (!this.isOpen) await this.open()
    this.removeSync(chunkIds)
  }

  async rebuild(): Promise<void> {
    if (this.fallbackExact) {
      await this.fallbackExact.rebuild()
      return
    }
    const mod = getUsearchModule()
    if (mod) {
      try {
        this.nativeIndex = new mod.Index({
          dimensions: this.dimensions,
          metric: 'cos',
        })
        this.state = 'ready'
      } catch {
        this.state = 'dirty'
      }
    }
  }

  preauthorizeSave(permit: AnnPreauthorizedPermit): void {
    this.activePermit = permit
  }

  consumeSavePermit(): AnnPreauthorizedPermit | null {
    const p = this.activePermit
    this.activePermit = null
    return p
  }

  clearSavePermit(): void {
    this.activePermit = null
  }

  setWritePolicy(policy: 'fail-closed' | 'permissive'): void {
    this.writePolicy = policy
  }

  getWritePolicy(): 'fail-closed' | 'permissive' {
    return this.writePolicy
  }

  async rebuildAtomic(
    chunkIds: number[],
    vectors: number[][],
    generation?: number,
    options?: AnnRebuildOptions,
  ): Promise<boolean> {
    if (!this.isOpen) await this.open()
    if (!this.isOpen) {
      this.state = 'dirty'
      this.activePermit = null
      return false
    }

    const mod = getUsearchModule()
    if (!mod) {
      if (this.fallbackExact) {
        await this.fallbackExact.rebuild()
        await this.fallbackExact.add(chunkIds, vectors)
      }
      this.loadedGeneration = generation !== undefined ? generation : this.loadedGeneration + 1
      this.state = 'ready'
      this.activePermit = null
      return true
    }

    let permit: AnnPreauthorizedPermit | null = null
    if (this.writePolicy === 'fail-closed') {
      permit = options?.permit ?? this.activePermit
      this.activePermit = null

      if (!permit || !this.validatePermit(permit, this.dimensions, this.indexPath, chunkIds.length, generation)) {
        this.state = 'dirty'
        return false
      }

      const estBytes = estimateAnnIndexBytes(chunkIds.length, this.dimensions)
      if (estBytes <= 0 || (permit.reservedBytes ?? 0) < estBytes) {
        this.state = 'dirty'
        return false
      }
    } else {
      this.activePermit = null
    }

    // Rebuild admission hook if provided and not prechecked by caller
    if (this.options?.rebuildAdmissionHook && !options?.precheckedAdmission) {
      const admission = await this.options.rebuildAdmissionHook(
        this.indexPath,
        chunkIds.length,
        this.dimensions,
      )
      if (!admission.admitted) {
        this.state = 'dirty'
        return false
      }
    }

    // Recheck lifecycle after potential awaits
    if (!this.isOpen) {
      this.state = 'dirty'
      return false
    }

    const tempPath = `${this.indexPath}.rebuild.tmp`
    try {
      const dir = dirname(this.indexPath)
      if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      const nextIndex = new mod.Index({
        dimensions: this.dimensions,
        metric: 'cos',
      })
      for (let i = 0; i < chunkIds.length; i++) {
        const id = chunkIds[i]!
        const vec = vectors[i]
        if (vec) {
          nextIndex.add(id, new Float32Array(vec))
        }
      }

      // Recheck lifecycle and beforeSaveHook before native.save
      if (!this.isOpen) {
        this.state = 'dirty'
        return false
      }

      if (options?.beforeSaveHook && permit) {
        const ok = await options.beforeSaveHook(tempPath, permit)
        if (!ok || !this.isOpen) {
          this.state = 'dirty'
          return false
        }
      }

      nextIndex.save(tempPath)

      if (!existsSync(tempPath)) {
        this.state = 'dirty'
        return false
      }

      const actualSize = statSync(tempPath).size
      if (actualSize === 0) {
        try {
          unlinkSync(tempPath)
        } catch {}
        this.state = 'dirty'
        return false
      }

      // Check serialized footprint against preauthorized reservation: if exceeds, preserve old index
      if (permit && actualSize > (permit.reservedBytes ?? 0)) {
        try {
          unlinkSync(tempPath)
        } catch {}
        this.state = 'dirty'
        return false
      }

      // Recheck lifecycle and beforeRenameHook before atomic rename
      if (!this.isOpen) {
        try {
          if (existsSync(tempPath)) unlinkSync(tempPath)
        } catch {}
        this.state = 'dirty'
        return false
      }

      if (options?.beforeRenameHook && permit) {
        const ok = await options.beforeRenameHook(tempPath, permit, actualSize)
        if (!ok || !this.isOpen) {
          try {
            if (existsSync(tempPath)) unlinkSync(tempPath)
          } catch {}
          this.state = 'dirty'
          return false
        }
      }

      renameSync(tempPath, this.indexPath)
      this.nativeIndex = nextIndex
      this.loadedGeneration = generation !== undefined ? generation : this.loadedGeneration + 1
      this.state = 'ready'
      return true
    } catch {
      try {
        if (existsSync(tempPath)) {
          unlinkSync(tempPath)
        }
      } catch {}
      this.state = 'dirty'
      return false
    } finally {
      this.activePermit = null
    }
  }

  async close(): Promise<void> {
    if (this.fallbackExact) {
      await this.fallbackExact.close()
      this.fallbackExact = null
    }
    this.nativeIndex = null
    this.activePermit = null
    this.isOpen = false
    this.state = 'ready'
  }

  size(): number {
    if (this.nativeIndex && typeof this.nativeIndex.size === 'function') {
      return this.nativeIndex.size()
    }
    if (this.fallbackExact) {
      return this.fallbackExact.size()
    }
    return 0
  }

  saveAtomic(generation?: number): void {
    if (!this.indexPath || !this.nativeIndex) {
      this.activePermit = null
      return
    }
    if (!this.isOpen) {
      this.state = 'dirty'
      this.activePermit = null
      return
    }

    let permit: AnnPreauthorizedPermit | null = null
    // Fail closed unless explicit permissive policy or valid preauthorized reservation permit
    if (this.writePolicy === 'fail-closed') {
      permit = this.activePermit
      this.activePermit = null

      if (!permit || !this.validatePermit(permit, this.dimensions, this.indexPath, undefined, generation)) {
        // Deny unadmitted physical write, transition to dirty, defer to async authorized rebuild
        this.state = 'dirty'
        return
      }
    } else {
      this.activePermit = null
    }

    const tempPath = `${this.indexPath}.tmp`
    try {
      const dir = dirname(this.indexPath)
      if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      this.nativeIndex.save(tempPath)
      if (!existsSync(tempPath)) {
        this.state = 'dirty'
        return
      }
      const actualSize = statSync(tempPath).size
      if (actualSize === 0) {
        try {
          unlinkSync(tempPath)
        } catch {}
        this.state = 'dirty'
        return
      }
      // Check serialized footprint against preauthorized reservation: if exceeds, preserve old index
      if (permit && actualSize > (permit.reservedBytes ?? 0)) {
        try {
          unlinkSync(tempPath)
        } catch {}
        this.state = 'dirty'
        return
      }
      renameSync(tempPath, this.indexPath)
      if (generation !== undefined) this.loadedGeneration = generation
    } catch {
      this.state = 'dirty'
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath)
      } catch {}
    } finally {
      this.activePermit = null
    }
  }
}
