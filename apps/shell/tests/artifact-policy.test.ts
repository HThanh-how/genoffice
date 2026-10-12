import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  discoveredPathAdmission,
  GENERATED_BUILD_DIRECTORIES,
  GENERATED_BUILD_FILENAMES,
  isGeneratedArtifactPath,
} from '../src/main/document-memory/artifact-policy'
import {
  capChunks,
  clampPdfPages,
  chunkTabularText,
  type DocumentChunk,
  LARGE_PDF_PAGES,
  MAX_CHUNKS_PER_FILE,
  MAX_TABULAR_CHUNKS,
} from '../src/main/document-memory/chunks'
import { isIndexablePath } from '../src/main/document-memory/folder-scan'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { extractDocumentSliced, MAX_INDEX_TEXT_CHARS } from '../src/main/document-memory/worker'

class TestWorkerStub extends EventEmitter {
  constructor(private readonly dbPath: string) {
    super()
  }

  postMessage(_message: { id: number; type: string; path?: string }): void {
    // No-op stub for manager testing
  }

  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}

describe('Document Search V3 Artifact Admission Policy & Resource Budgets', () => {
  let tempDir: string
  let managers: DocumentMemoryManager[]

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'artifact-policy-test-'))
    managers = []
  })

  afterEach(async () => {
    for (const manager of managers) {
      await manager.closeAsync()
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  function createTestManager(): DocumentMemoryManager {
    const manager = new DocumentMemoryManager(tempDir, {
      workerFactory: () =>
        new TestWorkerStub(join(tempDir, 'document-memory.db')) as unknown as Worker,
    })
    managers.push(manager)
    return manager
  }

  describe('Artifact Admission Policy', () => {
    it('rejects LICENSES.chromium.html inside win-unpacked during auto-discovery', () => {
      const winPath = 'C:\\Projects\\app\\win-unpacked\\LICENSES.chromium.html'
      const posixPath = '/var/build/win-unpacked/LICENSES.chromium.html'

      expect(isGeneratedArtifactPath(winPath)).toBe(true)
      expect(isGeneratedArtifactPath(posixPath)).toBe(true)

      const winDecision = discoveredPathAdmission(winPath)
      expect(winDecision.allowed).toBe(false)
      expect(winDecision.reason).toBe('generated-build-directory')

      const posixDecision = discoveredPathAdmission(posixPath)
      expect(posixDecision.allowed).toBe(false)
      expect(posixDecision.reason).toBe('generated-build-directory')

      const root = 'C:\\Projects\\app'
      expect(isIndexablePath(root, winPath)).toBe(false)
    })

    it('rejects LICENSES.chromium.html in normal user directory during auto-discovery', () => {
      const userDocWin = 'C:\\Users\\User\\Documents\\LICENSES.chromium.html'
      const userDocPosix = '/home/user/Documents/LICENSES.chromium.html'

      expect(isGeneratedArtifactPath(userDocWin)).toBe(true)
      expect(isGeneratedArtifactPath(userDocPosix)).toBe(true)

      const winDecision = discoveredPathAdmission(userDocWin)
      expect(winDecision.allowed).toBe(false)
      expect(winDecision.reason).toBe('generated-build-file')

      const posixDecision = discoveredPathAdmission(userDocPosix)
      expect(posixDecision.allowed).toBe(false)
      expect(posixDecision.reason).toBe('generated-build-file')

      const root = 'C:\\Users\\User\\Documents'
      expect(isIndexablePath(root, userDocWin)).toBe(false)
    })

    it('rejects LICENSE.electron.txt in auto-discovery while preserving user LICENSE docs', () => {
      const electronLic = 'C:\\Users\\User\\Documents\\LICENSE.electron.txt'
      expect(isGeneratedArtifactPath(electronLic)).toBe(true)
      expect(discoveredPathAdmission(electronLic).allowed).toBe(false)
      expect(discoveredPathAdmission(electronLic).reason).toBe('generated-build-file')

      // Normal license files must NOT be blocked
      const userLicTxt = 'C:\\Users\\User\\Documents\\LICENSE.txt'
      const userLicMd = 'C:\\Users\\User\\Documents\\LICENSE.md'
      const userLicDocx = 'C:\\Users\\User\\Documents\\Licenses.docx'

      expect(isGeneratedArtifactPath(userLicTxt)).toBe(false)
      expect(discoveredPathAdmission(userLicTxt).allowed).toBe(true)
      expect(isGeneratedArtifactPath(userLicMd)).toBe(false)
      expect(discoveredPathAdmission(userLicMd).allowed).toBe(true)
      expect(isGeneratedArtifactPath(userLicDocx)).toBe(false)
      expect(discoveredPathAdmission(userLicDocx).allowed).toBe(true)
    })

    it('allows explicit open of LICENSES.chromium.html via manager.remember(path)', () => {
      const manager = createTestManager()
      const targetFile = join(tempDir, 'LICENSES.chromium.html')
      writeFileSync(targetFile, '<html><body>Chromium license text</body></html>')

      // manager.remember must not reject explicit user opens
      manager.remember(targetFile)

      const store = (
        manager as unknown as {
          store: {
            documentByPath: (p: string) => { status: string; excluded?: number } | undefined
          }
        }
      ).store
      const doc = store.documentByPath(targetFile)
      expect(doc).toBeDefined()
      expect(doc?.status).not.toBe('excluded')
    })

    it('allows Research\\Release\\paper.docx (does not blanket-ignore release)', () => {
      const winPath = 'C:\\Projects\\Research\\Release\\paper.docx'
      const posixPath = '/home/user/Research/Release/paper.docx'

      expect(isGeneratedArtifactPath(winPath)).toBe(false)
      expect(isGeneratedArtifactPath(posixPath)).toBe(false)

      const winDecision = discoveredPathAdmission(winPath)
      expect(winDecision.allowed).toBe(true)
      expect(winDecision.reason).toBeUndefined()

      const root = 'C:\\Projects\\Research'
      expect(isIndexablePath(root, winPath)).toBe(true)
    })

    it('allows Research\\builds\\paper.docx (does not blanket-ignore builds)', () => {
      const winPath = 'C:\\Projects\\Research\\builds\\paper.docx'
      const posixPath = '/home/user/Research/builds/paper.docx'

      expect(isGeneratedArtifactPath(winPath)).toBe(false)
      expect(isGeneratedArtifactPath(posixPath)).toBe(false)

      const winDecision = discoveredPathAdmission(winPath)
      expect(winDecision.allowed).toBe(true)
      expect(winDecision.reason).toBeUndefined()

      const root = 'C:\\Projects\\Research'
      expect(isIndexablePath(root, winPath)).toBe(true)
    })

    it('covers all generated build directory patterns case-insensitively', () => {
      for (const dirName of GENERATED_BUILD_DIRECTORIES) {
        const testPath = `C:\\Projects\\${dirName.toUpperCase()}\\document.docx`
        expect(isGeneratedArtifactPath(testPath)).toBe(true)
        const decision = discoveredPathAdmission(testPath)
        expect(decision.allowed).toBe(false)
        expect(decision.reason).toBe('generated-build-directory')
      }
    })

    it('covers all generated build filename patterns case-insensitively', () => {
      for (const fileName of GENERATED_BUILD_FILENAMES) {
        const testPath = `C:\\Users\\Documents\\${fileName.toUpperCase()}`
        expect(isGeneratedArtifactPath(testPath)).toBe(true)
        const decision = discoveredPathAdmission(testPath)
        expect(decision.allowed).toBe(false)
        expect(decision.reason).toBe('generated-build-file')
      }
    })
  })

  describe('Per-File Chunk Limits & Budgets', () => {
    it('verifies MAX_CHUNKS_PER_FILE is hardened to 4096', () => {
      expect(MAX_CHUNKS_PER_FILE).toBe(4_096)
    })

    it('caps generic documents exceeding 4096 chunks with truncatedReason chunk-limit', () => {
      const totalChunks = 5_000
      const dummyChunks: DocumentChunk[] = Array.from({ length: totalChunks }, (_, index) => ({
        text: `Paragraph content line number ${index + 1}`,
        location: `Chunk ${index + 1}`,
      }))

      const capped = capChunks(dummyChunks)
      expect(capped.chunks).toHaveLength(4_096)
      expect(capped.truncated).toBe(true)
      expect(capped.truncatedReason).toBe('chunk-limit')
      expect(capped.chunks[0]?.location).toBe('Chunk 1')
      expect(capped.chunks[4095]?.location).toBe('Chunk 4096')

      // Non-exceeding chunk count should not truncate
      const normalChunks = dummyChunks.slice(0, 100)
      const normalResult = capChunks(normalChunks)
      expect(normalResult.chunks).toHaveLength(100)
      expect(normalResult.truncated).toBe(false)
      expect(normalResult.truncatedReason).toBeUndefined()
    })

    it('truncates text exceeding 8MB to 8MB and sets truncatedReason content-limit', async () => {
      expect(MAX_INDEX_TEXT_CHARS).toBe(8 * 1024 * 1024)

      const hugeFile = join(tempDir, 'oversized-document.txt')
      // Create text content larger than 8MB: 8.5 MB
      const textPiece = 'Antigravity enterprise document search engine text content.\n'
      const repeatCount = Math.ceil((8.5 * 1024 * 1024) / textPiece.length)
      const bigText = textPiece.repeat(repeatCount)
      writeFileSync(hugeFile, bigText, 'utf8')

      const result = await extractDocumentSliced(hugeFile)
      if ('partial' in result) {
        throw new Error('Unexpected partial extract for plain text')
      }

      expect(result.truncated).toBe(true)
      expect(result.truncatedReason).toBe('content-limit')
      expect(result.chunks.length).toBeGreaterThan(0)
      expect(result.chunks.length).toBeLessThanOrEqual(4_096)

      // Total character count of all chunks should respect MAX_INDEX_TEXT_CHARS
      const totalIndexedChars = result.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
      expect(totalIndexedChars).toBeLessThanOrEqual(8 * 1024 * 1024 + 10_000)
    })

    it('preserves CSV/XLS sampling with MAX_TABULAR_CHUNKS = 120 and sets tabular-sampling', () => {
      expect(MAX_TABULAR_CHUNKS).toBe(120)

      // Huge CSV with 4000 rows
      const header = 'id,name,department,salary,status,remarks'
      const rows = Array.from(
        { length: 4_000 },
        (_, i) => `${i + 1},Employee_${i + 1},Engineering,95000,Active,Senior developer team lead`,
      )
      const csvContent = [header, ...rows].join('\n')

      const result = chunkTabularText(csvContent)
      expect(result.chunks.length).toBeLessThanOrEqual(120)
      expect(result.truncated).toBe(true)
      expect(result.truncatedReason).toBe('tabular-sampling')

      // Small CSV that fits in budget
      const smallCsv = 'id,name\n1,Alice\n2,Bob'
      const smallResult = chunkTabularText(smallCsv)
      expect(smallResult.chunks.length).toBeGreaterThan(0)
      expect(smallResult.truncated).toBe(false)
      expect(smallResult.truncatedReason).toBeUndefined()
    })

    it('preserves PDF page ceiling with LARGE_PDF_PAGES = 400', () => {
      expect(LARGE_PDF_PAGES).toBe(400)
      expect(clampPdfPages(1000)).toBe(400)
      expect(clampPdfPages(400)).toBe(400)
      expect(clampPdfPages(50)).toBe(50)
      expect(clampPdfPages(0)).toBe(1)
      expect(clampPdfPages(-10)).toBe(1)
      expect(clampPdfPages(undefined)).toBe(30)
    })
  })
})
