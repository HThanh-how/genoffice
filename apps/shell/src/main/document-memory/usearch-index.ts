import { existsSync, renameSync, unlinkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AnnHit, AnnIndex } from './ann-index'
import { ExactVectorIndex } from './exact-vector-index'

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

export class USearchIndex implements AnnIndex {
  private nativeIndex: USearchNativeIndex | null = null
  private fallbackExact: ExactVectorIndex | null = null
  private isOpen = false

  constructor(
    private readonly dimensions: number,
    private readonly indexPath: string,
  ) {}

  async open(): Promise<void> {
    if (this.isOpen) return
    const mod = getUsearchModule()
    if (!mod) {
      this.fallbackExact = new ExactVectorIndex()
      const fallbackFile = `${this.indexPath}.fallback.json`
      if (existsSync(fallbackFile)) {
        try {
          const raw = readFileSync(fallbackFile, 'utf-8')
          const entries = JSON.parse(raw) as Array<[number, number[]]>
          await this.fallbackExact.add(
            entries.map((e) => e[0]),
            entries.map((e) => e[1]),
          )
        } catch {
          // ignore corrupt fallback cache
        }
      }
      await this.fallbackExact.open()
      this.isOpen = true
      return
    }

    try {
      this.nativeIndex = new mod.Index({
        dimensions: this.dimensions,
        metric: 'cos',
      })
      if (existsSync(this.indexPath)) {
        this.nativeIndex.load(this.indexPath)
      }
    } catch {
      this.nativeIndex = null
      this.fallbackExact = new ExactVectorIndex()
      await this.fallbackExact.open()
    }
    this.isOpen = true
  }

  async search(vector: number[], limit: number): Promise<AnnHit[]> {
    if (!this.isOpen) await this.open()
    if (this.fallbackExact) {
      return this.fallbackExact.search(vector, limit)
    }

    if (!this.nativeIndex || limit <= 0) return []

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
      if (!this.fallbackExact) {
        this.fallbackExact = new ExactVectorIndex()
        await this.fallbackExact.open()
      }
      return this.fallbackExact.search(vector, limit)
    }
  }

  async add(chunkIds: number[], vectors: number[][]): Promise<void> {
    if (!this.isOpen) await this.open()
    if (this.fallbackExact) {
      await this.fallbackExact.add(chunkIds, vectors)
      this.saveAtomic()
      return
    }

    if (!this.nativeIndex) return

    try {
      for (let i = 0; i < chunkIds.length; i++) {
        const id = chunkIds[i]!
        const vec = vectors[i]
        if (vec) {
          this.nativeIndex.add(id, new Float32Array(vec))
        }
      }
      this.saveAtomic()
    } catch {
      if (!this.fallbackExact) {
        this.fallbackExact = new ExactVectorIndex()
        await this.fallbackExact.open()
      }
      await this.fallbackExact.add(chunkIds, vectors)
      this.saveAtomic()
    }
  }

  async remove(chunkIds: number[]): Promise<void> {
    if (!this.isOpen) await this.open()
    if (this.fallbackExact) {
      await this.fallbackExact.remove(chunkIds)
      this.saveAtomic()
      return
    }

    if (!this.nativeIndex) return

    try {
      if (typeof this.nativeIndex.remove === 'function') {
        for (const id of chunkIds) {
          this.nativeIndex.remove(id)
        }
        this.saveAtomic()
      }
    } catch {
      // Deletions on unsupported versions may require rebuild
    }
  }

  async rebuild(): Promise<void> {
    if (this.fallbackExact) {
      await this.fallbackExact.rebuild()
      this.saveAtomic()
      return
    }
    const mod = getUsearchModule()
    if (mod) {
      this.nativeIndex = new mod.Index({
        dimensions: this.dimensions,
        metric: 'cos',
      })
      if (existsSync(this.indexPath)) {
        try {
          unlinkSync(this.indexPath)
        } catch {
          // ignore
        }
      }
    }
  }

  async close(): Promise<void> {
    if (this.fallbackExact) {
      await this.fallbackExact.close()
      this.fallbackExact = null
    }
    this.nativeIndex = null
    this.isOpen = false
  }

  private saveAtomic(): void {
    if (!this.indexPath) return
    const dir = dirname(this.indexPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    if (this.fallbackExact) {
      const fallbackFile = `${this.indexPath}.fallback.json`
      const tempPath = `${fallbackFile}.tmp`
      try {
        const data = Array.from(this.fallbackExact.getAllEntries())
        writeFileSync(tempPath, JSON.stringify(data), 'utf-8')
        renameSync(tempPath, fallbackFile)
      } catch {
        try {
          if (existsSync(tempPath)) unlinkSync(tempPath)
        } catch {
          // ignore
        }
      }
      return
    }

    if (!this.nativeIndex) return
    const tempPath = `${this.indexPath}.tmp`
    try {
      this.nativeIndex.save(tempPath)
      renameSync(tempPath, this.indexPath)
    } catch {
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath)
      } catch {
        // ignore
      }
    }
  }
}
