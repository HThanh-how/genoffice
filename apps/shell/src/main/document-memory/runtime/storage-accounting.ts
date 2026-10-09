import { opendirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { measureNameMetadataBytes } from './name-metadata-accounting'
import { getStorageFreelistStats } from '../storage-gc'
import {
  readV3RetentionState,
  findAllV2Backups,
  getBackupCreationTime,
} from '../storage/migration/v3-retention-state'
import {
  isBackupVerified,
  getCanonicalBackupPath,
} from '../storage/migration/backup-retention'
import {
  MIN_BACKUP_AGE_HOURS,
  MIN_VERIFIED_BACKUPS,
} from '../storage/migration/retention-policy'

export interface StorageAccountingOptions {
  dbPath: string
  db?: DatabaseSync
  vectorsDir?: string
  ocrDir?: string
  tempDir?: string
  modelDir?: string
  annIndexesMeta?: Array<{ space_id: string; file_path: string | null }>
  reusableFreelistBytes?: number
  maxDepth?: number
  maxDirQueue?: number
  maxVisitedEntries?: number
  maxFileInventory?: number
}

export interface StorageAccountingError {
  path: string
  error: string
  code?: string
}

export interface StorageAccountingBreakdown {
  activeDbBytes: number
  walBytes: number
  shmBytes: number
  annBytes: number
  ocrExternalBytes: number
  tempBytes: number
  backupBytes: number
  protectedBackupBytes: number
  reusableFreelistBytes: number
  modelWeightsBytes: number
  sidecarBytes?: number
}

export interface StorageAccountingReport {
  nameMetadataBytes?: number
  databaseBytes: number
  dbSizeBytes: number
  walSizeBytes: number
  shmSizeBytes: number
  sidecarSizeBytes: number
  annSizeBytes: number
  ocrSizeBytes: number
  tempSizeBytes: number
  backupSizeBytes: number
  protectedBytes: number
  totalManagedBytes: number
  totalTrackedBytes: number
  reclaimableBytes: number
  reusableFreelistBytes: number
  modelWeightsBytes: number
  breakdown: StorageAccountingBreakdown
  annFiles: string[]
  backupFiles: string[]
  tempFiles: string[]
  ocrFiles: string[]
  sidecarFiles?: string[]
  measurementErrors: StorageAccountingError[]
  isDegraded: boolean
  timestamp: number
  lastAttemptTimestamp?: number
}

interface MeasuredPath {
  path: string
  size: number
  measured: boolean
}

export interface MeasureDirOptions {
  recursive?: boolean
  maxDepth?: number
  maxDirQueue?: number
  maxVisitedEntries?: number
  maxFileInventory?: number
  onFile?: (measured: MeasuredPath, fileName: string, fullPath: string) => void | 'handled'
}

export const MAX_TRAVERSAL_DEPTH = 32
export const MAX_DIR_QUEUE_SIZE = 10_000
export const MAX_VISITED_ENTRIES = 100_000
export const MAX_FILE_INVENTORY = 50_000

export function isPathInsideRoot(targetPath: string, rootDir: string): boolean {
  const normTarget = resolve(targetPath)
  const normRoot = resolve(rootDir)
  return (
    normTarget === normRoot ||
    normTarget.startsWith(normRoot + '/') ||
    normTarget.startsWith(normRoot + '\\')
  )
}

export function isTempFile(name: string): boolean {
  return (
    name.endsWith('.tmp') ||
    name.includes('.tmp.') ||
    name.endsWith('.usearch.tmp') ||
    name.includes('.usearch.tmp.') ||
    name.includes('.rebuild.tmp') ||
    name.includes('.migration.tmp') ||
    name === 'document-memory.migration-state.json'
  )
}

function measureFile(
  filePath: string,
  visited: Set<string>,
  errors: StorageAccountingError[],
  visitedIdentities?: Set<string>,
  maxVisitedEntries: number = MAX_VISITED_ENTRIES,
): MeasuredPath {
  const resolved = resolve(filePath)
  if (visited.has(resolved)) {
    return { path: resolved, size: 0, measured: false }
  }

  if (visited.size >= maxVisitedEntries) {
    errors.push({
      path: resolved,
      error: `Storage inventory visited entries limit reached (${maxVisitedEntries})`,
      code: 'EQUOTA',
    })
    return { path: resolved, size: 0, measured: false }
  }

  let realPath: string
  try {
    realPath = realpathSync(resolved)
  } catch (err: any) {
    if (err && err.code === 'ENOENT') {
      return { path: resolved, size: 0, measured: false }
    }
    errors.push({
      path: resolved,
      error: err?.message || String(err),
      code: err?.code,
    })
    return { path: resolved, size: 0, measured: false }
  }

  if (visited.has(realPath)) {
    visited.add(resolved)
    return { path: resolved, size: 0, measured: false }
  }

  try {
    // bigint: a 64-bit NTFS file index does not fit a double, and rounded ids make neighbouring files (db / -wal / -shm) look like hard links of each other
    const st = statSync(realPath, { bigint: true })
    if (st.isFile()) {
      if (visitedIdentities) {
        if (visitedIdentities.size >= maxVisitedEntries) {
          errors.push({
            path: resolved,
            error: `Storage inventory file identity limit reached (${maxVisitedEntries})`,
            code: 'EQUOTA',
          })
          return { path: resolved, size: 0, measured: false }
        }
        const fileId = `${st.dev}:${st.ino}`
        if (visitedIdentities.has(fileId)) {
          visited.add(resolved)
          visited.add(realPath)
          return { path: resolved, size: 0, measured: false }
        }
        visitedIdentities.add(fileId)
      }
      visited.add(resolved)
      visited.add(realPath)
      return { path: resolved, size: Number(st.size), measured: true }
    }
    visited.add(resolved)
    visited.add(realPath)
    return { path: resolved, size: 0, measured: false }
  } catch (err: any) {
    if (err && err.code === 'ENOENT') {
      return { path: resolved, size: 0, measured: false }
    }
    errors.push({
      path: resolved,
      error: err?.message || String(err),
      code: err?.code,
    })
    return { path: resolved, size: 0, measured: false }
  }
}

function measureDirFilesMatching(
  dir: string,
  matcher: (fileName: string) => boolean,
  visited: Set<string>,
  errors: StorageAccountingError[],
  options?: boolean | MeasureDirOptions,
  visitedIdentities?: Set<string>,
): { size: number; files: string[] } {
  const resolvedDir = resolve(dir)
  let canonicalRootDir: string
  try {
    canonicalRootDir = realpathSync(resolvedDir)
  } catch (err: any) {
    if (err && err.code === 'ENOENT') {
      return { size: 0, files: [] }
    }
    errors.push({
      path: resolvedDir,
      error: err?.message || String(err),
      code: err?.code,
    })
    return { size: 0, files: [] }
  }

  const isRecursive = typeof options === 'boolean' ? options : (options?.recursive ?? false)
  const maxDepth = typeof options === 'object' && typeof options?.maxDepth === 'number'
    ? options.maxDepth
    : MAX_TRAVERSAL_DEPTH
  const maxDirQueue = typeof options === 'object' && typeof options?.maxDirQueue === 'number'
    ? options.maxDirQueue
    : MAX_DIR_QUEUE_SIZE
  const maxVisitedEntries = typeof options === 'object' && typeof options?.maxVisitedEntries === 'number'
    ? options.maxVisitedEntries
    : MAX_VISITED_ENTRIES
  const maxFileInventory = typeof options === 'object' && typeof options?.maxFileInventory === 'number'
    ? options.maxFileInventory
    : MAX_FILE_INVENTORY
  const onFile = typeof options === 'object' ? options?.onFile : undefined

  let total = 0
  const matchedFiles: string[] = []

  const visitedDirs = new Set<string>()
  visitedDirs.add(canonicalRootDir)

  let totalVisitedCount = 0
  let totalMatchedCount = 0
  let limitReached = false

  // Bounded directory queue for iterative breadth-first/depth-bounded traversal
  const dirQueue: Array<{ dirPath: string; depth: number }> = [
    { dirPath: canonicalRootDir, depth: 0 },
  ]

  while (dirQueue.length > 0 && !limitReached) {
    const current = dirQueue.shift()!
    const { dirPath: currentDir, depth } = current

    let dirStream: import('node:fs').Dir
    try {
      dirStream = opendirSync(currentDir)
    } catch (err: any) {
      if (err && err.code === 'ENOENT') {
        continue
      }
      errors.push({
        path: currentDir,
        error: err?.message || String(err),
        code: err?.code,
      })
      continue
    }

    try {
      let entry: import('node:fs').Dirent | null
      while ((entry = dirStream.readSync()) !== null) {
        totalVisitedCount++
        if (totalVisitedCount > maxVisitedEntries) {
          errors.push({
            path: currentDir,
            error: `Storage inventory visited entries limit reached (${maxVisitedEntries})`,
            code: 'EQUOTA',
          })
          limitReached = true
          break
        }

        const fullPath = join(currentDir, entry.name)

        if (entry.isDirectory()) {
          if (isRecursive) {
            let realSubDir: string
            try {
              realSubDir = realpathSync(fullPath)
            } catch (err: any) {
              if (err && err.code === 'ENOENT') continue
              errors.push({
                path: fullPath,
                error: err?.message || String(err),
                code: err?.code,
              })
              continue
            }

            // Managed roots ONLY: never traverse outside managed root
            const isInside =
              realSubDir === canonicalRootDir ||
              realSubDir.startsWith(canonicalRootDir + '/') ||
              realSubDir.startsWith(canonicalRootDir + '\\')

            if (!isInside) {
              continue
            }

            if (visitedDirs.has(realSubDir)) {
              continue
            }

            if (depth < maxDepth) {
              if (dirQueue.length >= maxDirQueue) {
                errors.push({
                  path: currentDir,
                  error: `Storage inventory directory queue limit reached (${maxDirQueue})`,
                  code: 'EQUOTA',
                })
                continue
              }
              visitedDirs.add(realSubDir)
              dirQueue.push({ dirPath: realSubDir, depth: depth + 1 })
            } else {
              // Traversal depth reached maxDepth and an unvisited child directory exists:
              // Bounded traversal incomplete -> report EQUOTA so isDegraded = true
              errors.push({
                path: fullPath,
                error: `Storage inventory traversal depth limit reached (${maxDepth}): unvisited child directory at ${fullPath}`,
                code: 'EQUOTA',
              })
            }
          }
        } else if (entry.isSymbolicLink()) {
          let st: import('node:fs').Stats
          try {
            st = statSync(fullPath)
          } catch (err: any) {
            if (err && err.code === 'ENOENT') continue
            errors.push({
              path: fullPath,
              error: err?.message || String(err),
              code: err?.code,
            })
            continue
          }

          let realTarget: string
          try {
            realTarget = realpathSync(fullPath)
          } catch (err: any) {
            if (err && err.code === 'ENOENT') continue
            errors.push({
              path: fullPath,
              error: err?.message || String(err),
              code: err?.code,
            })
            continue
          }

          const isInside =
            realTarget === canonicalRootDir ||
            realTarget.startsWith(canonicalRootDir + '/') ||
            realTarget.startsWith(canonicalRootDir + '\\')

          if (!isInside) {
            continue
          }

          if (st.isDirectory()) {
            if (isRecursive) {
              if (visitedDirs.has(realTarget)) {
                continue
              }
              if (depth < maxDepth) {
                if (dirQueue.length >= maxDirQueue) {
                  errors.push({
                    path: fullPath,
                    error: `Storage inventory directory queue limit reached (${maxDirQueue})`,
                    code: 'EQUOTA',
                  })
                  continue
                }
                visitedDirs.add(realTarget)
                dirQueue.push({ dirPath: realTarget, depth: depth + 1 })
              } else {
                errors.push({
                  path: fullPath,
                  error: `Storage inventory traversal depth limit reached (${maxDepth}): unvisited child directory symlink at ${fullPath}`,
                  code: 'EQUOTA',
                })
              }
            }
          } else if (st.isFile()) {
            if (matcher(entry.name) || matcher(basename(realTarget))) {
              totalMatchedCount++
              if (totalMatchedCount > maxFileInventory) {
                errors.push({
                  path: currentDir,
                  error: `Storage inventory file count limit reached (${maxFileInventory})`,
                  code: 'EQUOTA',
                })
                limitReached = true
                break
              }
              const measured = measureFile(fullPath, visited, errors, visitedIdentities, maxVisitedEntries)
              if (measured.measured) {
                if (onFile) {
                  const res = onFile(measured, entry.name, fullPath)
                  if (res !== 'handled') {
                    total += measured.size
                    matchedFiles.push(measured.path)
                  }
                } else {
                  total += measured.size
                  matchedFiles.push(measured.path)
                }
              }
            }
          }
        } else if (entry.isFile()) {
          if (matcher(entry.name)) {
            totalMatchedCount++
            if (totalMatchedCount > maxFileInventory) {
              errors.push({
                path: currentDir,
                error: `Storage inventory file count limit reached (${maxFileInventory})`,
                code: 'EQUOTA',
              })
              limitReached = true
              break
            }
            const measured = measureFile(fullPath, visited, errors, visitedIdentities, maxVisitedEntries)
            if (measured.measured) {
              if (onFile) {
                const res = onFile(measured, entry.name, fullPath)
                if (res !== 'handled') {
                  total += measured.size
                  matchedFiles.push(measured.path)
                }
              } else {
                total += measured.size
                matchedFiles.push(measured.path)
              }
            }
          }
        }
      }
    } catch (err: any) {
      if (err && err.code !== 'ENOENT') {
        errors.push({
          path: currentDir,
          error: err?.message || String(err),
          code: err?.code,
        })
      }
    } finally {
      try {
        dirStream.closeSync()
      } catch {
        // ignore close errors
      }
    }
  }

  return { size: total, files: matchedFiles }
}

/**
 * Enterprise Storage Accounting for Document Search V3.
 *
 * Fully inventories:
 * - Active SQLite DB, WAL, SHM.
 * - ANN index paths (ann_indexes metadata and physical ann-<sanitized>.usearch in DB dir and vectorsDir).
 * - Temp rebuild files (*.tmp, *.tmp.*, *.usearch.tmp.*, migration temporary files).
 * - OCR external cache files (in-DB OCR is counted inside active DB, external files only counted if on disk; nested support).
 * - Sidecar storage: Owned index sidecar files counted managed once in cap.
 * - Backups discovered via retention state & helpers (with protected backup calculation; no delete / writeDB).
 * - Deduplication across canonical resolved paths and file identities (st.dev:st.ino).
 * - Degradation detection: EACCES/I/O errors are tracked and flag isDegraded=true (no silent 0 fake).
 * - DB Freelist reported as reusable space, not physical reclaimed bytes.
 * - Model weights / runtime reported separately and excluded from managed index quota (no model load).
 * - Off-main worker execution with bounded directory queues (no huge all-tree memory spikes).
 */
export function collectStorageAccounting(options: StorageAccountingOptions): StorageAccountingReport {
  const { dbPath } = options
  const baseDir = resolve(dirname(dbPath))
  const dbFileName = basename(dbPath)

  const maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : MAX_TRAVERSAL_DEPTH
  const maxDirQueue = typeof options.maxDirQueue === 'number' ? options.maxDirQueue : MAX_DIR_QUEUE_SIZE
  const maxVisitedEntries = typeof options.maxVisitedEntries === 'number' ? options.maxVisitedEntries : MAX_VISITED_ENTRIES
  const maxFileInventory = typeof options.maxFileInventory === 'number' ? options.maxFileInventory : MAX_FILE_INVENTORY

  const visitedPaths = new Set<string>()
  const visitedIdentities = new Set<string>()
  const measurementErrors: StorageAccountingError[] = []

  // 1. Active SQLite Database, WAL, and SHM
  const dbMeasured = measureFile(dbPath, visitedPaths, measurementErrors, visitedIdentities, maxVisitedEntries)
  const walMeasured = measureFile(`${dbPath}-wal`, visitedPaths, measurementErrors, visitedIdentities, maxVisitedEntries)
  const shmMeasured = measureFile(`${dbPath}-shm`, visitedPaths, measurementErrors, visitedIdentities, maxVisitedEntries)

  const dbSizeBytes = dbMeasured.size
  const walSizeBytes = walMeasured.size
  const shmSizeBytes = shmMeasured.size
  const databaseBytes = dbSizeBytes + walSizeBytes + shmSizeBytes

  // Check db file accessibility without swallowed existsSync
  let dbFileAccessible = false
  try {
    statSync(dbPath)
    dbFileAccessible = true
  } catch (err: any) {
    if (err && err.code !== 'ENOENT') {
      measurementErrors.push({
        path: dbPath,
        error: `Database file stat access error: ${err?.message || String(err)}`,
        code: err?.code,
      })
    }
  }

  let nameMetadataBytes: number | undefined
  if (dbFileAccessible || options.db) {
    try {
      nameMetadataBytes = measureNameMetadataBytes(dbPath, options.db)
    } catch (err) {
      measurementErrors.push({ path: dbPath, error: `Name metadata accounting failed: ${String(err)}`, code: 'ESQLITE' })
    }
  } else {
    // A not-yet-created database has no identity pages.
    nameMetadataBytes = 0
  }

  // 2. ANN Vector Index Storage (.usearch files)
  const annFiles: string[] = []
  let annSizeBytes = 0
  const vectorsDir = options.vectorsDir ? resolve(options.vectorsDir) : resolve(baseDir, 'vectors')

  // 2a. Query ann_indexes metadata if provided, from db handle, or via read-only handle
  let annMetaRows: Array<{ space_id: string; file_path: string | null }> | undefined = options.annIndexesMeta
  if (!annMetaRows && options.db) {
    try {
      annMetaRows = options.db
        .prepare('SELECT space_id, file_path FROM ann_indexes')
        .all() as Array<{ space_id: string; file_path: string | null }>
    } catch (err: any) {
      const msg = String(err?.message || err)
      const isTableMissing = /no such table:\s*["`']?ann_indexes["`']?/i.test(msg)
      if (!isTableMissing) {
        measurementErrors.push({
          path: dbPath,
          error: `Unexpected SQLite error querying ann_indexes: ${msg}`,
          code: err?.code || 'ESQLITE',
        })
      }
    }
  } else if (!annMetaRows && !options.db && dbFileAccessible) {
    try {
      const roDb = new DatabaseSync(dbPath, { readOnly: true })
      try {
        annMetaRows = roDb
          .prepare('SELECT space_id, file_path FROM ann_indexes')
          .all() as Array<{ space_id: string; file_path: string | null }>
      } finally {
        roDb.close()
      }
    } catch (err: any) {
      const msg = String(err?.message || err)
      const isTableMissing = /no such table:\s*["`']?ann_indexes["`']?/i.test(msg)
      if (!isTableMissing) {
        measurementErrors.push({
          path: dbPath,
          error: `Read-only SQLite query ann_indexes failed: ${msg}`,
          code: err?.code || 'ESQLITE',
        })
      }
    }
  }

  if (annMetaRows) {
    const allowedRoots = [baseDir, vectorsDir]
    // Compare realpath'd candidates against realpath'd roots: a managed root that itself sits behind
    // a symlink (macOS /var -> /private/var) must not make its own files look like boundary escapes.
    const canonicalRoots = allowedRoots.map((r) => {
      try {
        return realpathSync(r)
      } catch {
        return r
      }
    })
    for (const row of annMetaRows) {
      if (row.file_path) {
        const candidate = resolve(baseDir, row.file_path)
        const isLexicalInside = allowedRoots.some((r) => isPathInsideRoot(candidate, r))
        if (!isLexicalInside) {
          measurementErrors.push({
            path: candidate,
            error: `ANN metadata file_path '${row.file_path}' resolves outside managed root boundary`,
            code: 'EESCAPE',
          })
        } else {
          let canonicalCandidate: string | null = null
          try {
            canonicalCandidate = realpathSync(candidate)
          } catch (err: any) {
            if (err && err.code === 'ENOENT') {
              const fileName = basename(candidate)
              const isExpectedRebuildable =
                fileName.endsWith('.usearch') &&
                allowedRoots.some((r) => isPathInsideRoot(candidate, r))

              if (!isExpectedRebuildable) {
                measurementErrors.push({
                  path: candidate,
                  error: `ANN metadata file_path '${row.file_path}' does not exist on disk`,
                  code: 'ENOENT',
                })
              }
              // Legitimate rebuildable ANN index absent before build: measured as 0 bytes without deadlocking admission
            } else {
              measurementErrors.push({
                path: candidate,
                error: `ANN metadata file_path '${row.file_path}' realpath error: ${err?.message || String(err)}`,
                code: err?.code,
              })
            }
          }

          if (canonicalCandidate) {
            const isCanonicalInside = canonicalRoots.some((r) => isPathInsideRoot(canonicalCandidate!, r))
            if (!isCanonicalInside) {
              measurementErrors.push({
                path: candidate,
                error: `ANN metadata file_path '${row.file_path}' symlink escapes managed root boundary to ${canonicalCandidate}`,
                code: 'EESCAPE',
              })
            } else {
              const measured = measureFile(
                canonicalCandidate,
                visitedPaths,
                measurementErrors,
                visitedIdentities,
                maxVisitedEntries,
              )
              if (measured.measured) {
                annSizeBytes += measured.size
                annFiles.push(measured.path)
              }
            }
          }
        }
      }
      const sanitized = row.space_id.replace(/[^a-zA-Z0-9_.-]/g, '_')
      const defaultName = `ann-${sanitized}.usearch`
      const defaultCandidate = resolve(baseDir, defaultName)
      const measured = measureFile(
        defaultCandidate,
        visitedPaths,
        measurementErrors,
        visitedIdentities,
        maxVisitedEntries,
      )
      if (measured.measured) {
        annSizeBytes += measured.size
        annFiles.push(measured.path)
      }
    }
  }

  // 5. Temp files collection initialized early so vectorsDir temp rebuild files are captured
  const tempFiles: string[] = []
  let tempSizeBytes = 0

  // 2b. Scan vectors directory if configured or default vectors/ (recursive bounded scan)
  // Classify all managed files in dedicated vectorsDir:
  // - Rebuild/temp files (*.tmp, *.usearch.tmp) -> tempFiles / tempSizeBytes
  // - Active ANN index files (*.usearch) -> annFiles / annSizeBytes
  // - Other files -> tracked in annBytes so hidden bytes are NOT 0, with degraded report
  if (vectorsDir !== baseDir) {
    measureDirFilesMatching(
      vectorsDir,
      () => true,
      visitedPaths,
      measurementErrors,
      {
        recursive: true,
        maxDepth,
        maxDirQueue,
        maxVisitedEntries,
        maxFileInventory,
        onFile: (measured, name) => {
          if (isTempFile(name)) {
            tempSizeBytes += measured.size
            tempFiles.push(measured.path)
            return 'handled'
          } else if (name.endsWith('.usearch')) {
            annSizeBytes += measured.size
            annFiles.push(measured.path)
            return 'handled'
          } else {
            annSizeBytes += measured.size
            annFiles.push(measured.path)
            measurementErrors.push({
              path: measured.path,
              error: `Dedicated vectors directory contains unrecognized non-usearch file: ${name}`,
              code: 'EINCOMPLETE',
            })
            return 'handled'
          }
        },
      },
      visitedIdentities,
    )
  }

  // 2c. Scan base directory for any physical ann-*.usearch files (strictly 1-level in baseDir to protect unrelated files/folders)
  const baseAnnRes = measureDirFilesMatching(
    baseDir,
    (name) => name.startsWith('ann-') && name.endsWith('.usearch'),
    visitedPaths,
    measurementErrors,
    {
      recursive: false,
      maxDepth,
      maxDirQueue,
      maxVisitedEntries,
      maxFileInventory,
    },
    visitedIdentities,
  )
  annSizeBytes += baseAnnRes.size
  annFiles.push(...baseAnnRes.files)

  // 3. OCR storage: External cache only
  // (In-DB OCR is in SQLite DB file size; we never count internal tables as external files)
  const ocrFiles: string[] = []
  let ocrSizeBytes = 0

  const ocrDir = options.ocrDir ? resolve(options.ocrDir) : resolve(baseDir, 'ocr')
  if (ocrDir !== baseDir) {
    const ocrDirRes = measureDirFilesMatching(
      ocrDir,
      () => true,
      visitedPaths,
      measurementErrors,
      {
        recursive: true,
        maxDepth,
        maxDirQueue,
        maxVisitedEntries,
        maxFileInventory,
      },
      visitedIdentities,
    )
    ocrSizeBytes += ocrDirRes.size
    ocrFiles.push(...ocrDirRes.files)
  }

  const externalOcrDbPath = resolve(baseDir, `${dbFileName}.ocr.db`)
  const mDb = measureFile(externalOcrDbPath, visitedPaths, measurementErrors, visitedIdentities, maxVisitedEntries)
  if (mDb.measured) {
    ocrSizeBytes += mDb.size
    ocrFiles.push(mDb.path)
    const mWal = measureFile(`${externalOcrDbPath}-wal`, visitedPaths, measurementErrors, visitedIdentities, maxVisitedEntries)
    if (mWal.measured) {
      ocrSizeBytes += mWal.size
      ocrFiles.push(mWal.path)
    }
    const mShm = measureFile(`${externalOcrDbPath}-shm`, visitedPaths, measurementErrors, visitedIdentities, maxVisitedEntries)
    if (mShm.measured) {
      ocrSizeBytes += mShm.size
      ocrFiles.push(mShm.path)
    }
  }

  // 4. Sidecar files: Owned index sidecars (counted managed once in cap)
  const sidecarFiles: string[] = []
  let sidecarSizeBytes = 0
  const sidecarRes = measureDirFilesMatching(
    baseDir,
    (name) => (name.includes('.sidecar.') || name.endsWith('.sidecar.db')) && !isTempFile(name),
    visitedPaths,
    measurementErrors,
    {
      recursive: false,
      maxDepth,
      maxDirQueue,
      maxVisitedEntries,
      maxFileInventory,
    },
    visitedIdentities,
  )
  sidecarSizeBytes += sidecarRes.size
  sidecarFiles.push(...sidecarRes.files)

  // 5. Temp rebuild and migration files
  const tempDir = options.tempDir ? resolve(options.tempDir) : baseDir
  if (tempDir !== baseDir) {
    // Dedicated temp directory: ALL files in it are scratch / temporary files!
    // (including scratch/page.png without .tmp extension)
    const tempDirRes = measureDirFilesMatching(
      tempDir,
      () => true,
      visitedPaths,
      measurementErrors,
      {
        recursive: true,
        maxDepth,
        maxDirQueue,
        maxVisitedEntries,
        maxFileInventory,
      },
      visitedIdentities,
    )
    tempSizeBytes += tempDirRes.size
    tempFiles.push(...tempDirRes.files)
  }

  const baseTempRes = measureDirFilesMatching(
    baseDir,
    isTempFile,
    visitedPaths,
    measurementErrors,
    {
      recursive: false,
      maxDepth,
      maxDirQueue,
      maxVisitedEntries,
      maxFileInventory,
    },
    visitedIdentities,
  )
  tempSizeBytes += baseTempRes.size
  tempFiles.push(...baseTempRes.files)

  // 6. Backup accounting via retention state and helpers (preserving protected rules, no delete / writeDB)
  const backupFiles: string[] = []
  let backupSizeBytes = 0
  let protectedBytes = 0

  const retentionDiagErrors: StorageAccountingError[] = []
  const retentionState = readV3RetentionState(dbPath, retentionDiagErrors)
  if (retentionDiagErrors.length > 0) {
    measurementErrors.push(...retentionDiagErrors)
  }

  const backupDiagErrors: StorageAccountingError[] = []
  const candidateBackups = findAllV2Backups(baseDir, dbFileName, retentionState, {
    errorCollector: backupDiagErrors,
    maxEntries: maxFileInventory,
  })
  if (backupDiagErrors.length > 0) {
    measurementErrors.push(...backupDiagErrors)
  }
  const now = Date.now()
  const minAgeMs = MIN_BACKUP_AGE_HOURS * 60 * 60 * 1000

  // Ensure canonical backup path and tracked rollback backup are checked
  const canonicalBackup = getCanonicalBackupPath(dbPath)
  const allBackupCandidates = new Map<string, { path: string; mtimeMs: number }>()

  for (const c of candidateBackups) {
    allBackupCandidates.set(resolve(c.path), c)
  }
  if (canonicalBackup && !allBackupCandidates.has(resolve(canonicalBackup))) {
    allBackupCandidates.set(resolve(canonicalBackup), {
      path: canonicalBackup,
      mtimeMs: getBackupCreationTime(canonicalBackup, retentionState),
    })
  }
  if (retentionState?.backupPath && !allBackupCandidates.has(resolve(retentionState.backupPath))) {
    allBackupCandidates.set(resolve(retentionState.backupPath), {
      path: retentionState.backupPath,
      mtimeMs: getBackupCreationTime(retentionState.backupPath, retentionState),
    })
  }

  let verifiedBackupCount = 0
  for (const item of allBackupCandidates.values()) {
    // Avoid counting temporary backup in-progress files as completed backups
    if (isTempFile(basename(item.path))) {
      continue
    }

    const measured = measureFile(item.path, visitedPaths, measurementErrors, visitedIdentities, maxVisitedEntries)
    if (measured.measured) {
      backupSizeBytes += measured.size
      backupFiles.push(measured.path)

      const effectiveCreatedAt = getBackupCreationTime(item.path, retentionState)
      const ageMs = now - effectiveCreatedAt
      const isYoung = ageMs < minAgeMs

      const isTrackedRollback =
        retentionState?.backupPath &&
        resolve(item.path) === resolve(retentionState.backupPath)

      const needsLaunchProtection =
        Boolean(isTrackedRollback) && (retentionState?.verifiedLaunches ?? 0) < 3

      let isProtected = false
      if (isYoung || needsLaunchProtection) {
        isProtected = true
      } else {
        const verified = isBackupVerified(item.path)
        if (verified) {
          if (verifiedBackupCount < MIN_VERIFIED_BACKUPS) {
            isProtected = true
            verifiedBackupCount++
          }
        } else if (verifiedBackupCount < MIN_VERIFIED_BACKUPS) {
          isProtected = true
        }
      }

      if (isProtected) {
        protectedBytes += measured.size
      }
    }
  }

  // Owned backup manifest and retention state JSON files: count totalManagedBytes, not hidden bytes
  const ownedMetadataFiles = [
    join(baseDir, 'document-memory.migration-state.json'),
    join(baseDir, 'document-memory.migration-state.json.tmp'),
    join(baseDir, 'v3-retention-state.json'),
    join(baseDir, 'document-memory.v3-retention.json'),
  ]
  for (const metaFile of ownedMetadataFiles) {
    const measuredMeta = measureFile(
      metaFile,
      visitedPaths,
      measurementErrors,
      visitedIdentities,
      maxVisitedEntries,
    )
    if (measuredMeta.measured) {
      backupSizeBytes += measuredMeta.size
      backupFiles.push(measuredMeta.path)
    }
  }

  // 7. DB Freelist reusable space inspection
  let reusableFreelistBytes = options.reusableFreelistBytes ?? 0
  if (options.reusableFreelistBytes === undefined) {
    if (options.db) {
      try {
        const freelistStats = getStorageFreelistStats(options.db)
        reusableFreelistBytes = freelistStats.reclaimableBytes
      } catch (err: any) {
        measurementErrors.push({
          path: dbPath,
          error: `Unexpected SQLite error querying freelist: ${err?.message || String(err)}`,
          code: err?.code,
        })
      }
    } else if (dbFileAccessible) {
      try {
        const roDb = new DatabaseSync(dbPath, { readOnly: true })
        try {
          const freelistStats = getStorageFreelistStats(roDb)
          reusableFreelistBytes = freelistStats.reclaimableBytes
        } finally {
          roDb.close()
        }
      } catch (err: any) {
        measurementErrors.push({
          path: dbPath,
          error: `Read-only SQLite query freelist failed: ${err?.message || String(err)}`,
          code: err?.code,
        })
      }
    }
  }

  // 8. Model weights and runtime (reported separately, never part of managed index quota; do NOT load model)
  // Uses independent identity set to avoid shared dedup skipping model files.
  // Overlap guards ensure we never scan user sources or double-count managed quota.
  let modelWeightsBytes = 0
  if (options.modelDir) {
    const resolvedModelDir = resolve(options.modelDir)
    if (resolvedModelDir === baseDir) {
      measurementErrors.push({
        path: resolvedModelDir,
        error: 'modelDir cannot be identical to baseDir to prevent scanning unmanaged user sources',
        code: 'EINVAL',
      })
    } else if (isPathInsideRoot(baseDir, resolvedModelDir)) {
      measurementErrors.push({
        path: resolvedModelDir,
        error: 'modelDir cannot encompass baseDir to prevent duplicate quota accounting',
        code: 'EINVAL',
      })
    } else {
      const modelErrors: StorageAccountingError[] = []
      const modelVisitedPaths = new Set<string>()
      const modelVisitedIdentities = new Set<string>()
      const mRes = measureDirFilesMatching(
        resolvedModelDir,
        () => true,
        modelVisitedPaths,
        modelErrors,
        {
          recursive: true,
          maxDepth,
          maxDirQueue,
          maxVisitedEntries,
          maxFileInventory,
        },
        modelVisitedIdentities,
      )
      modelWeightsBytes = mRes.size
      if (modelErrors.length > 0) {
        measurementErrors.push(...modelErrors)
      }
    }
  }

  // Total managed physical bytes across all document-index components.
  // Owned index sidecars are counted managed once in cap!
  const totalManagedBytes =
    databaseBytes + annSizeBytes + ocrSizeBytes + sidecarSizeBytes + tempSizeBytes + backupSizeBytes

  // Total tracked bytes includes total managed bytes (model weights remain separate)
  const totalTrackedBytes = totalManagedBytes

  const breakdown: StorageAccountingBreakdown = {
    activeDbBytes: dbSizeBytes,
    walBytes: walSizeBytes,
    shmBytes: shmSizeBytes,
    annBytes: annSizeBytes,
    ocrExternalBytes: ocrSizeBytes,
    tempBytes: tempSizeBytes,
    backupBytes: backupSizeBytes,
    protectedBackupBytes: protectedBytes,
    reusableFreelistBytes,
    modelWeightsBytes,
    sidecarBytes: sidecarSizeBytes,
  }

  return {
    databaseBytes,
    nameMetadataBytes,
    dbSizeBytes,
    walSizeBytes,
    shmSizeBytes,
    sidecarSizeBytes,
    annSizeBytes,
    ocrSizeBytes,
    tempSizeBytes,
    backupSizeBytes,
    protectedBytes,
    totalManagedBytes,
    totalTrackedBytes,
    reclaimableBytes: reusableFreelistBytes,
    reusableFreelistBytes,
    modelWeightsBytes,
    breakdown,
    annFiles,
    backupFiles,
    tempFiles,
    ocrFiles,
    sidecarFiles,
    measurementErrors,
    isDegraded: measurementErrors.length > 0,
    timestamp: Date.now(),
    lastAttemptTimestamp: Date.now(),
  }
}
