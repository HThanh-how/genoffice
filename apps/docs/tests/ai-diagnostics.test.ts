import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendAiDiagnostic } from '../src/main/ai-diagnostics'

describe('safe AI diagnostics', () => {
  it('persists only metadata and caps the log without leaking supplied payloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genoffice-ai-diag-'))
    try {
      const path = join(dir, 'diagnostics.jsonl')
      appendAiDiagnostic(path, {
        provider: 'agy',
        status: 'retry',
        reason: 'malformed_native_call',
        attempts: 1,
        prompt: 'PRIVATE DOCUMENT',
        error: 'API KEY',
      } as Parameters<typeof appendAiDiagnostic>[1])
      const saved = readFileSync(path, 'utf8')
      expect(saved).not.toContain('PRIVATE DOCUMENT')
      expect(saved).not.toContain('API KEY')
      expect(JSON.parse(saved)).toMatchObject({ provider: 'agy', status: 'retry', attempts: 1 })
      writeFileSync(path, (saved + '\n').repeat(2000))
      appendAiDiagnostic(path, {
        provider: 'agy',
        status: 'success',
        reason: 'cli_result',
        attempts: 2,
        toolCallCount: 1,
      })
      const bounded = readFileSync(path, 'utf8')
      expect(Buffer.byteLength(bounded)).toBeLessThan(128 * 1024)
      expect(JSON.parse(bounded.trim().split('\n').at(-1)!)).toMatchObject({
        status: 'success',
        attempts: 2,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
