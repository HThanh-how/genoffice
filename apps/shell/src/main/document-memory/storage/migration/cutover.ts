import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { verifyDatabaseIntegrity } from './logical-verifier'
import { enforceBackupRetentionPolicy } from './backup-retention'

export const MIGRATION_MANIFEST_FILENAME = 'document-memory.migration-state.json'

export type CutoverPhase = 'source-backed-up' | 'temp-renamed-to-source' | 'completed'

export interface CutoverStateManifest {
  phase: CutoverPhase
  sourceDbPath: string
  tempPath: string
  backupPath: string
  timestamp: number
}

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

export function getManifestPath(sourcePathOrDir: string): string {
  const dir = sourcePathOrDir.endsWith('.db') ? dirname(sourcePathOrDir) : sourcePathOrDir
  return join(dir, MIGRATION_MANIFEST_FILENAME)
}

function writeManifest(manifestPath: string, manifest: CutoverStateManifest): void {
  try {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  } catch {
    // Best-effort manifest persistence
  }
}

function removeManifest(manifestPath: string): void {
  try {
    if (existsSync(manifestPath)) unlinkSync(manifestPath)
  } catch {
    // ignore
  }
}

/**
 * Crash recovery handler: inspects migration-state.json and automatically
 * restores consistency if an abrupt process termination occurred during cutover (BEH-16).
 */
export function recoverInterruptedCutover(sourcePathOrDir: string): boolean {
  const manifestPath = getManifestPath(sourcePathOrDir)
  if (!existsSync(manifestPath)) return false

  let manifest: CutoverStateManifest | null = null
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CutoverStateManifest
  } catch {
    removeManifest(manifestPath)
    return false
  }

  if (!manifest) return false

  const { phase, sourceDbPath, tempPath, backupPath } = manifest

  if (phase === 'source-backed-up') {
    // Abrupt termination after source was renamed to backup, but before temp became source.
    // Must restore backup to source.
    if (existsSync(backupPath)) {
      cleanWalFiles(sourceDbPath)
      cleanWalFiles(backupPath)
      if (existsSync(sourceDbPath)) {
        try { safeUnlinkWithRetry(sourceDbPath) } catch { /* ignore */ }
      }
      safeRenameWithRetry(backupPath, sourceDbPath)
    }
    if (existsSync(tempPath)) {
      cleanWalFiles(tempPath)
      try { safeUnlinkWithRetry(tempPath) } catch { /* ignore */ }
    }
    removeManifest(manifestPath)
    return true
  }

  if (phase === 'temp-renamed-to-source') {
    // Temp was already renamed to source. Validate its integrity.
    if (existsSync(sourceDbPath)) {
      const integrity = verifyDatabaseIntegrity(sourceDbPath)
      if (integrity.ok) {
        removeManifest(manifestPath)
        enforceBackupRetentionPolicy(sourceDbPath)
        return true
      }
    }
    // Corrupted state: restore backup back to source
    if (existsSync(backupPath)) {
      cleanWalFiles(sourceDbPath)
      cleanWalFiles(backupPath)
      if (existsSync(sourceDbPath)) {
        try { safeUnlinkWithRetry(sourceDbPath) } catch { /* ignore */ }
      }
      safeRenameWithRetry(backupPath, sourceDbPath)
    }
    if (existsSync(tempPath)) {
      cleanWalFiles(tempPath)
      try { safeUnlinkWithRetry(tempPath) } catch { /* ignore */ }
    }
    removeManifest(manifestPath)
    return true
  }

  if (phase === 'completed') {
    removeManifest(manifestPath)
    return true
  }

  removeManifest(manifestPath)
  return false
}

/**
 * Executes file-system atomic cutover with State Machine Manifest and safe automatic rollback (BEH-16).
 */
export function performAtomicCutover(options: CutoverOptions): void {
  const { resolvedSource, tempPath, backupPath, testFailureInjectionPoint, onRollback } = options
  const manifestPath = getManifestPath(resolvedSource)

  cleanWalFiles(resolvedSource)
  cleanWalFiles(tempPath)

  let backupCreated = false
  try {
    // 1. Rename source -> backup
    safeRenameWithRetry(resolvedSource, backupPath)
    backupCreated = true
    writeManifest(manifestPath, {
      phase: 'source-backed-up',
      sourceDbPath: resolvedSource,
      tempPath,
      backupPath,
      timestamp: Date.now(),
    })

    // 2. Rename temp -> source
    safeRenameWithRetry(tempPath, resolvedSource)
    writeManifest(manifestPath, {
      phase: 'temp-renamed-to-source',
      sourceDbPath: resolvedSource,
      tempPath,
      backupPath,
      timestamp: Date.now(),
    })

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

    // 4. Mark completed and purge manifest
    writeManifest(manifestPath, {
      phase: 'completed',
      sourceDbPath: resolvedSource,
      tempPath,
      backupPath,
      timestamp: Date.now(),
    })
    removeManifest(manifestPath)

    // Enforce backup retention policy
    enforceBackupRetentionPolicy(resolvedSource)
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

    removeManifest(manifestPath)

    throw new Error(
      `V2 to V3 migration failed and was safely rolled back. Reason: ${(error as Error).message}`,
      { cause: error },
    )
  }
}
