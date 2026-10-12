import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FolderScanManager } from '../src/main/document-memory/folder-scan'
import { buildMediaProjection } from '../src/main/document-memory/name-search-projection'
import { openDatabase } from '../src/main/document-memory/storage/database'
import { DocumentRepository } from '../src/main/document-memory/storage/repositories/document-repository'
import { enrollMediaRow } from '../src/main/document-memory/media/media-enrollment'
import type { SyncMetadataGuard } from '../src/main/document-memory/runtime/sync-metadata-admission'
import type { FileEnrollmentResult } from '../src/main/document-memory/storage/repositories/document-repository'

let dir: string
let scanners: FolderScanManager[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-b-reg-'))
  scanners = []
})

afterEach(() => {
  for (const s of scanners) s.close()
  rmSync(dir, { recursive: true, force: true })
})

async function until(check: () => boolean, timeout = 3000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('Agent B Regressions', () => {
  describe('TASK B1 — UNCHANGED FILE RESCAN & WRITE-GATE DENIALS', () => {
    it('rescan of unchanged file completes with 0 errors and does not stop with failure', async () => {
      const root = join(dir, 'test-rescan')
      mkdirSync(root, { recursive: true })
      const filePath = join(root, 'document.docx')
      writeFileSync(filePath, 'hello world content')

      const enrolledList: string[] = []
      const knownFiles = new Map<string, { mtimeMs: number; sizeBytes: number }>()

      const mockIndexer = {
        indexDiscoveredFile: (path: string, meta?: { mtimeMs: number; sizeBytes: number }) => {
          const res = mockIndexer.enrollDiscoveredFile(path, meta)
          return res.outcome === 'created' || res.outcome === 'updated'
        },
        enrollDiscoveredFile: (
          path: string,
          meta?: { mtimeMs: number; sizeBytes: number },
        ): FileEnrollmentResult => {
          const prev = knownFiles.get(path)
          if (prev && prev.mtimeMs === meta?.mtimeMs && prev.sizeBytes === meta?.sizeBytes) {
            return { outcome: 'unchanged' }
          }
          knownFiles.set(path, { mtimeMs: meta!.mtimeMs, sizeBytes: meta!.sizeBytes })
          enrolledList.push(path)
          return { outcome: 'created' }
        },
      }

      const instance = new FolderScanManager(join(dir, 'state'), mockIndexer)
      scanners.push(instance)

      // First scan: enrolls file
      instance.start(root)
      await until(() => !instance.status().running)
      expect(instance.status()).toMatchObject({
        state: 'complete',
        discovered: 1,
        enrolled: 1,
        errors: 0,
      })

      // Second scan (rescan unchanged file)
      instance.start(root)
      await until(() => !instance.status().running)
      expect(instance.status()).toMatchObject({
        state: 'complete',
        discovered: 1,
        enrolled: 0,
        errors: 0,
      })
      expect(instance.status().lastError).toBeUndefined()
    })

    it('write-gate refusal during enrollment stops scan cleanly with refused=true and errors=0', async () => {
      const root = join(dir, 'test-refusal')
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, 'file1.txt'), 'content1')
      writeFileSync(join(root, 'file2.txt'), 'content2')

      const mockIndexer = {
        indexDiscoveredFile: () => false,
        enrollDiscoveredFile: (): FileEnrollmentResult => {
          return {
            outcome: 'refused',
            error: 'Database storage quota reached',
            reason: 'quota-reached',
          }
        },
      }

      const instance = new FolderScanManager(join(dir, 'state'), mockIndexer)
      scanners.push(instance)

      instance.start(root)
      await until(() => !instance.status().running)

      const status = instance.status()
      expect(status.state).toBe('stopped')
      expect(status.refused).toBe(true)
      expect(status.errors).toBe(0)
      expect(status.lastError).toBe('Database storage quota reached')

      const folders = instance.folders()
      expect(folders[0]?.state).toBe('stopped')
      expect(folders[0]?.refused).toBe(true)
      expect(folders[0]?.errors).toBe(0)
    })
  })

  describe('TASK B2 — PROJECTION TRANSACTIONS FAIL-CLOSED AUDIT', () => {
    it('remember rolls back transaction and lease reservation when syncProjectionInsert returns false', () => {
      const dbPath = join(dir, 'test-remember.db')
      const db = openDatabase(dbPath)
      let rollbackCalled = false
      let commitCalled = false

      const rejectWrites = true
      const rejectingGuard: SyncMetadataGuard = {
        isReady: () => true,
        canAdmitNewDocument: () => ({
          admitted: true,
          reservationId: 'res-1',
          ownerToken: 'tok-1',
          reason: 'ok',
          estimatedBytes: 100,
        }),
        settleCommit: () => {
          commitCalled = true
        },
        rollbackCommit: () => {
          rollbackCalled = true
        },
        canWriteProjection: () => !rejectWrites,
        getLastRejectionReason: () => 'Storage admission rejected projection write',
        close: () => {},
      }

      const docRepo = new DocumentRepository(
        db,
        undefined as any,
        undefined as any,
        undefined as any,
        undefined,
        undefined,
        rejectingGuard,
      )

      const testFile = join(dir, 'doc.txt')
      writeFileSync(testFile, 'content')
      const result = docRepo.remember(testFile)

      expect(result).toBe(false)
      expect(rollbackCalled).toBe(true)
      expect(commitCalled).toBe(false)

      // Ensure document row was rolled back and does not exist
      const row = db.prepare('SELECT id FROM documents WHERE path = ?').get(resolve(testFile))
      expect(row).toBeUndefined()
      db.close()
    })

    it('move rolls back transaction and lease reservation when syncProjectionMove returns false', () => {
      const dbPath = join(dir, 'test-move.db')
      const db = openDatabase(dbPath)
      let rollbackCalled: boolean
      let commitCalled: boolean

      let rejectWrites = false
      const guard: SyncMetadataGuard = {
        isReady: () => true,
        canAdmitNewDocument: () => ({
          admitted: true,
          reservationId: 'res-move',
          ownerToken: 'tok-move',
          reason: 'ok',
          estimatedBytes: 100,
        }),
        settleCommit: () => {
          commitCalled = true
        },
        rollbackCommit: () => {
          rollbackCalled = true
        },
        canWriteProjection: () => !rejectWrites,
        getLastRejectionReason: () => 'Storage admission rejected projection move',
        close: () => {},
      }

      const docRepo = new DocumentRepository(
        db,
        undefined as any,
        undefined as any,
        undefined as any,
        undefined,
        undefined,
        guard,
      )

      const oldPath = join(dir, 'old-doc.txt')
      const newPath = join(dir, 'new-doc.txt')
      writeFileSync(oldPath, 'content')
      writeFileSync(newPath, 'content')

      // First create old doc normally
      expect(docRepo.remember(oldPath)).toBe(true)

      // Now attempt move while guard rejects projection move
      rejectWrites = true
      rollbackCalled = false
      commitCalled = false

      expect(() => docRepo.move(oldPath, newPath)).toThrow(
        'Storage admission rejected projection move',
      )
      expect(rollbackCalled).toBe(true)
      expect(commitCalled).toBe(false)

      // Ensure old document was not moved
      const oldDoc = db
        .prepare('SELECT path, name FROM documents WHERE path = ?')
        .get(resolve(oldPath)) as any
      expect(oldDoc).toBeDefined()
      expect(oldDoc.name).toBe('old-doc.txt')
      const newDoc = db.prepare('SELECT id FROM documents WHERE path = ?').get(resolve(newPath))
      expect(newDoc).toBeUndefined()
      db.close()
    })

    it('enrollMediaRow rolls back transaction and lease reservation when syncProjectionInsert returns false', () => {
      const dbPath = join(dir, 'test-media.db')
      const db = openDatabase(dbPath)
      let rollbackCalled = false
      let commitCalled = false

      const rejectWrites = true
      const rejectingGuard: SyncMetadataGuard = {
        isReady: () => true,
        canAdmitNewDocument: () => ({
          admitted: true,
          reservationId: 'res-media',
          ownerToken: 'tok-media',
          reason: 'ok',
          estimatedBytes: 100,
        }),
        settleCommit: () => {
          commitCalled = true
        },
        rollbackCommit: () => {
          rollbackCalled = true
        },
        canWriteProjection: () => !rejectWrites,
        getLastRejectionReason: () => 'Storage admission rejected projection write',
        close: () => {},
      }

      const mediaPath = join(dir, 'photo.jpg')
      writeFileSync(mediaPath, 'binary data that is large enough')

      const outcome = enrollMediaRow(db, rejectingGuard, resolve(mediaPath), 1000, 50_000)

      expect(outcome.outcome).toBe('refused')
      expect(rollbackCalled).toBe(true)
      expect(commitCalled).toBe(false)

      const row = db.prepare('SELECT id FROM documents WHERE path = ?').get(resolve(mediaPath))
      expect(row).toBeUndefined()
      db.close()
    })
  })

  describe('TASK B3 — MEDIA PROJECTION TOKEN LIMITS', () => {
    it('restores buildMediaProjection token limits: 8 filename tokens, 4 joined tokens, 6 path tokens', () => {
      // Create a filename with 12 stem words and a long path with 10 directory segments
      const longName = 'one two three four five six seven eight nine ten eleven twelve.mp4'
      const longPath = '/a/b/c/d/e/f/g/h/i/j/' + longName

      const proj = buildMediaProjection(longName, longPath)

      // Name tokens include at most 8 stem words + 1 joined token
      const nameTokens = proj.nameNorm.split(' ').filter(Boolean)
      expect(nameTokens).toContain('one')
      expect(nameTokens).toContain('eight')
      expect(nameTokens).not.toContain('nine')
      expect(nameTokens).not.toContain('ten')

      // Joined stem token capped at 4 words
      expect(nameTokens).toContain('onetwothreefour')
      expect(nameTokens).not.toContain('onetwothreefourfive')

      // Path tokens capped at 6 tokens
      const pathTokens = proj.pathNorm ? proj.pathNorm.split(' ').filter(Boolean) : []
      expect(pathTokens.length).toBeLessThanOrEqual(6)
    })
  })

  describe('TASK B4 — DEFERRED SCAN RESUMPTION', () => {
    it('resumes deferred scans cleanly when write gate becomes ready without duplicate runners', async () => {
      const root = join(dir, 'test-deferred')
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, 'f1.txt'), '1')
      writeFileSync(join(root, 'f2.txt'), '2')

      let isReady = false
      const listeners = new Set<(ready: boolean) => void>()
      const enrolled: string[] = []

      const mockIndexer = {
        isWriteReady: () => isReady,
        waitForWriteReady: async () => isReady,
        onWriteReadyChange: (fn: (ready: boolean) => void) => {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
        indexDiscoveredFile: (p: string) => {
          enrolled.push(p)
          return true
        },
        enrollDiscoveredFile: (p: string): FileEnrollmentResult => {
          if (!isReady) {
            return {
              outcome: 'deferred',
              reason: 'not-ready',
              error: 'Storage write gate not ready; scan deferred',
            }
          }
          enrolled.push(p)
          return { outcome: 'created' }
        },
      }

      const instance = new FolderScanManager(join(dir, 'state'), mockIndexer)
      scanners.push(instance)

      // Start scan while write gate is not ready
      instance.start(root)
      await until(() => !instance.status().running)

      expect(instance.status().state).toBe('stopped')
      expect(instance.status().deferred).toBe(true)
      expect(enrolled.length).toBe(0)

      // Write gate becomes ready!
      isReady = true
      for (const listener of listeners) listener(true)

      // The deferred scan should automatically resume and finish with complete
      await until(() => !instance.status().running && instance.status().state === 'complete')

      expect(instance.status().state).toBe('complete')
      expect(instance.status().deferred).toBeUndefined()
      expect(enrolled.length).toBe(2)
      expect(instance.folders()[0]?.state).toBe('complete')
    })
  })
})
