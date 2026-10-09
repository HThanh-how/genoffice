import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createArchitectureFixture, type ArchitectureFixture } from './helpers/architecture-fixture'

describe('Document Search V3 Architecture Gate Mutation Sensitivity', () => {
  let fixture: ArchitectureFixture

  beforeEach(() => {
    fixture = createArchitectureFixture()
  })

  afterEach(() => {
    fixture.cleanup()
  })

  function runChecker(): { status: number | null; stdout: string; stderr: string; output: string } {
    return fixture.runChecker()
  }

  function mutateFile(relPath: string, mutator: (content: string) => string): () => void {
    return fixture.mutateFile(relPath, mutator)
  }

  it('verifies baseline passes cleanly with all architecture boundaries satisfied', () => {
    const res = runChecker()
    expect(res.status).toBe(0)
    expect(res.output).toContain('All architecture boundaries PASSED.')
    expect(res.output).toContain('[PASS] Manager: NO DatabaseSync')
    expect(res.output).toContain('[PASS] Snapshot: NO getDocumentIndexDiagnostics')
    expect(res.output).toContain('[PASS] Renderer: NO storage/repository imports')
    expect(res.output).toContain('[PASS] IPC: NO DatabaseSync')
    expect(res.output).toContain('[PASS] Schema: chunks table contains NO vector')
  })

  it('ARCH-01 inject DatabaseSync into manager → checker FAIL', () => {
    // Mutate in-line to avoid exceeding manager.ts LOC limit (<= 500)
    const revert = mutateFile('apps/shell/src/main/document-memory/manager.ts', (content) => {
      return content.replace('export class DocumentMemoryManager', '/* DatabaseSync */ export class DocumentMemoryManager')
    })

    try {
      const res = runChecker()
      expect(res.status).not.toBe(0)
      expect(res.output).toContain('[FAIL] Manager boundary violated')
      expect(res.output).toContain('forbidden pattern(s) found: DatabaseSync')
      expect(res.output).toContain('Architecture check FAILED.')
    } finally {
      revert()
    }
  })

  it('ARCH-02 inject SELECT into manager → FAIL', () => {
    // Mutate in-line to avoid exceeding manager.ts LOC limit (<= 500)
    const revert = mutateFile('apps/shell/src/main/document-memory/manager.ts', (content) => {
      return content.replace('export class DocumentMemoryManager', '/* SELECT * FROM documents */ export class DocumentMemoryManager')
    })

    try {
      const res = runChecker()
      expect(res.status).not.toBe(0)
      expect(res.output).toContain('[FAIL] Manager boundary violated')
      expect(res.output).toContain('forbidden pattern(s) found: SELECT')
      expect(res.output).toContain('Architecture check FAILED.')
    } finally {
      revert()
    }
  })

  it('ARCH-03 add vector to chunks → FAIL', () => {
    const revert = mutateFile('apps/shell/src/main/document-memory/storage/schema-v3.ts', (content) => {
      return content.replace(
        'ordinal INTEGER NOT NULL,',
        'ordinal INTEGER NOT NULL,\n  vector BLOB,',
      )
    })

    try {
      const res = runChecker()
      expect(res.status).not.toBe(0)
      expect(res.output).toContain('[FAIL] Invariant INV-03 violated: chunks table contains "vector" column!')
      expect(res.output).toContain('Architecture check FAILED.')
    } finally {
      revert()
    }
  })

  it('ARCH-04 snapshot calls diagnostics → FAIL', () => {
    const revert = mutateFile('apps/shell/src/renderer/src/fork/useIndexSnapshot.ts', (content) => {
      return content + '\n// forbidden call: getDocumentIndexDiagnostics()\n'
    })

    try {
      const res = runChecker()
      expect(res.status).not.toBe(0)
      expect(res.output).toContain('[FAIL] Snapshot boundary violated')
      expect(res.output).toContain('forbidden call(s) found: getDocumentIndexDiagnostics(')
      expect(res.output).toContain('Architecture check FAILED.')
    } finally {
      revert()
    }
  })

  it('ARCH-05 renderer imports repository → FAIL', () => {
    const revert = mutateFile('apps/shell/src/renderer/src/fork/IndexDashboard.tsx', (content) => {
      return `import { forbidden } from '../storage/repositories/search-repository'\n` + content
    })

    try {
      const res = runChecker()
      expect(res.status).not.toBe(0)
      expect(res.output).toContain('[FAIL] Renderer boundary violated')
      expect(res.output).toContain('forbidden storage/repository import "../storage/repositories/search-repository"')
      expect(res.output).toContain('Architecture check FAILED.')
    } finally {
      revert()
    }
  })
})
