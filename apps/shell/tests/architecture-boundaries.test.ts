import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createArchitectureFixture, type ArchitectureFixture } from './helpers/architecture-fixture'

describe('Document Search V3 Architecture Boundaries & Mutation Suite', () => {
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

  it('ARCH-01: fails when DatabaseSync is injected into manager.ts', () => {
    const revert = mutateFile('apps/shell/src/main/document-memory/manager.ts', (content) => {
      // Append comment with DatabaseSync while staying within LOC limit
      return content.trimEnd() + '\n// DatabaseSync\n'
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

  it('ARCH-02: fails when SQL queries are injected into manager.ts', () => {
    const revert = mutateFile('apps/shell/src/main/document-memory/manager.ts', (content) => {
      // Append comment with forbidden SQL keyword while staying within LOC limit
      return content.trimEnd() + '\n// SELECT * FROM documents\n'
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

  it('ARCH-03: fails when snapshot code calls getDocumentIndexDiagnostics', () => {
    const revert = mutateFile('apps/shell/src/renderer/src/fork/useIndexSnapshot.ts', (content) => {
      return content + '\n// dummy call: getDocumentIndexDiagnostics()\n'
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

  it('ARCH-04: fails when vector column is injected into chunks table in schema-v3.ts', () => {
    const revert = mutateFile('apps/shell/src/main/document-memory/storage/schema-v3.ts', (content) => {
      return content.replace(
        'location TEXT NOT NULL',
        'location TEXT NOT NULL,\n  vector BLOB',
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

  it('ARCH-05: fails when storage/repository import is injected into renderer', () => {
    const revert = mutateFile('apps/shell/src/renderer/src/fork/IndexDashboard.tsx', (content) => {
      return `import { forbidden } from '../storage/db'\n` + content
    })

    try {
      const res = runChecker()
      expect(res.status).not.toBe(0)
      expect(res.output).toContain('[FAIL] Renderer boundary violated')
      expect(res.output).toContain('forbidden storage/repository import "../storage/db"')
      expect(res.output).toContain('Architecture check FAILED.')
    } finally {
      revert()
    }
  })
})
