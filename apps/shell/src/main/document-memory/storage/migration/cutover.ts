import { existsSync, renameSync, unlinkSync } from 'node:fs'
import { verifyDatabaseIntegrity } from './logical-verifier'

export function cleanWalFiles(path: string): void {
  const wal = `${path}-wal`
  const shm = `${path}-shm`
  if (existsSync(wal)) {
    try {
      unlinkSync(wal)
    } catch {
      // ignore
    }
  }
  if (existsSync(shm)) {
    try {
      unlinkSync(shm)
    } catch {
      // ignore
    }
  }
}

export interface CutoverOptions {
  resolvedSource: string
  tempPath: string
  backupPath: string
  testFailureInjectionPoint?: string
  onRollback?: () => void
}

function safeRenameWithRetry(oldPath: string, newPath: string, maxAttempts = 5): void {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      renameSync(oldPath, newPath)
      return
    } catch (err: any) {
      if ((err?.code === 'EBUSY' || err?.code === 'EPERM') && attempt < maxAttempts) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt)
        continue
      }
      throw err
    }
  }
}

function safeUnlinkWithRetry(targetPath: string, maxAttempts = 5): void {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      unlinkSync(targetPath)
      return
    } catch (err: any) {
      if ((err?.code === 'EBUSY' || err?.code === 'EPERM') && attempt < maxAttempts) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt)
        continue
      }
      throw err
    }
  }
}

/**
 * Executes file-system atomic cutover with safe automatic rollback (INV-09, INV-12).
 */
export function performAtomicCutover(options: CutoverOptions): void {
  const { resolvedSource, tempPath, backupPath, testFailureInjectionPoint, onRollback } = options

  cleanWalFiles(resolvedSource)
  cleanWalFiles(tempPath)

  let backupCreated = false
  try {
    // 1. Rename source -> backup
    safeRenameWithRetry(resolvedSource, backupPath)
    backupCreated = true

    // 2. Rename temp -> source
    safeRenameWithRetry(tempPath, resolvedSource)

    // Test failure injection
    if (testFailureInjectionPoint === 'verification-failed') {
      throw new Error('Test injected verification failure')
    }

    // 3. Verify integrity of new canonical database
    const verification = verifyDatabaseIntegrity(resolvedSource)
    if (!verification.ok) {
      throw new Error(
        `Integrity verification failed post-cutover: integrity=${verification.integrity}, fkErrors=${verification.foreignKeyErrors.length}`,
      )
    }
  } catch (error) {
    onRollback?.()

    // Automatic safe rollback
    if (backupCreated && existsSync(backupPath)) {
      if (existsSync(resolvedSource)) {
        cleanWalFiles(resolvedSource)
        try {
          safeUnlinkWithRetry(resolvedSource)
        } catch {
          // ignore
        }
      }
      safeRenameWithRetry(backupPath, resolvedSource)
    }

    if (existsSync(tempPath)) {
      cleanWalFiles(tempPath)
      try {
        safeUnlinkWithRetry(tempPath)
      } catch {
        // ignore
      }
    }

    throw new Error(
      `V2 to V3 migration failed and was safely rolled back. Reason: ${(error as Error).message}`,
      { cause: error },
    )
  }
}
