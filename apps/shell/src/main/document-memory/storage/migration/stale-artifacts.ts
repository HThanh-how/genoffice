import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getManifestPath } from './cutover'

/** A guard older than this is stale even when its pid is alive again (pid reuse after a reboot / long-dead launcher). */
export const STALE_GUARD_MAX_AGE_MS = 6 * 60 * 60 * 1000

export interface StaleMigrationRecovery {
  /** Base names of the leftover files that were removed. */
  removed: string[]
  /** A live process still owns the migration guard: nothing was touched, the caller must retry later. */
  blockedByPid?: number
  /** A leftover could not be removed (still open elsewhere, permissions). Nothing partial is left behind silently. */
  error?: string
}

export interface StaleRecoveryDeps {
  isProcessAlive?: (pid: number) => boolean
  now?: () => number
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' // exists but not ours
  }
}

/**
 * Removes what a V2->V3 migration that never reached its cutover left behind: the `.migrating` guard and the half-written
 * `.v3.tmp` database (+ WAL/SHM). Safe because the migration only READS the V2 source until `performAtomicCutover` has
 * durably written the cutover manifest: with the live database present and no manifest, the leftovers are scratch space.
 * It deliberately does nothing when the live database is missing, a cutover manifest exists (cutover recovery owns that
 * state), or a different live process still holds the guard.
 */
export function recoverStaleMigrationArtifacts(
  dbDir: string,
  dbBase = 'document-memory.db',
  deps: StaleRecoveryDeps = {},
): StaleMigrationRecovery {
  const db = join(dbDir, dbBase)
  const guard = `${db}.migrating`
  const temp = `${db}.v3.tmp`
  const leftovers = [guard, temp, `${temp}-wal`, `${temp}-shm`].filter((p) => existsSync(p))
  if (leftovers.length === 0) return { removed: [] }
  const manifest = getManifestPath(db)
  if (!existsSync(db) || existsSync(manifest) || existsSync(`${manifest}.tmp`)) return { removed: [] }

  if (existsSync(guard)) {
    let owner: { pid?: unknown; startedAt?: unknown } = {}
    try {
      owner = JSON.parse(readFileSync(guard, 'utf8')) as typeof owner
    } catch {
      // an unreadable guard is a torn write of a dead process
    }
    const pid = typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner.pid : null
    const age = (deps.now ?? Date.now)() - (typeof owner.startedAt === 'number' ? owner.startedAt : 0)
    const alive = deps.isProcessAlive ?? processAlive
    if (pid !== null && pid !== process.pid && age < STALE_GUARD_MAX_AGE_MS && alive(pid)) return { removed: [], blockedByPid: pid }
  }

  const removed: string[] = []
  const failures: string[] = []
  for (const path of leftovers) {
    try {
      unlinkSync(path)
      removed.push(path.slice(dbDir.length + 1))
    } catch (err) {
      failures.push(`${path.slice(dbDir.length + 1)}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`)
    }
  }
  return { removed, ...(failures.length ? { error: `could not remove leftover migration files (${failures.join(', ')})` } : {}) }
}
