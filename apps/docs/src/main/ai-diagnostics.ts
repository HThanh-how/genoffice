import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { StreamCallbacks } from '@genoffice/ai-provider'

type Diagnostic = Parameters<NonNullable<StreamCallbacks['onDiagnostic']>>[0]

/** Persist bounded provider metadata only; prompts, outputs, and raw errors are never written. */
export function appendAiDiagnostic(path: string, record: Diagnostic): void {
  try {
    if (existsSync(path) && statSync(path).size > 128 * 1024) {
      const tail = readFileSync(path, 'utf8').slice(-64 * 1024)
      writeFileSync(path, tail.slice(tail.indexOf('\n') + 1), { mode: 0o600 })
    }
    appendFileSync(
      path,
      JSON.stringify({
        ts: new Date().toISOString(),
        provider: record.provider,
        status: record.status,
        reason: record.reason,
        attempts: record.attempts,
        ...(record.toolCallCount !== undefined ? { toolCallCount: record.toolCallCount } : {}),
      }) + '\n',
      { mode: 0o600 },
    )
  } catch {
    // Diagnostics must not interrupt editing or AI requests.
  }
}
