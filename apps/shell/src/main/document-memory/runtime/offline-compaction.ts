import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  statfsSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Offline full compaction of document-memory.db via `VACUUM INTO` + verified atomic rename.
 *
 * SAFETY VERDICT: swapping the database file while the app runs is NOT safe and is not offered. The main
 * process and the indexing worker each hold a connection (plus -wal/-shm mmaps); renaming a file under open
 * descriptors makes POSIX writers keep writing to the unlinked inode (silent lost writes) and fails on Windows,
 * and a stale -wal next to a new main file can be replayed into the wrong database. The only variant here is an
 * OFFLINE step that runs before any connection is opened (storage-bootstrap, before DocumentMemoryStore /
 * manager / worker exist) and proves exclusivity by taking an EXCLUSIVE lock itself.
 *
 * It is opt-in (`enabled: true`), never automatic. Measured benefit over the existing online path
 * (incremental_vacuum + wal_checkpoint(TRUNCATE)) is small on a database that is already auto_vacuum=INCREMENTAL
 * (see report): it only removes b-tree fragmentation. Its real use cases are legacy databases with
 * auto_vacuum=NONE (cannot shrink online; this converts them) and a one-off after massive deletions.
 *
 * Crash model: every file mutation is bracketed by a small manifest; `recoverInterruptedCompaction` restores
 * a consistent state (always the OLD verified database unless the new one is fully installed and verified).
 * Temp/backup names deliberately avoid ".tmp" / ".migrating" / ".moving": storage-bootstrap treats those as
 * "unexpected temporary migration artifacts" and fails closed, which would turn a crash here into an app that
 * refuses to start.
 */

export const COMPACTION_DEFAULT_MIN_FREELIST_RATIO = 0.2
export const COMPACTION_DEFAULT_MIN_RECLAIM_BYTES = 16 * 1024 * 1024
export const COMPACTION_DEFAULT_DISK_FACTOR = 1.3
export const COMPACTION_BACKUP_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export type CompactionPhase =
  | 'locked'
  | 'vacuumed'
  | 'verified'
  | 'prepared'
  | 'source-backed-up'
  | 'installed'
  | 'post-verified'

/** Thrown by test hooks to emulate a process crash: no rollback runs, recovery must repair the state. */
export class SimulatedCompactionCrash extends Error {
  constructor(public readonly phase: CompactionPhase) {
    super(`simulated crash at ${phase}`)
  }
}

export interface OfflineCompactionOptions {
  /** Opt-in switch. Without it `runOfflineCompaction` does nothing. */
  enabled?: boolean
  /** Only plan; never opens the database for writing and never creates files. */
  dryRun?: boolean
  /** Skip the freelist-ratio / reclaim thresholds (all other safety preconditions still apply). */
  force?: boolean
  minFreelistRatio?: number
  minReclaimBytes?: number
  /** Required free disk = factor x database bytes (default 1.3). */
  diskFactor?: number
  /** Eligible regardless of freelist when auto_vacuum is not INCREMENTAL (converts the file). Default true. */
  allowAutoVacuumConversion?: boolean
  /** Keep the previous file as `<stem>.compact-prev.<ts>.bak` (default true). */
  keepBackup?: boolean
  freeDiskBytes?: number | null
  now?: () => number
  onPhase?: (phase: CompactionPhase) => void
}

export interface CompactionPlan {
  eligible: boolean
  reasons: string[]
  dbBytes: number
  walBytes: number
  shmBytes: number
  pageSize: number
  pageCount: number
  freelistPages: number
  freelistRatio: number
  autoVacuum: 'none' | 'full' | 'incremental' | 'unknown'
  /** Upper bound: freelist bytes. Online incremental_vacuum recovers these too when auto_vacuum=INCREMENTAL. */
  freelistBytes: number
  freeDiskBytes: number | null
  requiredFreeBytes: number
}

export interface CompactionVerification {
  integrityCheck: string
  quickCheck: string
  foreignKeyErrors: number
  ftsIntegrity: Record<string, boolean>
  tableCounts: number
  schemaEqual: boolean
  pragmasEqual: boolean
  ftsSamples: number
}

export type CompactionStatus = 'compacted' | 'skipped' | 'dry-run' | 'disabled' | 'rolled-back' | 'failed'

export interface CompactionResult {
  status: CompactionStatus
  reasons: string[]
  plan?: CompactionPlan
  bytesBefore: number
  bytesAfter: number
  bytesSaved: number
  backupPath?: string
  durationMs: number
  verification?: CompactionVerification
  error?: string
}

interface CompactionManifest {
  version: 1
  phase: 'prepared' | 'source-backed-up' | 'installed'
  dbPath: string
  tmpPath: string
  backupPath: string
  timestamp: number
}

export function compactionPaths(dbPath: string, now = Date.now()) {
  const dir = dirname(dbPath)
  const base = basename(dbPath)
  const stem = base.replace(/\.db$/, '')
  return {
    dir,
    base,
    stem,
    tmp: join(dir, `${stem}.compact-wip`),
    manifest: join(dir, `${stem}.compact-manifest.json`),
    backup: join(dir, `${stem}.compact-prev.${now}.bak`),
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function unlinkQuiet(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // best effort
  }
}

function removeDbSidecars(path: string): void {
  unlinkQuiet(`${path}-wal`)
  unlinkQuiet(`${path}-shm`)
  unlinkQuiet(`${path}-journal`)
}

function renameRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if ((code === 'EBUSY' || code === 'EPERM') && attempt < 5) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt)
        continue
      }
      throw err
    }
  }
}

function fsyncPath(path: string): void {
  const fd = openSync(path, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

interface SqliteHeader {
  pageSize: number
  pageCount: number
  freelistPages: number
  fileChangeCounter: number
  autoVacuum: CompactionPlan['autoVacuum']
}

/** Reads the 100-byte SQLite header directly (no connection, no side effects). */
export function readSqliteHeader(path: string): SqliteHeader | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(100)
    if (readSync(fd, buf, 0, 100, 0) < 100) return null
    if (buf.subarray(0, 15).toString('latin1') !== 'SQLite format 3') return null
    const rawPage = buf.readUInt16BE(16)
    const pageSize = rawPage === 1 ? 65536 : rawPage
    const counter = buf.readUInt32BE(24)
    const headerPages = buf.readUInt32BE(28)
    const validFor = buf.readUInt32BE(92)
    const filePages = Math.floor(sizeOf(path) / pageSize)
    const pageCount = headerPages > 0 && validFor === counter ? headerPages : filePages
    const bigRoot = buf.readUInt32BE(52)
    const incremental = buf.readUInt32BE(64)
    const autoVacuum = bigRoot === 0 ? 'none' : incremental ? 'incremental' : 'full'
    return { pageSize, pageCount, freelistPages: buf.readUInt32BE(36), fileChangeCounter: counter, autoVacuum }
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function freeDisk(dir: string): number | null {
  try {
    const s = statfsSync(dir)
    const v = Number(s.bavail) * Number(s.bsize)
    return Number.isSafeInteger(v) && v >= 0 ? v : null
  } catch {
    return null
  }
}

/**
 * Read-only eligibility check. Opens nothing but the header bytes and `stat`s, so it is safe to call at any
 * time (even while the app runs: it then simply reports what the offline step would see).
 */
export function planOfflineCompaction(dbPath: string, options: OfflineCompactionOptions = {}): CompactionPlan {
  const reasons: string[] = []
  const minRatio = options.minFreelistRatio ?? COMPACTION_DEFAULT_MIN_FREELIST_RATIO
  const minReclaim = options.minReclaimBytes ?? COMPACTION_DEFAULT_MIN_RECLAIM_BYTES
  const factor = options.diskFactor ?? COMPACTION_DEFAULT_DISK_FACTOR
  const dbBytes = sizeOf(dbPath)
  const walBytes = sizeOf(`${dbPath}-wal`)
  const shmBytes = sizeOf(`${dbPath}-shm`)
  const header = readSqliteHeader(dbPath)
  const dir = dirname(dbPath)

  let lst: Stats | null = null
  try {
    lst = lstatSync(dbPath)
  } catch {
    reasons.push('database-missing')
  }
  if (lst && !lst.isFile()) reasons.push('database-not-regular-file')
  if (lst && !header) reasons.push('not-a-sqlite-database')
  if (walBytes > 0) reasons.push('wal-not-empty: open and close the database normally first (checkpoint)')

  const pageSize = header?.pageSize ?? 0
  const pageCount = header?.pageCount ?? 0
  const freelistPages = header?.freelistPages ?? 0
  const freelistRatio = pageCount > 0 ? freelistPages / pageCount : 0
  const freelistBytes = freelistPages * pageSize
  const autoVacuum = header?.autoVacuum ?? 'unknown'
  const requiredFreeBytes = Math.ceil(dbBytes * factor)
  const free = options.freeDiskBytes !== undefined ? options.freeDiskBytes : freeDisk(dir)

  const convertible = (options.allowAutoVacuumConversion ?? true) && autoVacuum !== 'incremental' && autoVacuum !== 'unknown'
  if (!options.force && !convertible) {
    if (freelistRatio < minRatio) reasons.push(`freelist-ratio-below-threshold (${freelistRatio.toFixed(3)} < ${minRatio})`)
    if (freelistBytes < minReclaim) reasons.push(`reclaimable-bytes-below-threshold (${freelistBytes} < ${minReclaim})`)
  }
  if (free === null) reasons.push('free-disk-unknown')
  else if (free < requiredFreeBytes) reasons.push(`insufficient-free-disk (${free} < ${requiredFreeBytes})`)
  if (existsSync(compactionPaths(dbPath).manifest)) reasons.push('interrupted-compaction-pending-recovery')

  return {
    eligible: reasons.length === 0,
    reasons,
    dbBytes,
    walBytes,
    shmBytes,
    pageSize,
    pageCount,
    freelistPages,
    freelistRatio,
    autoVacuum,
    freelistBytes,
    freeDiskBytes: free,
    requiredFreeBytes,
  }
}

// ---------------------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------------------

interface Fingerprint {
  userVersion: number
  applicationId: number
  pageSize: number
  autoVacuum: number
  schema: string
  counts: Record<string, { count: number; sum: number | null }>
  sequences: string
  ftsTables: string[]
}

const num = (db: DatabaseSync, pragma: string): number => {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>
  return Number(Object.values(row)[0] ?? 0)
}

const quoteIdent = (n: string): string => `"${n.replace(/"/g, '""')}"`

function fingerprint(db: DatabaseSync): Fingerprint {
  const master = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>
  const tables = master.filter((m) => m.type === 'table')
  const counts: Fingerprint['counts'] = {}
  for (const t of tables) {
    const info = db.prepare(`PRAGMA table_info(${quoteIdent(t.name)})`).all() as Array<{ name: string; type: string; pk: number }>
    const pk = info.filter((c) => c.pk > 0)
    // VACUUM may renumber implicit rowids, so only explicit INTEGER PRIMARY KEY values are comparable.
    const ipk = pk.length === 1 && /^integer$/i.test(pk[0]!.type) ? pk[0]!.name : null
    try {
      const sel = ipk ? `count(*) AS c, coalesce(sum(${quoteIdent(ipk)}), 0) AS s` : 'count(*) AS c, 0 AS s'
      const r = db.prepare(`SELECT ${sel} FROM ${quoteIdent(t.name)}`).get() as { c: number; s: number }
      counts[t.name] = { count: Number(r.c), sum: ipk ? Number(r.s) : null }
    } catch {
      counts[t.name] = { count: -1, sum: null }
    }
  }
  let sequences: string
  try {
    sequences = JSON.stringify(db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all())
  } catch {
    sequences = ''
  }
  return {
    userVersion: num(db, 'user_version'),
    applicationId: num(db, 'application_id'),
    pageSize: num(db, 'page_size'),
    autoVacuum: num(db, 'auto_vacuum'),
    schema: JSON.stringify(master),
    counts,
    sequences,
    ftsTables: master.filter((m) => m.type === 'table' && /USING\s+fts5/i.test(m.sql ?? '')).map((m) => m.name),
  }
}

function sampleTerms(db: DatabaseSync, ftsTable: string): string[] {
  try {
    db.exec(`DROP TABLE IF EXISTS temp.cmp_vocab; CREATE VIRTUAL TABLE temp.cmp_vocab USING fts5vocab(main, ${quoteIdent(ftsTable)}, 'row')`)
    const top = db.prepare('SELECT term FROM temp.cmp_vocab ORDER BY doc DESC, term LIMIT 3').all() as Array<{ term: string }>
    const rare = db.prepare('SELECT term FROM temp.cmp_vocab ORDER BY doc ASC, term LIMIT 3').all() as Array<{ term: string }>
    return [...top, ...rare].map((r) => r.term).filter((t) => t && !t.includes('"'))
  } catch {
    return []
  } finally {
    try {
      db.exec('DROP TABLE IF EXISTS temp.cmp_vocab')
    } catch {
      // ignore
    }
  }
}

function matchSignature(db: DatabaseSync, ftsTable: string, term: string): string {
  const rows = db.prepare(`SELECT rowid FROM ${quoteIdent(ftsTable)} WHERE ${quoteIdent(ftsTable)} MATCH ? ORDER BY rowid`).all(`"${term}"`) as Array<{ rowid: number }>
  return `${rows.length}:${rows.length ? rows[0]!.rowid : 0}:${rows.length ? rows[rows.length - 1]!.rowid : 0}:${rows.reduce((a, r) => a + Number(r.rowid), 0)}`
}

/** Verifies `copy` against the live source connection. Returns the reasons it is NOT equivalent (empty = ok). */
function verifyCopy(
  src: DatabaseSync,
  srcFp: Fingerprint,
  copyPath: string,
): { problems: string[]; report: CompactionVerification } {
  const problems: string[] = []
  const copy = new DatabaseSync(copyPath)
  const report: CompactionVerification = {
    integrityCheck: '',
    quickCheck: '',
    foreignKeyErrors: 0,
    ftsIntegrity: {},
    tableCounts: 0,
    schemaEqual: false,
    pragmasEqual: false,
    ftsSamples: 0,
  }
  try {
    report.integrityCheck = String((copy.prepare('PRAGMA integrity_check').get() as Record<string, unknown>).integrity_check)
    report.quickCheck = String((copy.prepare('PRAGMA quick_check(1)').get() as Record<string, unknown>).quick_check)
    report.foreignKeyErrors = copy.prepare('PRAGMA foreign_key_check').all().length
    if (report.integrityCheck !== 'ok') problems.push(`integrity_check=${report.integrityCheck}`)
    if (report.quickCheck !== 'ok') problems.push(`quick_check=${report.quickCheck}`)
    if (report.foreignKeyErrors > 0) problems.push(`foreign_key_check=${report.foreignKeyErrors}`)

    const fp = fingerprint(copy)
    report.schemaEqual = fp.schema === srcFp.schema
    report.pragmasEqual =
      fp.userVersion === srcFp.userVersion && fp.applicationId === srcFp.applicationId && fp.pageSize === srcFp.pageSize
    if (!report.schemaEqual) problems.push('schema-mismatch')
    if (!report.pragmasEqual) problems.push('pragma-mismatch(user_version/application_id/page_size)')
    if (fp.autoVacuum !== 2) problems.push(`auto_vacuum=${fp.autoVacuum} (expected INCREMENTAL=2)`)
    if (fp.sequences !== srcFp.sequences) problems.push('sqlite_sequence-mismatch')
    for (const [name, want] of Object.entries(srcFp.counts)) {
      const got = fp.counts[name]
      report.tableCounts++
      if (!got || got.count !== want.count || got.sum !== want.sum) {
        problems.push(`table-mismatch:${name} (${want.count}/${want.sum} vs ${got?.count}/${got?.sum})`)
      }
    }
    for (const name of Object.keys(fp.counts)) if (!(name in srcFp.counts)) problems.push(`extra-table:${name}`)

    for (const fts of srcFp.ftsTables) {
      let ok = true
      try {
        copy.exec(`INSERT INTO ${quoteIdent(fts)}(${quoteIdent(fts)}) VALUES('integrity-check')`)
      } catch {
        ok = false
      }
      report.ftsIntegrity[fts] = ok
      if (!ok) problems.push(`fts-integrity-failed:${fts}`)
      for (const term of sampleTerms(src, fts)) {
        report.ftsSamples++
        if (matchSignature(src, fts, term) !== matchSignature(copy, fts, term)) problems.push(`fts-sample-mismatch:${fts}:${term}`)
      }
    }
  } catch (err) {
    problems.push(`verification-error:${(err as Error).message}`)
  } finally {
    try {
      copy.close()
    } catch {
      // ignore
    }
  }
  return { problems, report }
}

// ---------------------------------------------------------------------------------------------------------
// Manifest + recovery
// ---------------------------------------------------------------------------------------------------------

function writeManifest(path: string, m: CompactionManifest): void {
  const partial = `${path}.partial`
  writeFileSync(partial, JSON.stringify(m), { mode: 0o600 })
  fsyncPath(partial)
  renameRetry(partial, path)
}

function readManifest(path: string): CompactionManifest | null {
  try {
    const m = JSON.parse(readFileSync(path, 'utf8')) as CompactionManifest
    if (m && m.version === 1 && ['prepared', 'source-backed-up', 'installed'].includes(m.phase)) return m
  } catch {
    // corrupt/partial manifest
  }
  return null
}

function restoreBackup(m: CompactionManifest): void {
  if (existsSync(m.backupPath)) {
    removeDbSidecars(m.dbPath)
    unlinkQuiet(m.dbPath)
    renameRetry(m.backupPath, m.dbPath)
  }
}

export interface CompactionRecovery {
  recovered: boolean
  action: 'none' | 'removed-unfinished-copy' | 'restored-previous-database' | 'finalized-installed-database'
  error?: string
}

/**
 * Brings the directory back to a consistent state after a crash during compaction. Call it at the very start
 * of storage-bootstrap (independent of recoverInterruptedCutover: separate manifest).
 * Policy: roll BACK to the previous database whenever the new one is not fully installed AND passes
 * quick_check; the previous file is never deleted by recovery.
 */
export function recoverInterruptedCompaction(dbPath: string): CompactionRecovery {
  const p = compactionPaths(dbPath)
  const m = readManifest(p.manifest)
  if (!m) {
    // Leftover private copy without a manifest can only be an unfinished VACUUM INTO: safe to drop.
    const hadTmp = existsSync(p.tmp)
    unlinkQuiet(p.tmp)
    removeDbSidecars(p.tmp)
    unlinkQuiet(p.manifest)
    unlinkQuiet(`${p.manifest}.partial`)
    return { recovered: hadTmp, action: hadTmp ? 'removed-unfinished-copy' : 'none' }
  }
  try {
    if (m.phase === 'prepared') {
      unlinkQuiet(m.tmpPath)
      unlinkQuiet(p.manifest)
      return { recovered: true, action: 'removed-unfinished-copy' }
    }
    if (m.phase === 'source-backed-up') {
      // live was renamed away, new copy not installed yet
      if (existsSync(m.backupPath) && !existsSync(m.dbPath)) renameRetry(m.backupPath, m.dbPath)
      unlinkQuiet(m.tmpPath)
      unlinkQuiet(p.manifest)
      return { recovered: true, action: 'restored-previous-database' }
    }
    // installed: keep the new database only if it is sound
    let sound = false
    try {
      const db = new DatabaseSync(m.dbPath)
      try {
        sound = String((db.prepare('PRAGMA quick_check(1)').get() as Record<string, unknown>).quick_check) === 'ok'
      } finally {
        db.close()
      }
    } catch {
      sound = false
    }
    if (sound) {
      unlinkQuiet(p.manifest)
      return { recovered: true, action: 'finalized-installed-database' }
    }
    restoreBackup(m)
    unlinkQuiet(m.tmpPath)
    unlinkQuiet(p.manifest)
    return { recovered: true, action: 'restored-previous-database' }
  } catch (err) {
    return { recovered: false, action: 'none', error: (err as Error).message }
  }
}

/** Removes expired `<stem>.compact-prev.<ts>.bak` files. Touches nothing else. */
export function cleanupCompactionBackups(
  dbPath: string,
  options: { olderThanMs?: number; now?: number; keepNewest?: number } = {},
): string[] {
  const p = compactionPaths(dbPath)
  const ttl = options.olderThanMs ?? COMPACTION_BACKUP_DEFAULT_TTL_MS
  const now = options.now ?? Date.now()
  const re = new RegExp(`^${p.stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.compact-prev\\.(\\d+)\\.bak$`)
  const found: Array<{ path: string; ts: number }> = []
  try {
    for (const name of readdirSync(p.dir)) {
      const m = re.exec(name)
      if (m) found.push({ path: join(p.dir, name), ts: Number(m[1]) })
    }
  } catch {
    return []
  }
  found.sort((a, b) => b.ts - a.ts)
  const removed: string[] = []
  for (const f of found.slice(options.keepNewest ?? 0)) {
    if (now - f.ts >= ttl) {
      unlinkQuiet(f.path)
      if (!existsSync(f.path)) removed.push(f.path)
    }
  }
  return removed
}

// ---------------------------------------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------------------------------------

export function runOfflineCompaction(dbPath: string, options: OfflineCompactionOptions = {}): CompactionResult {
  const now = options.now ?? Date.now
  const started = now()
  const finish = (r: Partial<CompactionResult> & Pick<CompactionResult, 'status'>): CompactionResult => ({
    reasons: [],
    bytesBefore: 0,
    bytesAfter: 0,
    bytesSaved: 0,
    durationMs: now() - started,
    ...r,
  })

  if (!options.enabled) return finish({ status: 'disabled', reasons: ['opt-in required (enabled: true)'] })

  if (!options.dryRun) {
    const rec = recoverInterruptedCompaction(dbPath)
    if (rec.error) return finish({ status: 'failed', error: `recovery failed: ${rec.error}` })
    if (sizeOf(`${dbPath}-wal`) > 0) {
      // Leftover WAL of an unclean exit: a normal open+checkpoint+close is exactly what the app would do anyway.
      try {
        const d = new DatabaseSync(dbPath)
        try {
          d.exec('PRAGMA busy_timeout = 0; PRAGMA wal_checkpoint(TRUNCATE)')
        } finally {
          d.close()
        }
      } catch {
        // the planner reports wal-not-empty / the exclusive probe reports database-in-use
      }
    }
  }

  const plan = planOfflineCompaction(dbPath, options)
  if (!plan.eligible) return finish({ status: 'skipped', plan, reasons: plan.reasons, bytesBefore: plan.dbBytes, bytesAfter: plan.dbBytes })
  if (options.dryRun) return finish({ status: 'dry-run', plan, reasons: ['dry-run'], bytesBefore: plan.dbBytes, bytesAfter: plan.dbBytes })

  const p = compactionPaths(dbPath, now())
  let src: DatabaseSync | null = null
  let backedUp = false
  let installed = false
  try {
    if (existsSync(p.tmp)) throw new Error('a previous compaction copy still exists')
    const mode = statSync(dbPath).mode & 0o777

    // 1. Prove exclusivity: the EXCLUSIVE lock fails while any other connection (main, worker, other process) is open.
    src = new DatabaseSync(dbPath)
    src.exec('PRAGMA busy_timeout = 0')
    src.exec('PRAGMA locking_mode = EXCLUSIVE')
    try {
      src.exec('BEGIN EXCLUSIVE; COMMIT')
    } catch (err) {
      throw new Error(`database-in-use: ${(err as Error).message}`, { cause: err })
    }
    options.onPhase?.('locked')
    const ck = src.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | undefined
    if (ck && Number(ck.busy ?? 0) !== 0) throw new Error('wal-checkpoint-busy')
    const quick = String((src.prepare('PRAGMA quick_check(1)').get() as Record<string, unknown>).quick_check)
    if (quick !== 'ok') throw new Error(`source-quick-check-failed: ${quick}`)

    const srcFp = fingerprint(src)
    const bytesBefore = sizeOf(dbPath)

    // 2. VACUUM INTO a private copy next to the database (same filesystem => atomic rename later).
    src.exec('PRAGMA auto_vacuum = INCREMENTAL') // makes the copy INCREMENTAL even for a legacy NONE source
    src.exec(`VACUUM INTO '${p.tmp.replace(/'/g, "''")}'`)
    options.onPhase?.('vacuumed')
    chmodSync(p.tmp, mode)

    // 3. Verify the copy against the still-locked source.
    const { problems, report } = verifyCopy(src, srcFp, p.tmp)
    if (problems.length > 0) throw Object.assign(new Error(`verification-failed: ${problems.join('; ')}`), { report })
    removeDbSidecars(p.tmp)
    fsyncPath(p.tmp)
    options.onPhase?.('verified')

    // 4. Release the lock (close checkpoints + deletes the WAL), then take the post-close signature of the file.
    //    It is re-checked right before the first rename, so a writer that appears in between aborts the swap.
    src.close()
    src = null
    const signature = (): string => {
      const h = readSqliteHeader(dbPath)
      const st = statSync(dbPath)
      return `${st.size}:${st.mtimeMs}:${h?.fileChangeCounter}:${h?.pageCount}:${h?.freelistPages}`
    }
    if (sizeOf(`${dbPath}-wal`) > 0 || existsSync(`${dbPath}-shm`)) throw new Error('wal-or-shm-present-after-close')
    const closedSignature = signature()

    // 5. Atomic swap with a durable manifest between the two renames.
    const manifest = (phase: CompactionManifest['phase']): CompactionManifest => ({
      version: 1,
      phase,
      dbPath,
      tmpPath: p.tmp,
      backupPath: p.backup,
      timestamp: now(),
    })
    writeManifest(p.manifest, manifest('prepared'))
    options.onPhase?.('prepared')
    if (signature() !== closedSignature || sizeOf(`${dbPath}-wal`) > 0 || existsSync(`${dbPath}-shm`)) {
      throw new Error('source-changed-before-swap')
    }
    renameRetry(dbPath, p.backup)
    backedUp = true
    writeManifest(p.manifest, manifest('source-backed-up'))
    options.onPhase?.('source-backed-up')
    renameRetry(p.tmp, dbPath)
    installed = true
    writeManifest(p.manifest, manifest('installed'))
    options.onPhase?.('installed')

    // 6. Re-verify the installed file from scratch before the old one becomes disposable.
    const check = new DatabaseSync(dbPath)
    try {
      const q = String((check.prepare('PRAGMA quick_check(1)').get() as Record<string, unknown>).quick_check)
      const fp = fingerprint(check)
      if (q !== 'ok') throw new Error(`installed-quick-check-failed: ${q}`)
      if (fp.schema !== srcFp.schema || fp.autoVacuum !== 2) throw new Error('installed-schema-or-auto-vacuum-mismatch')
      for (const [name, want] of Object.entries(srcFp.counts)) {
        if (fp.counts[name]?.count !== want.count) throw new Error(`installed-count-mismatch:${name}`)
      }
    } finally {
      check.close()
    }
    options.onPhase?.('post-verified')
    unlinkQuiet(p.manifest)
    const keep = options.keepBackup ?? true
    if (!keep) unlinkQuiet(p.backup)

    const bytesAfter = sizeOf(dbPath)
    return finish({
      status: 'compacted',
      plan,
      bytesBefore,
      bytesAfter,
      bytesSaved: bytesBefore - bytesAfter,
      backupPath: keep ? p.backup : undefined,
      verification: report,
    })
  } catch (err) {
    try {
      src?.close() // a dead process drops its locks; the simulated crash must too
    } catch {
      // ignore
    }
    if (err instanceof SimulatedCompactionCrash) throw err
    // Roll back to the previous verified database.
    let rolledBack = false
    try {
      if (installed || backedUp) {
        restoreBackup({ version: 1, phase: 'installed', dbPath, tmpPath: p.tmp, backupPath: p.backup, timestamp: 0 })
        rolledBack = true
      }
      unlinkQuiet(p.tmp)
      removeDbSidecars(p.tmp)
      unlinkQuiet(p.manifest)
    } catch (rollbackErr) {
      return finish({
        status: 'failed',
        plan,
        bytesBefore: plan.dbBytes,
        error: `${(err as Error).message}; ROLLBACK FAILED: ${(rollbackErr as Error).message} (run recoverInterruptedCompaction)`,
      })
    }
    return finish({
      status: rolledBack ? 'rolled-back' : 'failed',
      plan,
      bytesBefore: plan.dbBytes,
      bytesAfter: sizeOf(dbPath),
      error: (err as Error).message,
    })
  }
}
