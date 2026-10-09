import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const BOOTSTRAP_LOG_FILE = 'document-memory.log'
const MAX_LOG_BYTES = 512 * 1024

/**
 * Persistent record of the document-memory start-up (migration, recovery, fail-closed reasons) under `<dir>/document-memory.log`.
 * `console.*` output is not kept anywhere in a packaged app, so a failed migration used to leave no trace. Never throws;
 * callers pass aggregate text only (no document names or content).
 */
export function appendBootstrapLog(dir: string, level: 'info' | 'warn' | 'error', message: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, BOOTSTRAP_LOG_FILE)
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`)
    } catch {
      // first write
    }
    appendFileSync(file, `${new Date().toISOString()} [${level}] pid=${process.pid} ${message}\n`)
  } catch {
    // a log write must never decide whether the index opens
  }
}
