import { resolve } from 'node:path'

const key = (path: string) => {
  const normalized = resolve(path).replace(/\\/g, '/').replace(/\/$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** User intent is separate from source availability: pausing never records a source failure. */
export class FolderPauseRegistry {
  private roots = new Set<string>()
  private readonly cache = new Map<string, boolean>()
  private readonly listeners = new Set<() => void>()
  get hasAny(): boolean {
    return this.roots.size > 0
  }
  replace(paths: readonly string[]): void {
    const next = new Set(paths.map(key))
    if (next.size === this.roots.size && [...next].every((root) => this.roots.has(root))) return
    this.roots = next
    this.cache.clear()
    for (const listener of this.listeners) listener()
  }
  paused(path: string): boolean {
    if (!this.roots.size) return false
    const cached = this.cache.get(path)
    if (cached !== undefined) return cached
    let parent = key(path)
    let paused = false
    while (parent) {
      if (this.roots.has(parent)) {
        paused = true
        break
      }
      const slash = parent.lastIndexOf('/')
      if (slash < 0) break
      parent = parent.slice(0, slash)
    }
    if (this.cache.size >= 100_000) this.cache.clear()
    this.cache.set(path, paused)
    return paused
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
export const folderPauses = new FolderPauseRegistry()
