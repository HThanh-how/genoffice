import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

/**
 * Regression for the startup / periodic folder reconcile: re-enrolling a file that has not changed
 * is the common case (hundreds of thousands of files per pass on a large corpus), so it must not
 * open a write transaction, rewrite the row, or re-prepare its SQL every time. Measured on a real
 * profile the reconcile held Electron's main thread for ~75% of a 30 s window, mostly in
 * `prepare` + a write transaction per unchanged file, and left a 565 MB WAL behind.
 */
describe('document-memory rescan cost', () => {
  let tempDir: string
  let dbPath: string
  let store: DocumentMemoryStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-rescan-'))
    dbPath = join(tempDir, 'document-memory.db')
    store = new DocumentMemoryStore(dbPath)
  })

  afterEach(() => {
    try {
      store.close()
    } catch {}
    rmSync(tempDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const walBytes = (): number => (existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0)
  const files = (n: number): string[] =>
    Array.from({ length: n }, (_, i) =>
      join(tempDir, 'root', `folder-${i % 25}`, `report-${i}.docx`),
    )

  it('RESCAN-01: re-enrolling unchanged files reports unchanged without writing', () => {
    const paths = files(400)
    for (const p of paths)
      expect(store.enrollDiscoveredResult(p, 1_000, 2_000).outcome).toBe('created')

    // Extraction finished for these files (what a real corpus looks like after the first pass).
    const other = new DatabaseSync(dbPath)
    other.exec("UPDATE documents SET status = 'ready', mtime_ms = 1000, size_bytes = 2000")
    other.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    other.close()

    const walBefore = walBytes()
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, 'prepare')
    const execSpy = vi.spyOn(DatabaseSync.prototype, 'exec')
    const t0 = performance.now()
    for (const p of paths)
      expect(store.enrollDiscoveredResult(p, 1_000, 2_000).outcome).toBe('unchanged')
    const ms = performance.now() - t0
    const prepares = prepareSpy.mock.calls.length
    const execs = execSpy.mock.calls.length
    const walGrowth = walBytes() - walBefore
    console.log(
      `[rescan-cost] ${paths.length} unchanged files: ${ms.toFixed(0)} ms, prepare calls ${prepares}, exec calls ${execs}, WAL growth ${walGrowth} bytes`,
    )

    // Hot path must reuse prepared statements (a handful for the whole pass, not several per file)
    expect(prepares).toBeLessThan(paths.length / 4)
    // ...and must not take a write transaction per unchanged file
    expect(execs).toBeLessThan(paths.length / 4)
    expect(walGrowth).toBe(0)
  })

  it('RESCAN-02: a changed file is still reported as updated and a new one as created', () => {
    const [a, b] = files(2) as [string, string]
    expect(store.enrollDiscoveredResult(a, 1_000, 2_000).outcome).toBe('created')
    expect(store.enrollDiscoveredResult(a, 1_001, 2_000).outcome).toBe('updated')
    expect(store.enrollDiscoveredResult(a, 1_001, 2_001).outcome).toBe('updated')
    expect(store.enrollDiscoveredResult(b, 5, 6).outcome).toBe('created')
    expect(store.documentByPath(a)?.path).toBe(a)
  })

  it('RESCAN-03: documentByPath reuses one prepared statement per connection', () => {
    const paths = files(200)
    for (const p of paths) store.enrollDiscoveredResult(p, 1, 1)
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, 'prepare')
    for (const p of paths) expect(store.documentByPath(p)?.path).toBe(p)
    expect(prepareSpy.mock.calls.length).toBeLessThanOrEqual(2)
  })
})
