import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePolicy } from '../src/main/fork/indexing-policy'
import { scanFilesCooperative } from '../src/main/file-index/scan'
import { FileIndexStore } from '../src/main/file-index/store'
import { FileIndexer } from '../src/main/file-index/indexer'

const WORKER_PATH = join(__dirname, 'file-index-cooperative-worker.mjs')

describe('Indexing Performance & Cooperative Scanning (I01 - I20)', () => {
  let indexer: FileIndexer | null = null

  afterEach(() => {
    indexer?.stop()
    indexer = null
  })

  it('I01 & I02: Fast idle load is bounded; user activity promptly lowers threads and cpuShare', () => {
    // I01: Fast mode, idle on AC: threads capped to <= 4, cpuShare has duty cycle safety (< 1.0)
    const idlePolicy = resolvePolicy({
      mode: 'fast',
      onBattery: false,
      userIdleSeconds: 300,
      cores: 16,
      freeMemMB: 8000,
      totalMemMB: 16000,
      locked: false,
      pauseOnBattery: true,
    })

    expect(idlePolicy.paused).toBe(false)
    expect(idlePolicy.threads).toBeLessThanOrEqual(4)
    expect(idlePolicy.cpuShare).toBeLessThanOrEqual(0.95)

    // I02: User active in Fast mode: threads <= 2, cpuShare <= 0.5
    const activePolicy = resolvePolicy({
      mode: 'fast',
      onBattery: false,
      userIdleSeconds: 5,
      cores: 16,
      freeMemMB: 8000,
      totalMemMB: 16000,
      locked: false,
      pauseOnBattery: true,
    })

    expect(activePolicy.threads).toBeLessThanOrEqual(2)
    expect(activePolicy.cpuShare).toBeLessThanOrEqual(0.5)
  })

  it('I03 & I04: Cooperative scanning yields to event loop and halts on abort signal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'genoffice-coop-walk-'))
    try {
      // Create nested directory structure with multiple files
      for (let i = 0; i < 15; i++) {
        const sub = join(root, `dir-${i}`)
        mkdirSync(sub)
        writeFileSync(join(sub, `file-${i}.docx`), 'dummy content')
      }

      let yields = 0
      const controller = new AbortController()

      // Scan with small batch size to force yields
      const res = await scanFilesCooperative(root, {
        batchSize: 3,
        onYield: () => {
          yields++
        },
      })

      expect(res.complete).toBe(true)
      expect(res.files.length).toBe(15)
      expect(yields).toBeGreaterThan(0)

      // Test abort signal
      controller.abort()
      const abortedRes = await scanFilesCooperative(root, {
        batchSize: 2,
        signal: controller.signal,
      })
      expect(abortedRes.complete).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('I05: Incomplete scan from worker never triggers deletion of existing files in FileIndexer', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'genoffice-coop-store-'))
    const store = new FileIndexStore(join(storeDir, 'index.db'))
    try {
      const existingFile = join(storeDir, 'important-doc.docx')
      store.upsert({ path: existingFile, mtimeMs: 1000, sizeBytes: 500 }, 'Sample body', 'ok')
      expect(store.listAll().has(existingFile)).toBe(true)

      // The cooperative worker double answers scan with complete: false and truncated: true
      indexer = new FileIndexer(store, WORKER_PATH, {
        roots: () => [storeDir],
        extraPaths: () => [],
      })

      await indexer.scan()

      // The deletion diff must protect existing files when the root scan was incomplete
      expect(store.listAll().has(existingFile)).toBe(true)
    } finally {
      store.close()
      rmSync(storeDir, { recursive: true, force: true })
    }
  })

  it('I06 & I07: Offline or unreachable root prevents deletion of previously indexed files', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'genoffice-offline-root-'))
    const store = new FileIndexStore(join(storeDir, 'index.db'))
    try {
      const missingRoot = join(storeDir, 'unmounted-drive-d')
      const docPath = join(missingRoot, 'contract.pdf')
      store.upsert({ path: docPath, mtimeMs: 1000, sizeBytes: 200 }, 'Body', 'ok')

      // Root directory does not exist on disk (offline drive)
      indexer = new FileIndexer(store, WORKER_PATH, {
        roots: () => [missingRoot],
        extraPaths: () => [],
      })

      await indexer.scan()

      // FileIndexer.diff must check root reachability and omit offline root paths from deletion
      expect(store.listAll().has(docPath)).toBe(true)
    } finally {
      store.close()
      rmSync(storeDir, { recursive: true, force: true })
    }
  })

  it('I09: Symlink / junction loops are detected and do not cause infinite traversal', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'genoffice-symlink-loop-'))
    try {
      const subDir = join(tempDir, 'sub')
      mkdirSync(subDir)
      const testFile = join(subDir, 'doc.md')
      writeFileSync(testFile, '# Test')

      // Create a recursive symlink sub/loop -> tempDir
      try {
        symlinkSync(tempDir, join(subDir, 'loop'), 'dir')
      } catch {
        // Platform might require admin privileges for symlinks (Windows)
      }

      const snapshot = await scanFilesCooperative(tempDir)
      expect(snapshot.files.some((f) => f.path === testFile)).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
