import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { normalizeDocumentText, identifierVariants } from './normalization'
import { mediaKindOfPath } from './media/media-kinds'

export const SYSTEM_ROOT_NAMES = new Set([
  'users',
  'user',
  'home',
  'var',
  'tmp',
  'temp',
  'private',
  'appdata',
  'roaming',
  'local',
  'windows',
  'system32',
  'program files',
  'program files (x86)',
  'library',
  'applications',
  'volumes',
  'volume',
  'mnt',
  'etc',
  'usr',
  'bin',
  'opt',
  'node_modules',
  '.git',
  '.gemini',
  '.config',
  '.cache',
])

export const MAX_COMPONENT_LENGTH = 64
export const MIN_NGRAM_LENGTH = 3
export const MAX_NGRAMS_PER_DOC = 120
export const MAX_TOKENS_PER_DOC = 60
export const MAX_PATH_SEGMENTS = 6
export const MAX_QUERY_VARIANTS = 6
export const MAX_QUERY_NGRAMS = 8

export const CURRENT_NAME_PROJECTION_ALGORITHM_VERSION = 2
export const NAME_PROJECTION_VERSION_KEY = 'name_projection_version'
export const NAME_PROJECTION_TARGET_VERSION_KEY = 'name_projection_target_version'
export const NAME_PROJECTION_COMPLETED_VERSION_KEY = 'name_projection_completed_version'
export const NAME_PROJECTION_STATUS_KEY = 'name_projection_status'
export const NAME_PROJECTION_LAST_DOC_ID_KEY = 'name_projection_last_doc_id'

export const NAME_SEARCH_PROJECTION_TABLE = 'document_name_projection'
export const NAME_SEARCH_PROJECTION_FTS = 'document_name_projection_fts'

export const CREATE_NAME_SEARCH_PROJECTION_SQL = `
CREATE TABLE IF NOT EXISTS document_name_projection (
  document_id INTEGER PRIMARY KEY,
  name_norm TEXT NOT NULL,
  path_norm TEXT NOT NULL,
  compact_ngrams TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  row_version INTEGER NOT NULL DEFAULT 1
);

CREATE VIRTUAL TABLE IF NOT EXISTS document_name_projection_fts USING fts5(
  name_norm,
  path_norm,
  compact_ngrams,
  content='document_name_projection',
  content_rowid='document_id',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS doc_name_proj_ai AFTER INSERT ON document_name_projection BEGIN
  INSERT INTO document_name_projection_fts(rowid, name_norm, path_norm, compact_ngrams)
  VALUES (new.document_id, new.name_norm, new.path_norm, new.compact_ngrams);
END;

CREATE TRIGGER IF NOT EXISTS doc_name_proj_ad AFTER DELETE ON document_name_projection BEGIN
  INSERT INTO document_name_projection_fts(document_name_projection_fts, rowid, name_norm, path_norm, compact_ngrams)
  VALUES ('delete', old.document_id, old.name_norm, old.path_norm, old.compact_ngrams);
END;

CREATE TRIGGER IF NOT EXISTS doc_name_proj_au AFTER UPDATE ON document_name_projection BEGIN
  INSERT INTO document_name_projection_fts(document_name_projection_fts, rowid, name_norm, path_norm, compact_ngrams)
  VALUES ('delete', old.document_id, old.name_norm, old.path_norm, old.compact_ngrams);
  INSERT INTO document_name_projection_fts(rowid, name_norm, path_norm, compact_ngrams)
  VALUES (new.document_id, new.name_norm, new.path_norm, new.compact_ngrams);
END;
`

/**
 * Checks whether document_memory_meta table exists.
 */
export function hasMetaTable(db: DatabaseSync): boolean {
  try {
    return Boolean(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_memory_meta'",
        )
        .get(),
    )
  } catch {
    return false
  }
}

/**
 * Guards row_version column query against legacy schemas without row_version.
 */
export function hasRowVersionColumn(db: DatabaseSync): boolean {
  try {
    const columns = db.prepare("PRAGMA table_info('document_name_projection')").all() as Array<{
      name: string
    }>
    return columns.some((c) => c.name === 'row_version')
  } catch {
    return false
  }
}

/**
 * Reads a single key from document_memory_meta safely.
 */
export function getMetaValue(db: DatabaseSync, key: string): string | undefined {
  if (!hasMetaTable(db)) return undefined
  try {
    const row = db.prepare('SELECT value FROM document_memory_meta WHERE key = ?').get(key) as
      { value: string } | undefined
    return row?.value
  } catch {
    return undefined
  }
}

/**
 * Sets a key-value pair in document_memory_meta safely.
 */
export function setMetaValue(db: DatabaseSync, key: string, value: string): void {
  if (!hasMetaTable(db)) return
  db.prepare(
    `
    INSERT INTO document_memory_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `,
  ).run(key, value)
}

export interface NameProjectionMetaState {
  targetVersion: number
  completedVersion: number
  status: 'pending' | 'completed' | 'unknown'
  lastDocId: number
}

/**
 * Reads projection versioning metadata state from document_memory_meta.
 * Distinguishes requested target version, completed version, status, and resumable cursor.
 */
export function getNameProjectionMetaState(db: DatabaseSync): NameProjectionMetaState {
  if (!hasMetaTable(db)) {
    return {
      targetVersion: CURRENT_NAME_PROJECTION_ALGORITHM_VERSION,
      completedVersion: 0,
      status: 'pending',
      lastDocId: 0,
    }
  }

  try {
    const rows = db
      .prepare(
        `
        SELECT key, value FROM document_memory_meta
        WHERE key IN (
          '${NAME_PROJECTION_VERSION_KEY}',
          '${NAME_PROJECTION_TARGET_VERSION_KEY}',
          '${NAME_PROJECTION_COMPLETED_VERSION_KEY}',
          '${NAME_PROJECTION_STATUS_KEY}',
          '${NAME_PROJECTION_LAST_DOC_ID_KEY}'
        )
      `,
      )
      .all() as Array<{ key: string; value: string }>

    const map = new Map(rows.map((r) => [r.key, r.value]))

    let completedVersion = 0
    if (map.has(NAME_PROJECTION_COMPLETED_VERSION_KEY)) {
      completedVersion = Number(map.get(NAME_PROJECTION_COMPLETED_VERSION_KEY)) || 0
    } else if (map.has(NAME_PROJECTION_VERSION_KEY)) {
      completedVersion = Number(map.get(NAME_PROJECTION_VERSION_KEY)) || 0
    }

    const targetVersion = map.has(NAME_PROJECTION_TARGET_VERSION_KEY)
      ? Number(map.get(NAME_PROJECTION_TARGET_VERSION_KEY)) || 0
      : 0

    let status: 'pending' | 'completed' | 'unknown' = 'unknown'
    const rawStatus = map.get(NAME_PROJECTION_STATUS_KEY)
    if (rawStatus === 'pending' || rawStatus === 'completed') {
      status = rawStatus
    } else if (completedVersion >= CURRENT_NAME_PROJECTION_ALGORITHM_VERSION) {
      status = 'completed'
    } else {
      status = 'pending'
    }

    let lastDocId = map.has(NAME_PROJECTION_LAST_DOC_ID_KEY)
      ? Number(map.get(NAME_PROJECTION_LAST_DOC_ID_KEY))
      : 0
    if (!Number.isFinite(lastDocId) || lastDocId < 0) {
      lastDocId = 0
    }

    return { targetVersion, completedVersion, status, lastDocId }
  } catch {
    return {
      targetVersion: CURRENT_NAME_PROJECTION_ALGORITHM_VERSION,
      completedVersion: 0,
      status: 'pending',
      lastDocId: 0,
    }
  }
}

/**
 * Initializes metadata state for versioned projection migration.
 * Resets cursor to 0 exactly once when upgrading to a new algorithm version.
 * Does not overwrite completed version marker blindly, and does not reset cursor on every startup.
 */
export function initNameProjectionMetaState(db: DatabaseSync): void {
  if (!hasMetaTable(db)) return
  // Target, pending state and cursor must change atomically even during startup migration.
  db.exec('SAVEPOINT name_projection_upgrade_state')
  try {
    initializeNameProjectionMetaState(db)
    db.exec('RELEASE name_projection_upgrade_state')
  } catch (error) {
    db.exec('ROLLBACK TO name_projection_upgrade_state')
    db.exec('RELEASE name_projection_upgrade_state')
    throw error
  }
}

function initializeNameProjectionMetaState(db: DatabaseSync): void {
  if (!hasMetaTable(db)) return

  const meta = getNameProjectionMetaState(db)

  // 1. If completedVersion already matches or exceeds CURRENT, ensure status is completed
  if (meta.completedVersion >= CURRENT_NAME_PROJECTION_ALGORITHM_VERSION) {
    setMetaValue(
      db,
      NAME_PROJECTION_TARGET_VERSION_KEY,
      String(CURRENT_NAME_PROJECTION_ALGORITHM_VERSION),
    )
    setMetaValue(db, NAME_PROJECTION_STATUS_KEY, 'completed')
    return
  }

  // 2. If targetVersion is already current and status is pending, upgrade is in flight.
  // Do NOT reset cursor on subsequent startup!
  if (
    meta.targetVersion === CURRENT_NAME_PROJECTION_ALGORITHM_VERSION &&
    meta.status === 'pending'
  ) {
    return
  }

  // 3. First time entering upgrade for CURRENT_NAME_PROJECTION_ALGORITHM_VERSION:
  // Set target version to CURRENT, set pending status, and reset cursor exactly once.
  setMetaValue(
    db,
    NAME_PROJECTION_TARGET_VERSION_KEY,
    String(CURRENT_NAME_PROJECTION_ALGORITHM_VERSION),
  )
  setMetaValue(db, NAME_PROJECTION_STATUS_KEY, 'pending')
  setMetaValue(db, NAME_PROJECTION_LAST_DOC_ID_KEY, '0')

  // Preserve legacy completed version explicitly if missing
  const completedVal = getMetaValue(db, NAME_PROJECTION_COMPLETED_VERSION_KEY)
  if (completedVal === undefined) {
    setMetaValue(db, NAME_PROJECTION_COMPLETED_VERSION_KEY, String(meta.completedVersion))
  }
}

/**
 * Extracts meaningful ancestor folder names from a file path, bounded to `maxSegments`.
 * Excludes drive letters, system directories, and hidden folders.
 */
export function extractMeaningfulPathSegments(
  filePath: string,
  maxSegments = MAX_PATH_SEGMENTS,
): string[] {
  const parts = filePath.split(/[\\/]+/).filter(Boolean)
  if (parts.length <= 1) return []
  const dirs = parts.slice(0, -1)
  const meaningful: string[] = []
  for (let i = dirs.length - 1; i >= 0 && meaningful.length < maxSegments; i--) {
    const seg = dirs[i]!.trim()
    const lower = seg.toLowerCase()
    if (!seg || SYSTEM_ROOT_NAMES.has(lower) || /^[a-zA-Z]:$/.test(seg) || seg.startsWith('.')) {
      continue
    }
    meaningful.push(seg)
  }
  return meaningful.reverse()
}

/**
 * Extracts 3-character ngrams from a text, bounded by `maxTrigrams`.
 */
export function generateTrigrams(text: string, maxTrigrams = MAX_NGRAMS_PER_DOC): string[] {
  const clean = text.replace(/[^a-z0-9]/g, '')
  if (clean.length < MIN_NGRAM_LENGTH) return []
  const ngrams = new Set<string>()
  for (let i = 0; i <= clean.length - MIN_NGRAM_LENGTH; i++) {
    ngrams.add(clean.slice(i, i + MIN_NGRAM_LENGTH))
    if (ngrams.size >= maxTrigrams) break
  }
  return [...ngrams]
}

export interface DocumentProjectionTokens {
  nameNorm: string
  pathNorm: string
  compactNgrams: string
}

/**
 * Builds normalized tokens and compact ngrams for a document's filename and path.
 */
/**
 * Images and videos are the lowest-value rows of the index (a 100k-photo library must stay around a
 * kilobyte per file), so they get a lean projection: name words + the joined stem + the words of the
 * three nearest folders, and NO trigram column (no fuzzy "compact component" matching). Every writer,
 * checker and backfill goes through buildDocumentProjection, so they all agree on this shape.
 */
function buildMediaProjection(name: string, path: string): DocumentProjectionTokens {
  const stemWords = normalizeDocumentText(name.replace(/\.[^/.]+$/, ''))
    .split(' ')
    .filter(Boolean)
  const nameTokens = new Set(stemWords.filter((w) => w.length <= MAX_COMPONENT_LENGTH).slice(0, 8))
  const joined = stemWords.slice(0, 4).join('')
  if (stemWords.length >= 2 && joined.length <= MAX_COMPONENT_LENGTH) nameTokens.add(joined)
  const pathTokens = new Set<string>()
  for (const dir of extractMeaningfulPathSegments(path, 3).reverse()) {
    for (const word of normalizeDocumentText(dir).split(' ')) {
      if (word && word.length <= MAX_COMPONENT_LENGTH && pathTokens.size < 8) pathTokens.add(word)
    }
  }
  return {
    nameNorm: [...nameTokens].join(' '),
    pathNorm: [...pathTokens].join(' '),
    compactNgrams: '',
  }
}

export function buildDocumentProjection(name: string, path: string): DocumentProjectionTokens {
  if (mediaKindOfPath(name)) return buildMediaProjection(name, path)
  const nameTokens = new Set<string>()
  const pathTokens = new Set<string>()
  const ngrams = new Set<string>()

  // 1. Filename processing
  const stem = name.replace(/\.[^/.]+$/, '')
  const stemNorm = normalizeDocumentText(stem)
  const stemWords = stemNorm.split(' ').filter(Boolean)
  const nameNgrams = new Set<string>()
  const pathNgrams = new Set<string>()

  for (const w of stemWords) {
    if (w.length > 0 && w.length <= MAX_COMPONENT_LENGTH) {
      nameTokens.add(w)
      if (w.length >= MIN_NGRAM_LENGTH) {
        for (const tri of generateTrigrams(w, 20)) {
          if (nameNgrams.size < 60) nameNgrams.add(tri)
        }
      }
    }
  }

  // Concatenated stem component
  if (stemWords.length >= 2) {
    const stemJoined = stemWords.join('')
    if (stemJoined.length > 0 && stemJoined.length <= MAX_COMPONENT_LENGTH) {
      nameTokens.add(stemJoined)
      for (const tri of generateTrigrams(stemJoined, 30)) {
        if (nameNgrams.size < 60) nameNgrams.add(tri)
      }
    }

    // Adjacent word pairs
    for (let i = 0; i < stemWords.length - 1 && nameTokens.size < MAX_TOKENS_PER_DOC; i++) {
      const pair = stemWords[i]! + stemWords[i + 1]!
      if (pair.length <= MAX_COMPONENT_LENGTH) {
        nameTokens.add(pair)
        for (const tri of generateTrigrams(pair, 20)) {
          if (nameNgrams.size < 60) nameNgrams.add(tri)
        }
      }
    }
  } else if (stemWords.length === 1 && stemWords[0]!.length >= MIN_NGRAM_LENGTH) {
    for (const tri of generateTrigrams(stemWords[0]!, 40)) {
      if (nameNgrams.size < 60) nameNgrams.add(tri)
    }
  }

  // 2. Meaningful path processing
  const pathDirs = extractMeaningfulPathSegments(path)
  for (const dir of pathDirs) {
    const dirNorm = normalizeDocumentText(dir)
    const dirWords = dirNorm.split(' ').filter(Boolean)
    for (const dw of dirWords) {
      if (
        dw.length > 0 &&
        dw.length <= MAX_COMPONENT_LENGTH &&
        pathTokens.size < MAX_TOKENS_PER_DOC
      ) {
        pathTokens.add(dw)
      }
      if (dw.length >= MIN_NGRAM_LENGTH) {
        for (const tri of generateTrigrams(dw, 20)) {
          if (pathNgrams.size < 60) pathNgrams.add(tri)
        }
      }
    }
    if (dirWords.length >= 2) {
      const dirJoined = dirWords.join('')
      if (
        dirJoined.length > 0 &&
        dirJoined.length <= MAX_COMPONENT_LENGTH &&
        pathTokens.size < MAX_TOKENS_PER_DOC
      ) {
        pathTokens.add(dirJoined)
      }
      for (const tri of generateTrigrams(dirJoined, 30)) {
        if (pathNgrams.size < 60) pathNgrams.add(tri)
      }
      // Adjacent word pairs in directory
      for (let i = 0; i < dirWords.length - 1 && pathTokens.size < MAX_TOKENS_PER_DOC; i++) {
        const pair = dirWords[i]! + dirWords[i + 1]!
        if (pair.length <= MAX_COMPONENT_LENGTH) {
          pathTokens.add(pair)
          for (const tri of generateTrigrams(pair, 20)) {
            if (pathNgrams.size < 60) pathNgrams.add(tri)
          }
        }
      }
    } else if (dirWords.length === 1 && dirWords[0]!.length >= MIN_NGRAM_LENGTH) {
      for (const tri of generateTrigrams(dirWords[0]!, 40)) {
        if (pathNgrams.size < 60) pathNgrams.add(tri)
      }
    }
  }

  // Fair budget combination so filename and path don't starve each other
  for (const tri of nameNgrams) {
    if (ngrams.size < MAX_NGRAMS_PER_DOC) ngrams.add(tri)
  }
  for (const tri of pathNgrams) {
    if (ngrams.size < MAX_NGRAMS_PER_DOC) ngrams.add(tri)
  }

  return {
    nameNorm: [...nameTokens].slice(0, MAX_TOKENS_PER_DOC).join(' '),
    pathNorm: [...pathTokens].slice(0, MAX_TOKENS_PER_DOC).join(' '),
    compactNgrams: [...ngrams].slice(0, MAX_NGRAMS_PER_DOC).join(' '),
  }
}

/**
 * Builds bounded candidate FTS query covering both separated words, concatenated components,
 * narrow aliases, and ngrams.
 */
export function buildProjectionCandidateFtsQuery(words: readonly string[]): string | null {
  if (!words.length) return null

  // Clean words for FTS
  const safeWords = words
    .filter((w) => w.length > 0)
    .slice(0, MAX_QUERY_VARIANTS)
    .map((w) => w.replace(/["*]/g, ''))
    .filter(Boolean)

  if (!safeWords.length) return null

  // Single-word query
  if (safeWords.length === 1) {
    const w = safeWords[0]!
    const variants = identifierVariants(w)
    const nameClauses = variants.map((v) => `"${v}"*`).join(' OR ')
    const pathClauses = variants.map((v) => `"${v}"*`).join(' OR ')
    const parts: string[] = [`name_norm: (${nameClauses})`, `path_norm: (${pathClauses})`]
    if (w.length >= MIN_NGRAM_LENGTH) {
      const tris = generateTrigrams(w, 4)
      if (tris.length >= 2) {
        parts.push(
          `compact_ngrams: (${tris
            .slice(0, 4)
            .map((t) => `"${t}"`)
            .join(' ')})`,
        )
      } else if (tris.length === 1) {
        parts.push(`compact_ngrams: "${tris[0]}"`)
      }
    }
    return parts.join(' OR ')
  }

  // Multi-word query: Build conjunctive per-term clauses
  const termClauses: string[] = []
  for (let i = 0; i < safeWords.length; i++) {
    const w = safeWords[i]!
    const variants = new Set(identifierVariants(w))
    if (i > 0) {
      const prevCompound = safeWords[i - 1]! + w
      if (prevCompound.length <= MAX_COMPONENT_LENGTH) variants.add(prevCompound)
    }
    if (i < safeWords.length - 1) {
      const nextCompound = w + safeWords[i + 1]!
      if (nextCompound.length <= MAX_COMPONENT_LENGTH) variants.add(nextCompound)
    }
    // Narrow aliases (e.g. ra <-> xuat)
    if (w === 'ra') variants.add('xuat')
    else if (w === 'xuat') variants.add('ra')

    const vList = [...variants]
    const vOr = vList.map((v) => (/^\d+$/.test(v) ? `"${v}"` : `"${v}"*`)).join(' OR ')
    termClauses.push(`(name_norm: (${vOr}) OR path_norm: (${vOr}))`)
  }

  const andQuery = termClauses.join(' AND ')
  const joined = safeWords.join('')
  const extraParts: string[] = []
  if (joined.length <= MAX_COMPONENT_LENGTH) {
    const joinedFts = /^\d+$/.test(joined) ? `"${joined}"` : `"${joined}"*`
    extraParts.push(`name_norm: ${joinedFts}`, `path_norm: ${joinedFts}`)
  }

  if (extraParts.length > 0) {
    return `(${andQuery}) OR (${extraParts.join(' OR ')})`
  }
  return andQuery
}

const projectionTableExistsCache = new WeakMap<DatabaseSync, boolean>()

/**
 * Checks whether the projection table exists and is ready in SQLite.
 */
export function hasNameProjection(db: DatabaseSync): boolean {
  const cached = projectionTableExistsCache.get(db)
  if (cached === true) return true
  try {
    const row = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_name_projection'",
      )
      .get()
    const exists = Boolean(row)
    if (exists) {
      projectionTableExistsCache.set(db, true)
    }
    return exists
  } catch (err: unknown) {
    void err
    return false
  }
}

export const BASE_PROJECTION_METADATA_BYTES = 1024
export const MAX_PROJECTION_BATCH_ROWS = 100
export const MAX_PROJECTION_BATCH_BYTES = 512 * 1024 // 512 KB
export const PROJECTION_WAL_MULTIPLIER = 1.5
export const PROJECTION_FTS_EXPANSION = 2.0
export const BASE_ROW_OVERHEAD_BYTES = 64

/**
 * Estimates physical SQLite bytes for a single document's name search projection row.
 * Accounts for UTF-8 byte length of normalized tokens, FTS5 index expansion, and WAL amplification.
 */
export function estimateDocumentProjectionBytes(name: string, path: string): number {
  const proj = buildDocumentProjection(name, path)
  const nameBytes = Buffer.byteLength(proj.nameNorm, 'utf8')
  const pathBytes = Buffer.byteLength(proj.pathNorm, 'utf8')
  const compactBytes = Buffer.byteLength(proj.compactNgrams, 'utf8')
  const totalTextBytes = nameBytes + pathBytes + compactBytes

  const rawStoredBytes = totalTextBytes + BASE_ROW_OVERHEAD_BYTES
  const ftsIndexBytes = Math.ceil(totalTextBytes * PROJECTION_FTS_EXPANSION)
  const rowBytes = rawStoredBytes + ftsIndexBytes

  return Math.ceil(rowBytes * PROJECTION_WAL_MULTIPLIER)
}

/**
 * Estimates physical SQLite bytes for an entire newly discovered document record.
 * Accounts for prospective UTF8 path/name bytes, document row baseline, index overhead,
 * WAL growth multiplier, and compact name projection/FTS5 footprints.
 */
export function estimateNewDocumentMetadataBytes(name: string, path: string): number {
  const pathBytes = Buffer.byteLength(path, 'utf8')
  const nameBytes = Buffer.byteLength(name, 'utf8')
  // Document row (record header + timestamps + metadata) + indices (path unique index + priority_at index)
  const docRowRaw = pathBytes + nameBytes + 128 + (pathBytes + 32) + 64
  const docRowWithWal = Math.ceil(docRowRaw * PROJECTION_WAL_MULTIPLIER)
  const projectionBytes = estimateDocumentProjectionBytes(name, path)
  return Math.max(BASE_PROJECTION_METADATA_BYTES, docRowWithWal + projectionBytes)
}

export interface NameProjectionSyncGuard {
  canWriteProjection(
    doc: { id: number; name: string; path: string },
    estimatedBytes: number,
  ): boolean
}

const dbSyncGuards = new WeakMap<DatabaseSync, NameProjectionSyncGuard>()
let globalSyncGuard: NameProjectionSyncGuard | null = null

export function setDbProjectionSyncGuard(
  db: DatabaseSync,
  guard: NameProjectionSyncGuard | null,
): void {
  if (guard) {
    dbSyncGuards.set(db, guard)
  } else {
    dbSyncGuards.delete(db)
  }
}

export function getDbProjectionSyncGuard(db: DatabaseSync): NameProjectionSyncGuard | null {
  return dbSyncGuards.get(db) ?? null
}

export function clearDbProjectionSyncGuard(db: DatabaseSync): void {
  dbSyncGuards.delete(db)
}

/**
 * @deprecated Retained for backward compatibility only. Production sync guards must be scoped per-database via setDbProjectionSyncGuard.
 */
export function setNameProjectionSyncGuard(guard: NameProjectionSyncGuard | null): void {
  globalSyncGuard = guard
}

/**
 * @deprecated Retained for backward compatibility only. Production sync guards must be scoped per-database via getDbProjectionSyncGuard.
 */
export function getNameProjectionSyncGuard(): NameProjectionSyncGuard | null {
  return globalSyncGuard
}

/**
 * Checks whether the stored projection row matches current normalized values and algorithm version.
 * Allows callers to skip rewriting unchanged projections to avoid unnecessary database growth and debt.
 */
export function isProjectionUpToDate(
  db: DatabaseSync,
  docId: number,
  proj: { nameNorm: string; pathNorm: string; compactNgrams: string },
): boolean {
  if (!hasNameProjection(db)) return false
  try {
    const hasRowVer = hasRowVersionColumn(db)
    const sql = hasRowVer
      ? 'SELECT name_norm, path_norm, compact_ngrams, row_version FROM document_name_projection WHERE document_id = ?'
      : 'SELECT name_norm, path_norm, compact_ngrams FROM document_name_projection WHERE document_id = ?'
    const row = db.prepare(sql).get(docId) as
      | {
          name_norm: string
          path_norm: string
          compact_ngrams: string
          row_version?: number
        }
      | undefined
    if (!row) return false
    if (row.name_norm !== proj.nameNorm) return false
    if (row.path_norm !== proj.pathNorm) return false
    if (row.compact_ngrams !== proj.compactNgrams) return false
    if (hasRowVer && row.row_version !== CURRENT_NAME_PROJECTION_ALGORITHM_VERSION) return false
    return true
  } catch {
    return false
  }
}

/**
 * Inserts or updates projection tokens for a document atomically.
 * Updates both document_name_projection and FTS index via database triggers.
 * Accepts optional typed guard or uses per-DB WeakMap guard for fail-closed quota enforcement.
 */
export function syncProjectionInsert(
  db: DatabaseSync,
  doc: { id: number; path: string; name: string },
  guard?: NameProjectionSyncGuard,
): boolean {
  if (!hasNameProjection(db)) return false
  const proj = buildDocumentProjection(doc.name, doc.path)
  // Existing valid unchanged projection may skip rewriting to avoid unnecessary growth/debt
  if (isProjectionUpToDate(db, doc.id, proj)) {
    return true
  }
  // Production guard lookup is strictly isolated per-DB via WeakMap; no global fallback
  const activeGuard = guard ?? dbSyncGuards.get(db)
  if (activeGuard) {
    const estBytes = estimateDocumentProjectionBytes(doc.name, doc.path)
    if (!activeGuard.canWriteProjection(doc, estBytes)) {
      // Preserve old searchable projection on denial; do not mutate document then silently skip projection
      return false
    }
  }
  if (hasRowVersionColumn(db)) {
    db.prepare(
      `
      INSERT INTO document_name_projection (document_id, name_norm, path_norm, compact_ngrams, updated_at, row_version)
      VALUES (?, ?, ?, ?, unixepoch(), ?)
      ON CONFLICT(document_id) DO UPDATE SET
        name_norm = excluded.name_norm,
        path_norm = excluded.path_norm,
        compact_ngrams = excluded.compact_ngrams,
        updated_at = unixepoch(),
        row_version = excluded.row_version;
    `,
    ).run(
      doc.id,
      proj.nameNorm,
      proj.pathNorm,
      proj.compactNgrams,
      CURRENT_NAME_PROJECTION_ALGORITHM_VERSION,
    )
  } else {
    db.prepare(
      `
      INSERT INTO document_name_projection (document_id, name_norm, path_norm, compact_ngrams, updated_at)
      VALUES (?, ?, ?, ?, unixepoch())
      ON CONFLICT(document_id) DO UPDATE SET
        name_norm = excluded.name_norm,
        path_norm = excluded.path_norm,
        compact_ngrams = excluded.compact_ngrams,
        updated_at = unixepoch();
    `,
    ).run(doc.id, proj.nameNorm, proj.pathNorm, proj.compactNgrams)
  }
  return true
}

export function syncProjectionUpdate(
  db: DatabaseSync,
  doc: { id: number; path: string; name: string },
  guard?: NameProjectionSyncGuard,
): void {
  syncProjectionInsert(db, doc, guard)
}

export function syncProjectionMove(
  db: DatabaseSync,
  docId: number,
  newPath: string,
  newName: string,
  guard?: NameProjectionSyncGuard,
): void {
  syncProjectionInsert(db, { id: docId, path: newPath, name: newName }, guard)
}

const projectionDeleteStmtCache = new WeakMap<DatabaseSync, StatementSync>()

export function syncProjectionDelete(db: DatabaseSync, docId: number): void {
  if (!hasNameProjection(db)) return
  let stmt = projectionDeleteStmtCache.get(db)
  if (!stmt) {
    stmt = db.prepare('DELETE FROM document_name_projection WHERE document_id = ?')
    projectionDeleteStmtCache.set(db, stmt)
  }
  stmt.run(docId)
}

export function syncProjectionExclude(db: DatabaseSync, docId: number): void {
  syncProjectionDelete(db, docId)
}

export function syncProjectionTombstone(db: DatabaseSync, docId: number): void {
  syncProjectionDelete(db, docId)
}

export interface NameProjectionBackfillBounds {
  maxBatchBytes?: number
  maxBatchRows?: number
  preauthorizedBytes?: number
}

export interface NameProjectionBackfillResult {
  processed: number
  remaining: number
  done: boolean
  lastDocId: number
}

/**
 * Versioned bounded resumable batch backfill for name search projection.
 *
 * When algorithm upgrade is pending (completedVersion < CURRENT_NAME_PROJECTION_ALGORITHM_VERSION):
 * - Iterates all documents by id keyset (upserting both existing and unprojected rows).
 * - Atomically commits projection upsert and cursor in the same transaction.
 * - If interrupted or cancelled before batch commit, cursor does not advance and restart skips no rows.
 * - When all rows are scanned, marks completed version within the transaction.
 *
 * When up-to-date (steady-state):
 * - Bounded backfill continues for newly inserted unprojected rows.
 */
export function backfillNameProjectionBatch(
  db: DatabaseSync,
  batchSize = 100,
  bounds?: NameProjectionBackfillBounds,
): NameProjectionBackfillResult {
  if (!hasNameProjection(db)) {
    return { processed: 0, remaining: 0, done: false, lastDocId: 0 }
  }

  const effectiveBatchSize =
    Number.isSafeInteger(bounds?.maxBatchRows) && (bounds?.maxBatchRows ?? 0) > 0
      ? Math.max(1, Math.min(200, bounds!.maxBatchRows!))
      : Number.isSafeInteger(batchSize)
        ? Math.max(1, Math.min(200, batchSize))
        : 100
  const maxBatchBytes =
    Number.isSafeInteger(bounds?.maxBatchBytes) && (bounds?.maxBatchBytes ?? 0) > 0
      ? bounds!.maxBatchBytes!
      : MAX_PROJECTION_BATCH_BYTES

  const meta = getNameProjectionMetaState(db)
  let lastDocId = meta.lastDocId

  const isRebuild =
    meta.completedVersion < CURRENT_NAME_PROJECTION_ALGORITHM_VERSION || meta.status === 'pending'

  if (isRebuild) {
    // Mode 1: Algorithm rebuild / upgrade across existing and missing rows by id keyset
    const candidateDocs = db
      .prepare(
        `
        SELECT d.id, d.name, d.path
        FROM documents d
        WHERE d.excluded = 0 AND d.id > ?
        ORDER BY d.id ASC
        LIMIT ?;
      `,
      )
      .all(lastDocId, effectiveBatchSize) as Array<{ id: number; name: string; path: string }>

    if (candidateDocs.length === 0) {
      // Check total active documents to see if keyset reached the end or table is empty
      const totalDocsRow = db
        .prepare('SELECT count(*) AS total FROM documents WHERE excluded = 0')
        .get() as { total: number } | undefined
      const totalDocs = totalDocsRow?.total ?? 0

      if (totalDocs === 0 || lastDocId > 0) {
        // Rebuild scan completed across all active documents
        db.exec('BEGIN IMMEDIATE')
        try {
          setMetaValue(
            db,
            NAME_PROJECTION_COMPLETED_VERSION_KEY,
            String(CURRENT_NAME_PROJECTION_ALGORITHM_VERSION),
          )
          setMetaValue(
            db,
            NAME_PROJECTION_VERSION_KEY,
            String(CURRENT_NAME_PROJECTION_ALGORITHM_VERSION),
          )
          setMetaValue(db, NAME_PROJECTION_STATUS_KEY, 'completed')
          setMetaValue(
            db,
            NAME_PROJECTION_TARGET_VERSION_KEY,
            String(CURRENT_NAME_PROJECTION_ALGORITHM_VERSION),
          )
          setMetaValue(db, NAME_PROJECTION_LAST_DOC_ID_KEY, '0')
          db.exec('COMMIT')
        } catch (err) {
          db.exec('ROLLBACK')
          throw err
        }

        const missingRow = db
          .prepare(
            `
            SELECT count(*) AS remaining
            FROM documents d
            LEFT JOIN document_name_projection p ON p.document_id = d.id
            WHERE d.excluded = 0 AND p.document_id IS NULL;
          `,
          )
          .get() as { remaining: number } | undefined
        const remaining = missingRow?.remaining ?? 0
        return { processed: 0, remaining, done: remaining === 0, lastDocId: 0 }
      }
    }

    if (candidateDocs.length === 0) {
      return { processed: 0, remaining: 0, done: true, lastDocId }
    }

    // Accumulate documents bounded by physical byte footprint
    const docs: typeof candidateDocs = []
    let batchBytes = BASE_PROJECTION_METADATA_BYTES
    for (const doc of candidateDocs) {
      const est = estimateDocumentProjectionBytes(doc.name, doc.path)
      if (docs.length > 0 && batchBytes + est > maxBatchBytes) {
        break
      }
      if (docs.length === 0 && batchBytes + est > maxBatchBytes) {
        // Even the single first document cannot fit in allowed batch bytes: honest pause
        break
      }
      docs.push(doc)
      batchBytes += est
    }

    if (docs.length === 0) {
      // Min metadata or single row cannot fit: honest paused, cursor does not advance
      const missingRow = db
        .prepare(
          `
          SELECT count(*) AS remaining
          FROM documents d
          LEFT JOIN document_name_projection p ON p.document_id = d.id
          WHERE d.excluded = 0 AND p.document_id IS NULL;
        `,
        )
        .get() as { remaining: number } | undefined
      return { processed: 0, remaining: missingRow?.remaining ?? 0, done: false, lastDocId }
    }

    const newLastDocId = docs[docs.length - 1]!.id
    const hasMore = Boolean(
      db.prepare('SELECT 1 FROM documents WHERE excluded = 0 AND id > ? LIMIT 1').get(newLastDocId),
    )

    db.exec('BEGIN IMMEDIATE')
    try {
      const hasRowVer = hasRowVersionColumn(db)
      const upsertStmt = hasRowVer
        ? db.prepare(`
            INSERT INTO document_name_projection (document_id, name_norm, path_norm, compact_ngrams, updated_at, row_version)
            VALUES (?, ?, ?, ?, unixepoch(), ?)
            ON CONFLICT(document_id) DO UPDATE SET
              name_norm = excluded.name_norm,
              path_norm = excluded.path_norm,
              compact_ngrams = excluded.compact_ngrams,
              updated_at = unixepoch(),
              row_version = excluded.row_version;
          `)
        : db.prepare(`
            INSERT INTO document_name_projection (document_id, name_norm, path_norm, compact_ngrams, updated_at)
            VALUES (?, ?, ?, ?, unixepoch())
            ON CONFLICT(document_id) DO UPDATE SET
              name_norm = excluded.name_norm,
              path_norm = excluded.path_norm,
              compact_ngrams = excluded.compact_ngrams,
              updated_at = unixepoch();
          `)

      for (const doc of docs) {
        const proj = buildDocumentProjection(doc.name, doc.path)
        if (hasRowVer) {
          upsertStmt.run(
            doc.id,
            proj.nameNorm,
            proj.pathNorm,
            proj.compactNgrams,
            CURRENT_NAME_PROJECTION_ALGORITHM_VERSION,
          )
        } else {
          upsertStmt.run(doc.id, proj.nameNorm, proj.pathNorm, proj.compactNgrams)
        }
      }

      if (hasMore) {
        setMetaValue(db, NAME_PROJECTION_LAST_DOC_ID_KEY, String(newLastDocId))
      } else {
        // Rebuild scan completed: atomically mark completed within the same transaction
        setMetaValue(
          db,
          NAME_PROJECTION_COMPLETED_VERSION_KEY,
          String(CURRENT_NAME_PROJECTION_ALGORITHM_VERSION),
        )
        setMetaValue(
          db,
          NAME_PROJECTION_VERSION_KEY,
          String(CURRENT_NAME_PROJECTION_ALGORITHM_VERSION),
        )
        setMetaValue(db, NAME_PROJECTION_STATUS_KEY, 'completed')
        setMetaValue(
          db,
          NAME_PROJECTION_TARGET_VERSION_KEY,
          String(CURRENT_NAME_PROJECTION_ALGORITHM_VERSION),
        )
        setMetaValue(db, NAME_PROJECTION_LAST_DOC_ID_KEY, '0')
      }

      db.exec('COMMIT')
      lastDocId = hasMore ? newLastDocId : 0
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }

    if (hasMore) {
      const remainingRow = db
        .prepare('SELECT count(*) AS remaining FROM documents WHERE excluded = 0 AND id > ?')
        .get(newLastDocId) as { remaining: number } | undefined
      const remaining = remainingRow?.remaining ?? 0
      return {
        processed: docs.length,
        remaining,
        done: false,
        lastDocId,
      }
    } else {
      const missingRow = db
        .prepare(
          `
          SELECT count(*) AS remaining
          FROM documents d
          LEFT JOIN document_name_projection p ON p.document_id = d.id
          WHERE d.excluded = 0 AND p.document_id IS NULL;
        `,
        )
        .get() as { remaining: number } | undefined
      const remaining = missingRow?.remaining ?? 0
      return {
        processed: docs.length,
        remaining,
        done: remaining === 0,
        lastDocId: 0,
      }
    }
  }

  // Mode 2: Steady-state backfill for newly inserted unprojected rows
  let unprojected = db
    .prepare(
      `
      SELECT d.id, d.name, d.path
      FROM documents d
      LEFT JOIN document_name_projection p ON p.document_id = d.id
      WHERE d.excluded = 0 AND p.document_id IS NULL AND d.id > ?
      ORDER BY d.id ASC
      LIMIT ?;
    `,
    )
    .all(lastDocId, effectiveBatchSize) as Array<{ id: number; name: string; path: string }>

  if (unprojected.length === 0 && lastDocId > 0) {
    unprojected = db
      .prepare(
        `
        SELECT d.id, d.name, d.path
        FROM documents d
        LEFT JOIN document_name_projection p ON p.document_id = d.id
        WHERE d.excluded = 0 AND p.document_id IS NULL
        ORDER BY d.id ASC
        LIMIT ?;
      `,
      )
      .all(effectiveBatchSize) as Array<{ id: number; name: string; path: string }>
  }

  if (unprojected.length === 0) {
    const totalRemainingRow = db
      .prepare(
        `
        SELECT count(*) AS remaining
        FROM documents d
        LEFT JOIN document_name_projection p ON p.document_id = d.id
        WHERE d.excluded = 0 AND p.document_id IS NULL;
      `,
      )
      .get() as { remaining: number } | undefined
    const totalRemaining = totalRemainingRow?.remaining ?? 0
    if (totalRemaining === 0 && lastDocId > 0) {
      try {
        setMetaValue(db, NAME_PROJECTION_LAST_DOC_ID_KEY, '0')
        lastDocId = 0
      } catch {
        // non-fatal
      }
    }
    return { processed: 0, remaining: totalRemaining, done: totalRemaining === 0, lastDocId }
  }

  // Accumulate unprojected docs bounded by physical byte footprint
  const docs: typeof unprojected = []
  let batchBytes = BASE_PROJECTION_METADATA_BYTES
  for (const doc of unprojected) {
    const est = estimateDocumentProjectionBytes(doc.name, doc.path)
    if (docs.length > 0 && batchBytes + est > maxBatchBytes) {
      break
    }
    if (docs.length === 0 && batchBytes + est > maxBatchBytes) {
      break
    }
    docs.push(doc)
    batchBytes += est
  }

  if (docs.length === 0) {
    // Honest paused, cursor does not advance
    const countRow = db
      .prepare(
        `
        SELECT count(*) AS remaining
        FROM documents d
        LEFT JOIN document_name_projection p ON p.document_id = d.id
        WHERE d.excluded = 0 AND p.document_id IS NULL;
      `,
      )
      .get() as { remaining: number } | undefined
    return { processed: 0, remaining: countRow?.remaining ?? 0, done: false, lastDocId }
  }

  const newLastDocId = docs[docs.length - 1]!.id

  db.exec('BEGIN IMMEDIATE')
  try {
    const hasRowVer = hasRowVersionColumn(db)
    const insertStmt = hasRowVer
      ? db.prepare(`
          INSERT INTO document_name_projection (document_id, name_norm, path_norm, compact_ngrams, updated_at, row_version)
          VALUES (?, ?, ?, ?, unixepoch(), ?)
          ON CONFLICT(document_id) DO UPDATE SET
            name_norm = excluded.name_norm,
            path_norm = excluded.path_norm,
            compact_ngrams = excluded.compact_ngrams,
            updated_at = unixepoch(),
            row_version = excluded.row_version;
        `)
      : db.prepare(`
          INSERT INTO document_name_projection (document_id, name_norm, path_norm, compact_ngrams, updated_at)
          VALUES (?, ?, ?, ?, unixepoch())
          ON CONFLICT(document_id) DO UPDATE SET
            name_norm = excluded.name_norm,
            path_norm = excluded.path_norm,
            compact_ngrams = excluded.compact_ngrams,
            updated_at = unixepoch();
        `)

    for (const doc of docs) {
      const proj = buildDocumentProjection(doc.name, doc.path)
      if (hasRowVer) {
        insertStmt.run(
          doc.id,
          proj.nameNorm,
          proj.pathNorm,
          proj.compactNgrams,
          CURRENT_NAME_PROJECTION_ALGORITHM_VERSION,
        )
      } else {
        insertStmt.run(doc.id, proj.nameNorm, proj.pathNorm, proj.compactNgrams)
      }
    }

    setMetaValue(db, NAME_PROJECTION_LAST_DOC_ID_KEY, String(newLastDocId))
    db.exec('COMMIT')
    lastDocId = newLastDocId
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  const countRow = db
    .prepare(
      `
      SELECT count(*) AS remaining
      FROM documents d
      LEFT JOIN document_name_projection p ON p.document_id = d.id
      WHERE d.excluded = 0 AND p.document_id IS NULL;
    `,
    )
    .get() as { remaining: number } | undefined

  const remaining = countRow?.remaining ?? 0
  return {
    processed: docs.length,
    remaining,
    done: remaining === 0,
    lastDocId,
  }
}
