import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { verifyDatabaseIntegrity } from './logical-verifier'
import { enforceBackupRetentionPolicy } from './backup-retention'

export const MIGRATION_MANIFEST_FILENAME = 'document-memory.migration-state.json'

export type CutoverPhase =
  | 'prepared'
  | 'source-backed-up'
  | 'temp-renamed-to-source'
  | 'target-installed'
  | 'completed'

export interface CutoverStateManifest {
  phase: CutoverPhase
  sourceDbPath: string
  tempPath: string
  backupPath: string
  timestamp: number
}

const VALID_PHASES = new Set<string>([
  'prepared',
  'source-backed-up',
  'temp-renamed-to-source',
  'target-installed',
  'completed',
])

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
  const isFile =
    sourcePathOrDir.endsWith('.db') ||
    sourcePathOrDir.endsWith('.sqlite') ||
    sourcePathOrDir.endsWith('.sqlite3') ||
    (existsSync(sourcePathOrDir) && statSync(sourcePathOrDir).isFile())
  const dir = isFile ? dirname(sourcePathOrDir) : sourcePathOrDir
  return join(dir, MIGRATION_MANIFEST_FILENAME)
}

function writeManifest(manifestPath: string, manifest: CutoverStateManifest): void {
  const tempManifest = `${manifestPath}.tmp`
  const json = JSON.stringify(manifest, null, 2)
  try {
    writeFileSync(tempManifest, json, {
      encoding: 'utf8',
      flush: true,
    })
    safeRenameWithRetry(tempManifest, manifestPath)
  } catch (err) {
    try {
      if (existsSync(tempManifest)) unlinkSync(tempManifest)
    } catch {
      // ignore
    }
    throw err
  }
}

function removeManifest(manifestPath: string): void {
  try {
    if (existsSync(manifestPath)) safeUnlinkWithRetry(manifestPath)
  } catch {
    // ignore
  }
  const tempManifest = `${manifestPath}.tmp`
  try {
    if (existsSync(tempManifest)) safeUnlinkWithRetry(tempManifest)
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
  const tempManifest = `${manifestPath}.tmp`

  if (!existsSync(manifestPath)) {
    // Clean up dangling temporary manifest left behind from an uncommitted write if present
    if (existsSync(tempManifest)) {
      try {
        safeUnlinkWithRetry(tempManifest)
      } catch {
        // ignore
      }
    }
    return false
  }

  let rawContent: string
  try {
    rawContent = readFileSync(manifestPath, 'utf8')
  } catch (readErr) {
    throw new Error(
      `Corrupted cutover manifest at "${manifestPath}": failed to read manifest file (${(readErr as Error).message})`,
      { cause: readErr },
    )
  }

  let manifest: CutoverStateManifest
  try {
    manifest = JSON.parse(rawContent) as CutoverStateManifest
  } catch (parseErr) {
    throw new Error(
      `Corrupted cutover manifest at "${manifestPath}": invalid JSON (${(parseErr as Error).message})`,
      { cause: parseErr },
    )
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(
      `Corrupted cutover manifest at "${manifestPath}": invalid JSON structure (manifest is not an object)`,
    )
  }

  const { phase, sourceDbPath, tempPath, backupPath } = manifest

  if (!sourceDbPath || typeof sourceDbPath !== 'string' || sourceDbPath.trim() === '') {
    throw new Error(
      `Corrupted cutover manifest at "${manifestPath}": missing required path "sourceDbPath"`,
    )
  }

  if (!tempPath || typeof tempPath !== 'string' || tempPath.trim() === '') {
    throw new Error(
      `Corrupted cutover manifest at "${manifestPath}": missing required path "tempPath"`,
    )
  }

  if (!backupPath || typeof backupPath !== 'string' || backupPath.trim() === '') {
    throw new Error(
      `Corrupted cutover manifest at "${manifestPath}": missing required path "backupPath"`,
    )
  }

  if (!phase || typeof phase !== 'string' || phase.trim() === '') {
    throw new Error(
      `Corrupted cutover manifest at "${manifestPath}": unknown phase (missing phase)`,
    )
  }

  const normalizedPhase = phase.trim().toLowerCase().replace(/_/g, '-')
  if (!VALID_PHASES.has(normalizedPhase)) {
    throw new Error(
      `Corrupted cutover manifest at "${manifestPath}": unknown phase "${phase}"`,
    )
  }

  if (normalizedPhase === 'prepared') {
    // Abrupt termination after manifest was written.
    // Check if source was already renamed to backup before state updated.
    if (!existsSync(sourceDbPath) && existsSync(backupPath)) {
      cleanWalFiles(sourceDbPath)
      cleanWalFiles(backupPath)
      safeRenameWithRetry(backupPath, sourceDbPath)
    }
    if (existsSync(tempPath)) {
      cleanWalFiles(tempPath)
      try { safeUnlinkWithRetry(tempPath) } catch { /* ignore */ }
    }
    removeManifest(manifestPath)
    return true
  }

  if (normalizedPhase === 'source-backed-up') {
    // Abrupt termination after source was renamed to backup, but before temp became source.
    // Must restore backup to source.
    if (existsSync(backupPath)) {
      cleanWalFiles(sourceDbPath)
      cleanWalFiles(backupPath)
      if (existsSync(sourceDbPath)) {
        try { safeUnlinkWithRetry(sourceDbPath) } catch { /* ignore */ }
      }
      safeRenameWithRetry(backupPath, sourceDbPath)
    } else if (!existsSync(sourceDbPath)) {
      throw new Error(
        `Cutover recovery failed: source-backed-up phase recorded but neither source nor backup file exists at "${sourceDbPath}" or "${backupPath}"`,
      )
    }
    if (existsSync(tempPath)) {
      cleanWalFiles(tempPath)
      try { safeUnlinkWithRetry(tempPath) } catch { /* ignore */ }
    }
    removeManifest(manifestPath)
    return true
  }

  if (normalizedPhase === 'temp-renamed-to-source' || normalizedPhase === 'target-installed') {
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
    } else if (!existsSync(sourceDbPath)) {
      throw new Error(
        `Cutover recovery failed: target database corrupted and backup file does not exist at "${backupPath}"`,
      )
    }
    if (existsSync(tempPath)) {
      cleanWalFiles(tempPath)
      try { safeUnlinkWithRetry(tempPath) } catch { /* ignore */ }
    }
    removeManifest(manifestPath)
    return true
  }

  if (normalizedPhase === 'completed') {
    removeManifest(manifestPath)
    return true
  }

  throw new Error(`Corrupted cutover manifest at "${manifestPath}": unknown phase "${phase}"`)
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
    // 0. Durable Manifest PREPARED before mutating filesystem
    writeManifest(manifestPath, {
      phase: 'prepared',
      sourceDbPath: resolvedSource,
      tempPath,
      backupPath,
      timestamp: Date.now(),
    })

    if (testFailureInjectionPoint === 'crash-before-backup' || testFailureInjectionPoint === 'before-source-backup') {
      throw new Error('Test injected crash before source backup')
    }

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

    if (testFailureInjectionPoint === 'crash-after-backup' || testFailureInjectionPoint === 'after-source-backup') {
      throw new Error('Test injected crash after source backup')
    }

    // 2. Rename temp -> source
    safeRenameWithRetry(tempPath, resolvedSource)
    writeManifest(manifestPath, {
      phase: 'target-installed',
      sourceDbPath: resolvedSource,
      tempPath,
      backupPath,
      timestamp: Date.now(),
    })

    if (
      testFailureInjectionPoint === 'crash-after-temp-rename' ||
      testFailureInjectionPoint === 'after-temp-rename' ||
      testFailureInjectionPoint === 'crash-after-target-installed' ||
      testFailureInjectionPoint === 'after-target-installed'
    ) {
      throw new Error('Test injected crash after temp rename')
    }

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
