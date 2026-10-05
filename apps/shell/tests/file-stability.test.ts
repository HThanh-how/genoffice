import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FileStabilityGate,
  isTemporaryDownloadFile,
  type StabilityResult,
} from '../src/main/document-memory/file-stability'
import { FolderScanManager, reconcileSubtree } from '../src/main/document-memory/folder-scan'

let testDir: string
let gates: FileStabilityGate[]

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'genoffice-stability-test-'))
  gates = []
})

afterEach(() => {
  for (const gate of gates) {
    gate.dispose()
  }
  rmSync(testDir, { recursive: true, force: true })
})

function createGate(
  options?: Parameters<typeof FileStabilityGate.prototype.constructor>[0],
): FileStabilityGate {
  const gate = new FileStabilityGate(options)
  gates.push(gate)
  return gate
}

async function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

describe('FileStabilityGate', () => {
  it('waits for directly written file to stabilize in size before returning stable', async () => {
    const gate = createGate({
      sampleIntervalMs: 60,
      backoffScheduleMs: [40, 80, 120],
      totalTimeoutMs: 5000,
    })

    const filePath = join(testDir, 'growing-file.pdf')
    writeFileSync(filePath, 'chunk-1-')

    // Start watching while file is actively growing
    const stabilityPromise = gate.waitForStability(filePath)

    // Simulate progressive streaming writes
    await delay(30)
    appendFileSync(filePath, 'chunk-2-')

    await delay(50)
    appendFileSync(filePath, 'chunk-3-final')

    // Now writing has stopped; file size is 27 bytes
    const result = await stabilityPromise

    expect(result.kind).toBe('stable')
    if (result.kind === 'stable') {
      expect(result.file.path).toBe(resolve(filePath))
      expect(result.file.sizeBytes).toBe(Buffer.byteLength('chunk-1-chunk-2-chunk-3-final'))
      expect(result.file.mtimeMs).toBeGreaterThan(0)
    }
  })

  it('ignores .crdownload and temp download files, and tracks them once renamed to real files', async () => {
    const gate = createGate({
      sampleIntervalMs: 40,
      backoffScheduleMs: [40, 80],
    })

    const tempPath = join(testDir, 'document.pdf.crdownload')
    writeFileSync(tempPath, 'partially downloaded content')

    // 1. .crdownload must be immediately ignored
    expect(isTemporaryDownloadFile(tempPath)).toBe(true)
    const ignoredResult = await gate.waitForStability(tempPath)
    expect(ignoredResult).toEqual({ kind: 'unavailable' })
    expect(gate.activeCount()).toBe(0)

    // Also check other temporary download extensions
    expect(isTemporaryDownloadFile('file.part')).toBe(true)
    expect(isTemporaryDownloadFile('file.partial')).toBe(true)
    expect(isTemporaryDownloadFile('file.tmp')).toBe(true)
    expect(isTemporaryDownloadFile('file.temp')).toBe(true)
    expect(isTemporaryDownloadFile('file.lock')).toBe(true)
    expect(isTemporaryDownloadFile('file.pdf')).toBe(false)

    // 2. Rename to real file
    const realPath = join(testDir, 'document.pdf')
    renameSync(tempPath, realPath)

    // 3. The renamed real file should now be tracked until stable
    const realResult = await gate.waitForStability(realPath)
    expect(realResult.kind).toBe('stable')
    if (realResult.kind === 'stable') {
      expect(realResult.file.path).toBe(resolve(realPath))
      expect(resultSize(realResult)).toBe(Buffer.byteLength('partially downloaded content'))
    }
  })

  it('returns gone immediately when file does not exist or is abruptly deleted', async () => {
    const gate = createGate({
      sampleIntervalMs: 200,
      backoffScheduleMs: [200],
    })

    // Case 1: File does not exist from the start -> immediate 'gone' without sample delay
    const nonExistentPath = join(testDir, 'non-existent.docx')
    const t0 = Date.now()
    const resultNonExistent = await gate.waitForStability(nonExistentPath)
    const elapsed = Date.now() - t0

    expect(resultNonExistent).toEqual({ kind: 'gone' })
    expect(elapsed).toBeLessThan(150) // No 200ms sleep occurred

    // Case 2: File exists at first, but is abruptly deleted between samples
    const toDeletePath = join(testDir, 'will-be-deleted.txt')
    writeFileSync(toDeletePath, 'temporary content')

    const deletePromise = gate.waitForStability(toDeletePath)
    // Abrupt deletion before sample 2 completes
    await delay(30)
    rmSync(toDeletePath, { force: true })

    const resultDeleted = await deletePromise
    expect(resultDeleted).toEqual({ kind: 'gone' })
  })

  it('coalesces multiple concurrent events for the same file into a single check', async () => {
    const gate = createGate({
      sampleIntervalMs: 80,
      backoffScheduleMs: [50],
    })

    const filePath = join(testDir, 'coalesce-target.md')
    writeFileSync(filePath, '# Markdown Notes')

    // Multiple rapid watcher bursts for the same file
    const promise1 = gate.waitForStability(filePath)
    const promise2 = gate.waitForStability(filePath)
    const promise3 = gate.waitForStability(filePath)

    // All should share the exact same active Promise instance
    expect(promise1).toBe(promise2)
    expect(promise2).toBe(promise3)
    expect(gate.activeCount()).toBe(1)
    expect(gate.isPending(filePath)).toBe(true)

    const [res1, res2, res3] = await Promise.all([promise1, promise2, promise3])

    expect(res1.kind).toBe('stable')
    expect(res2).toEqual(res1)
    expect(res3).toEqual(res1)
    expect(gate.activeCount()).toBe(0)
    expect(gate.isPending(filePath)).toBe(false)
  })

  it('throttles concurrent stat checks according to maxConcurrentStats', async () => {
    let currentConcurrent = 0
    let peakConcurrent = 0

    const mockStat = async (_p: string) => {
      currentConcurrent++
      if (currentConcurrent > peakConcurrent) {
        peakConcurrent = currentConcurrent
      }
      await delay(15)
      currentConcurrent--
      return {
        isFile: () => true,
        size: 100,
        mtimeMs: 1234567,
      }
    }

    const gate = createGate({
      sampleIntervalMs: 20,
      backoffScheduleMs: [20],
      maxConcurrentStats: 4,
      statFn: mockStat,
    })

    // Spawn 20 concurrent file checks
    const promises = Array.from({ length: 20 }, (_, i) =>
      gate.waitForStability(join(testDir, `batch-file-${i}.txt`)),
    )

    const results = await Promise.all(promises)
    expect(results).toHaveLength(20)
    expect(results.every((r) => r.kind === 'stable')).toBe(true)
    // Concurrency must never have exceeded the limit of 4
    expect(peakConcurrent).toBeLessThanOrEqual(4)
  })

  it('cancels all timers and pending operations cleanly on dispose()', async () => {
    const gate = createGate({
      sampleIntervalMs: 1000,
      backoffScheduleMs: [1000],
    })

    const filePath = join(testDir, 'dispose-test.txt')
    writeFileSync(filePath, 'some data')

    const pendingPromise = gate.waitForStability(filePath)
    expect(gate.activeCount()).toBe(1)

    // Call dispose mid-flight
    await delay(30)
    gate.dispose()

    expect(gate.isDisposed()).toBe(true)
    expect(gate.activeCount()).toBe(0)

    const result = await pendingPromise
    expect(result).toEqual({ kind: 'unavailable' })

    // Calls after dispose must return unavailable immediately
    const afterDispose = await gate.waitForStability(filePath)
    expect(afterDispose).toEqual({ kind: 'unavailable' })
  })

  it('times out when file continuously changes beyond totalTimeoutMs', async () => {
    let currentSize = 10
    const mockStat = async (_p: string) => {
      currentSize += 10
      return {
        isFile: () => true,
        size: currentSize,
        mtimeMs: Date.now(),
      }
    }

    const gate = createGate({
      sampleIntervalMs: 20,
      backoffScheduleMs: [20, 20],
      totalTimeoutMs: 100,
      statFn: mockStat,
    })

    const result = await gate.waitForStability(join(testDir, 'infinite-stream.bin'))
    expect(result).toEqual({ kind: 'timeout' })
  })
})

describe('FolderScanManager reconcileSubtree', () => {
  it('reconciles only the specified subtree when a folder is added or unpacked', async () => {
    const root = join(testDir, 'workspace')
    const subFolderA = join(root, 'sub-a')
    const subFolderB = join(root, 'sub-b')
    mkdirSync(subFolderA, { recursive: true })
    mkdirSync(subFolderB, { recursive: true })

    writeFileSync(join(subFolderA, 'doc-a1.pdf'), 'data-a1')
    writeFileSync(join(subFolderB, 'doc-b1.pdf'), 'data-b1')

    const reconciledSubtrees: Array<{ root: string; subtree: string; files: string[] }> = []
    const indexer = {
      indexDiscoveredFile: vi.fn(() => true),
      reconcileSubtree: vi.fn(
        async (
          r: string,
          sub: string,
          files: Map<string, { mtimeMs: number; sizeBytes: number }>,
        ) => {
          reconciledSubtrees.push({ root: r, subtree: sub, files: [...files.keys()] })
        },
      ),
    }

    const scanner = new FolderScanManager(join(testDir, 'scanner-state'), indexer)
    scanner.start(root)

    // Wait until initial full scan finishes
    await delay(100)
    while (scanner.status().running) {
      await delay(20)
    }

    // Now a new file is extracted into sub-a only
    writeFileSync(join(subFolderA, 'doc-a2.pdf'), 'data-a2')

    // Call reconcileSubtree for sub-a
    const result = await reconcileSubtree(scanner, root, subFolderA)

    expect(result.ok).toBe(true)
    expect(result.files).toBe(2) // doc-a1.pdf and doc-a2.pdf
    expect(indexer.reconcileSubtree).toHaveBeenCalledOnce()

    const call = reconciledSubtrees[0]!
    expect(call.root).toBe(resolve(root))
    expect(call.subtree).toBe(resolve(subFolderA))
    // Must contain sub-a files only, NOT sub-b!
    expect(call.files.some((f) => f.includes('doc-b1.pdf'))).toBe(false)
    expect(call.files.some((f) => f.includes('doc-a1.pdf'))).toBe(true)
    expect(call.files.some((f) => f.includes('doc-a2.pdf'))).toBe(true)

    scanner.close()
  })

  it('rejects subtrees located outside the root', async () => {
    const root = join(testDir, 'root-folder')
    const outsideFolder = join(testDir, 'outside-folder')
    mkdirSync(root, { recursive: true })
    mkdirSync(outsideFolder, { recursive: true })

    const scanner = new FolderScanManager(join(testDir, 'state'), {
      indexDiscoveredFile: () => true,
    })
    scanner.start(root)
    while (scanner.status().running) {
      await delay(20)
    }

    const result = await scanner.reconcileSubtree(root, outsideFolder)
    expect(result).toEqual({ ok: false, reason: 'invalid-subtree' })

    scanner.close()
  })

  it('retries during temporary exclusive lock (EBUSY) and becomes stable once unlocked', async () => {
    let openAttempts = 0
    let lockReleased = false

    const gate = createGate({
      sampleIntervalMs: 30,
      backoffScheduleMs: [30, 50],
      totalTimeoutMs: 2000,
      openFn: async () => {
        openAttempts++
        if (!lockReleased) {
          const err = new Error('resource busy or locked') as NodeJS.ErrnoException
          err.code = 'EBUSY'
          throw err
        }
        return { close: async () => {} }
      },
    })

    const filePath = join(testDir, 'locked-doc.pdf')
    writeFileSync(filePath, 'important document content')

    const stabilityPromise = gate.waitForStability(filePath)

    // Initially locked (open #1 -> EBUSY)
    await delay(100)
    expect(openAttempts).toBeGreaterThanOrEqual(1)

    // Release lock
    lockReleased = true

    const result = await stabilityPromise
    expect(result.kind).toBe('stable')
    expect(openAttempts).toBeGreaterThanOrEqual(2)
  })
})

function resultSize(result: StabilityResult): number | undefined {
  if (result.kind === 'stable') return result.file.sizeBytes
  return undefined
}
