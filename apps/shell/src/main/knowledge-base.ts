/// Knowledge-base channel: the reader's starred files (the star corpus) as
/// AI can search and read, so an answer can cite the folder and file it came
/// from. Lives in the shell main process because that is the one place that
/// already holds both halves — the starred list (readStarredFiles, docs-main)
/// and the full-text index (file-index). The handlers are app-agnostic IPC;
/// docs wires them into its AI panel first, the other apps can follow.
///
/// Why search filters in JS rather than in SQLite: the FTS index's path column
/// stores tokenized FOLDER names (see store.ts upsert), not real paths, so a
/// `path IN (...)` cannot express "within the starred set". Starred corpora
/// are small (a reader's hand-picked files), and the indexed whole is local,
/// so fetching a bounded page and filtering by real path is the cheap,
/// correct filter.

import { statSync, existsSync, constants, promises as fsPromises } from 'node:fs'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import { parseFileToText } from '@genoffice/file-parse'

/** characters of parsed text one read_knowledge_file page returns (aligned
 *  with the chat-attachment reader, files-skill.ts, so models meet one paging
 *  convention everywhere) */
export const KB_READ_CHUNK_CHARS = 24_000

/** byte cap per corpus file, aligned with the chat-attachment reader's
 *  ATTACHMENT_MAX_BYTES: a larger file is refused before parse rather than
 *  parsed and held in the text cache */
export const KB_READ_MAX_BYTES = 50 * 1024 * 1024

/** query cap, same as the home search box */
const KB_QUERY_MAX_CHARS = 200

/** how many indexed hits to fetch before filtering to the starred set */
const KB_SEARCH_POOL = 200

/** one corpus entry as the AI (and the panel) sees it */
export interface KbFile {
  /** absolute path — also the citation target (filenav:///abs/path) */
  path: string
  /** owning folder name ("contracts" in /Users/me/contracts/lease.docx) */
  folder: string
  /** absolute folder path */
  folderPath: string
  name: string
  ext: string
  sizeBytes: number
}

/** search result as the model sees it */
export interface KbSearchHit {
  path: string
  name: string
  ext: string
  folder: string
  snippet: string
}

/** text extraction cache, keyed by path, invalidated by mtime+size */
const kbTextCache = new Map<string, { stamp: string; text: string }>()
const KB_TEXT_CACHE_MAX = 8

/** the corpus: every starred file that still exists on disk */
export function listKnowledgeFiles(starredPaths: readonly string[]): KbFile[] {
  const out: KbFile[] = []
  for (const path of starredPaths) {
    try {
      const stat = statSync(path)
      if (!stat.isFile()) continue
      const folderPath = dirname(path)
      out.push({
        path,
        folder: basename(folderPath),
        folderPath,
        name: basename(path),
        ext: basename(path)
          .replace(/^[^.]*./, '')
          .toLowerCase(),
        sizeBytes: stat.size,
      })
    } catch {
      // a starred path can outlive its file (r158 keeps the dimmed row in the
      // home UI); for the corpus it simply drops out
    }
  }
  return out
}

/** fetch + filter + trim one search page; pure so it is unit-testable */
export function searchKnowledgeBase(
  search: (
    q: string,
    limit: number,
  ) => ReadonlyArray<{ path: string; name: string; ext: string; snippetText?: string }>,
  query: string,
  starredPaths: readonly string[],
  limit: number,
): KbSearchHit[] {
  const q = query.trim().slice(0, KB_QUERY_MAX_CHARS)
  if (!q) return []
  const starred = new Set(starredPaths)
  const pool = search(q, KB_SEARCH_POOL)
  const seen = new Set<string>()
  const out: KbSearchHit[] = []
  for (const hit of pool) {
    if (!starred.has(hit.path) || seen.has(hit.path)) continue
    seen.add(hit.path)
    out.push({
      path: hit.path,
      name: hit.name,
      ext: hit.ext,
      folder: basename(dirname(hit.path)),
      snippet: hit.snippetText ?? '',
    })
    if (out.length >= limit) break
  }
  return out
}

/** parsed text of one corpus file; throws with a plain message the panel can
 *  show — shell main has no i18n channel of its own (unlike the docs
 *  attachment reader, whose errors carry locale strings and a larger budget) */
export async function readKnowledgeFileText(filePath: string): Promise<string> {
  const stat = statSync(filePath)
  const stamp = `${stat.mtimeMs}:${stat.size}`
  const cached = kbTextCache.get(filePath)
  if (cached && cached.stamp === stamp) return cached.text
  if (stat.size > KB_READ_MAX_BYTES) {
    throw new Error(
      `file too large to read (${Math.round(stat.size / 1024 / 1024)}MB, cap ${KB_READ_MAX_BYTES / 1024 / 1024}MB)`,
    )
  }
  const parsed = await parseFileToText(filePath)
  if (!parsed.ok || parsed.kind !== 'text' || parsed.text == null) {
    throw new Error(parsed.error ?? 'unreadable file')
  }
  kbTextCache.set(filePath, { stamp, text: parsed.text })
  if (kbTextCache.size > KB_TEXT_CACHE_MAX) {
    const oldest = kbTextCache.keys().next().value
    if (oldest) kbTextCache.delete(oldest)
  }
  return parsed.text
}

/** one page of a corpus file's text */
export interface KbReadPage {
  text: string
  /** total parsed characters, so the reader knows whether to page on */
  totalChars: number
  offset: number
}

export async function readKnowledgeFilePage(filePath: string, offset: number): Promise<KbReadPage> {
  const text = await readKnowledgeFileText(filePath)
  const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
  if (start >= text.length) return { text: '', totalChars: text.length, offset: start }
  return {
    text: text.slice(start, start + KB_READ_CHUNK_CHARS),
    totalChars: text.length,
    offset: start,
  }
}

// ---- create_document: the ask panel's one write path ----

export type KbCreateFormat = 'md' | 'docx'

export interface KbCreateRequest {
  title: string
  format: KbCreateFormat
  content: string
  sessionId?: string
  userTurnId?: string
  documentSlot?: string
  callId?: string
  documentType?: string
}

/** keep in step with CREATE_DOCUMENT_MAX_CHARS in agent-core */
export const KB_CREATE_MAX_CHARS = 2_000_000

/** validate the renderer's payload; throws a plain message for the panel */
export function parseKbCreateRequest(raw: unknown): KbCreateRequest {
  const req = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const format = req.format
  if (format !== 'md' && format !== 'docx') throw new Error('format must be "md" or "docx"')
  const content = typeof req.content === 'string' ? req.content : ''
  if (!content.trim()) throw new Error('content must not be empty')
  if (content.length > KB_CREATE_MAX_CHARS) throw new Error('content is too long')
  const title = typeof req.title === 'string' ? req.title : ''
  const sessionId = typeof req.sessionId === 'string' ? req.sessionId : undefined
  const userTurnId = typeof req.userTurnId === 'string' ? req.userTurnId : undefined
  const documentSlot = typeof req.documentSlot === 'string' ? req.documentSlot : undefined
  const callId = typeof req.callId === 'string' ? req.callId : undefined
  const documentType = typeof req.documentType === 'string' ? req.documentType : undefined
  return { title, format, content, sessionId, userTurnId, documentSlot, callId, documentType }
}

export interface KbCreateDeps {
  /** folder new files land in */
  dir: () => string
  /** `${sanitized title}${ext}` → first free absolute path in dir */
  uniquePath: (dir: string, fileName: string) => string
  sanitizeBase: (title: string) => string
  writeText: (path: string, text: string) => Promise<void>
  /** markdown → .docx at `out` (the bundled CLI) */
  markdownToDocx: (markdown: string, out: string, documentType?: string) => Promise<void>
  recordRecent: (path: string) => void
  fileExists?: (path: string) => boolean
  isCaseSensitive?: boolean
  publishExclusive?: (tmpPath: string, destPath: string) => Promise<void>
  /** size/mtime of a file, null when missing (rewrite: detect edits made outside the chat) */
  statFile?: (path: string) => KbFileStamp | null
  /** rewrite: move the finished temp file over the document (default fs.rename) */
  replaceFile?: (tmpPath: string, destPath: string) => Promise<void>
}

/** Shared content writer for create_document and approved document merges. */
export async function writeKnowledgeDocumentContent(
  deps: KbCreateDeps,
  req: Pick<KbCreateRequest, 'format' | 'content' | 'documentType'>,
  out: string,
): Promise<void> {
  if (req.content.length > KB_CREATE_MAX_CHARS) throw new Error('content is too long')
  if (req.format === 'md') await deps.writeText(out, req.content)
  else await deps.markdownToDocx(req.content, out, req.documentType)
}

interface CommittedDocCreation {
  path: string
  createdAt: number
  payloadFingerprint: string
  sessionId?: string | undefined
  userTurnId?: string | undefined
  slot?: string | undefined
}

interface InFlightDocCreation {
  promise: Promise<{ path: string }>
  payloadFingerprint: string
  sessionId?: string | undefined
  userTurnId?: string | undefined
  slot?: string | undefined
}

export function pathReservationKey(filePath: string, caseSensitive?: boolean): string {
  const isCaseSens =
    caseSensitive !== undefined
      ? caseSensitive
      : process.platform !== 'win32' && process.platform !== 'darwin'
  const normalized = normalize(resolve(filePath)).normalize('NFC')
  return isCaseSens ? normalized : normalized.toLowerCase()
}

const inFlightDocCreations = new Map<string, InFlightDocCreation>()
const committedDocCreations = new Map<string, CommittedDocCreation>()
const reservedPaths = new Set<string>()
const reservedCanonicalKeys = new Set<string>()

/**
 * Files kb:create-document wrote during this app run: the only ones kb:rewrite-document may
 * replace. `stamp` is the size/mtime of our last write, so a file the user saved from the
 * editor in the meantime is never overwritten.
 */
interface CreatedDocumentFile {
  path: string
  format: KbCreateFormat
  stamp?: KbFileStamp | null
}
const createdDocumentFiles = new Map<string, CreatedDocumentFile>()
const rewriteQueues = new Map<string, Promise<unknown>>()

export function clearKnowledgeDocumentCaches(): void {
  inFlightDocCreations.clear()
  committedDocCreations.clear()
  reservedPaths.clear()
  reservedCanonicalKeys.clear()
  createdDocumentFiles.clear()
  rewriteQueues.clear()
}

export interface KbFileStamp {
  size: number
  mtimeMs: number
}

function noteCreatedDocument(deps: KbCreateDeps, path: string, format: KbCreateFormat): void {
  const key = pathReservationKey(path, deps.isCaseSensitive)
  if (createdDocumentFiles.size >= 200) {
    const oldest = createdDocumentFiles.keys().next().value
    if (oldest !== undefined) createdDocumentFiles.delete(oldest)
  }
  createdDocumentFiles.set(key, { path, format, stamp: deps.statFile?.(path) ?? null })
}

// ---- append_to_document: replace a just-created document with its grown Markdown ----

export interface KbRewriteRequest {
  path: string
  format: KbCreateFormat
  /** the whole document as Markdown */
  content: string
  documentType?: string
}

export function parseKbRewriteRequest(raw: unknown): KbRewriteRequest {
  const req = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const path = typeof req.path === 'string' ? req.path : ''
  if (!path.trim()) throw new Error('path is required')
  const format = req.format
  if (format !== 'md' && format !== 'docx') throw new Error('format must be "md" or "docx"')
  const content = typeof req.content === 'string' ? req.content : ''
  if (!content.trim()) throw new Error('content must not be empty')
  if (content.length > KB_CREATE_MAX_CHARS) throw new Error('content is too long')
  const documentType = typeof req.documentType === 'string' ? req.documentType : undefined
  return { path, format, content, ...(documentType ? { documentType } : {}) }
}

/**
 * Rewrite a document kb:create-document wrote in this app run with its full, grown Markdown.
 * The new bytes are produced next to the file and moved over it in one rename, so a reader never
 * sees half a document; a .docx is regenerated from the Markdown (no in-place Word patching).
 * Refuses any path this run did not create, a format change, and a file changed on disk since
 * our last write. Calls for one path run one after another.
 */
export async function rewriteKnowledgeDocument(
  deps: KbCreateDeps,
  req: KbRewriteRequest,
): Promise<{ path: string }> {
  const key = pathReservationKey(req.path, deps.isCaseSensitive)
  const entry = createdDocumentFiles.get(key)
  if (!entry) throw new Error('this file was not created by create_document in this session')
  if (entry.format !== req.format) throw new Error('format does not match the created document')
  const previous = rewriteQueues.get(key) ?? Promise.resolve()
  const run = previous.then(async () => {
    const target = entry.path
    if (deps.statFile) {
      const current = deps.statFile(target)
      if (!current) throw new Error('the document no longer exists')
      if (
        entry.stamp &&
        (current.size !== entry.stamp.size || current.mtimeMs !== entry.stamp.mtimeMs)
      ) {
        throw new Error('the document was changed outside this chat, so it was not overwritten')
      }
    } else if (!(deps.fileExists ?? existsSync)(target)) {
      throw new Error('the document no longer exists')
    }
    const ext = req.format === 'docx' ? '.docx' : '.md'
    const tmpPath = join(
      dirname(target),
      `.${basename(target, ext)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp${ext}`,
    )
    try {
      if (req.format === 'md') await deps.writeText(tmpPath, req.content)
      else await deps.markdownToDocx(req.content, tmpPath, req.documentType)
      await (deps.replaceFile ?? ((from, to) => fsPromises.rename(from, to)))(tmpPath, target)
    } finally {
      const leftover = deps.fileExists ? deps.fileExists(tmpPath) : existsSync(tmpPath)
      if (leftover) await fsPromises.unlink(tmpPath).catch(() => {})
    }
    entry.stamp = deps.statFile?.(target) ?? null
    return { path: target }
  })
  const settled = run.catch(() => undefined)
  rewriteQueues.set(key, settled)
  try {
    return await run
  } finally {
    if (rewriteQueues.get(key) === settled) rewriteQueues.delete(key)
  }
}

function allocateUniquePath(deps: KbCreateDeps, title: string, format: string): string {
  const dir = deps.dir()
  const base = deps.sanitizeBase(title)
  const isCaseSens = deps.isCaseSensitive
  const checkExists = deps.fileExists ?? existsSync

  const isAvailable = (candidate: string) => {
    const key = pathReservationKey(candidate, isCaseSens)
    if (reservedPaths.has(candidate) || reservedCanonicalKeys.has(key)) {
      return false
    }
    if (checkExists(candidate)) {
      return false
    }
    return true
  }

  let candidate = deps.uniquePath(dir, `${base}.${format}`)
  let i = 2
  while (!isAvailable(candidate)) {
    candidate = deps.uniquePath(dir, `${base}-${i}.${format}`)
    if (!isAvailable(candidate)) {
      const altCandidate = deps.uniquePath(dir, `${base} (${i}).${format}`)
      if (isAvailable(altCandidate)) {
        candidate = altCandidate
        break
      }
    } else {
      break
    }
    i++
  }
  reservedPaths.add(candidate)
  reservedCanonicalKeys.add(pathReservationKey(candidate, isCaseSens))
  return candidate
}

/**
 * Atomically publishes `tmpPath` to `destPath` without replacing an existing file.
 * Fails with EEXIST if `destPath` already exists.
 * Uses hard link (`fs.promises.link`) where supported, which is atomic and fails if dest exists.
 * Falls back to `fs.promises.copyFile(..., COPYFILE_EXCL)` on filesystems without hard link support.
 * Cleans up `tmpPath` on completion.
 */
export async function publishFileExclusive(tmpPath: string, destPath: string): Promise<void> {
  try {
    await fsPromises.link(tmpPath, destPath)
    await fsPromises.unlink(tmpPath).catch(() => {})
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException
    if (error && error.code === 'EEXIST') {
      await fsPromises.unlink(tmpPath).catch(() => {})
      throw error
    }
    if (
      error &&
      (error.code === 'EXDEV' ||
        error.code === 'EPERM' ||
        error.code === 'ENOTSUP' ||
        error.code === 'ENOSYS')
    ) {
      try {
        await fsPromises.copyFile(tmpPath, destPath, constants.COPYFILE_EXCL)
        await fsPromises.unlink(tmpPath).catch(() => {})
        return
      } catch (copyErr) {
        await fsPromises.unlink(tmpPath).catch(() => {})
        throw copyErr
      }
    }
    await fsPromises.unlink(tmpPath).catch(() => {})
    throw error
  }
}

export async function createKnowledgeDocument(
  deps: KbCreateDeps,
  req: KbCreateRequest,
): Promise<{ path: string }> {
  const hostOpId = req.callId || req.documentSlot || undefined
  const slotKey =
    req.sessionId && req.userTurnId && hostOpId
      ? `${req.sessionId}:${req.userTurnId}:${hostOpId}`
      : null

  const payloadFingerprint = JSON.stringify({
    title: req.title || 'Untitled',
    format: req.format,
    content: req.content,
    documentType: req.documentType ?? null,
  })

  if (slotKey) {
    const cached = committedDocCreations.get(slotKey)
    const checkExists = deps.fileExists ?? existsSync
    if (cached) {
      if (cached.payloadFingerprint !== payloadFingerprint) {
        throw new Error('Operation identity conflict: conflicting payload for slot')
      }
      if (checkExists(cached.path)) {
        return { path: cached.path }
      } else {
        committedDocCreations.delete(slotKey)
      }
    }
    const inFlight = inFlightDocCreations.get(slotKey)
    if (inFlight) {
      if (inFlight.payloadFingerprint !== payloadFingerprint) {
        throw new Error('Operation identity conflict: conflicting payload for slot')
      }
      return inFlight.promise
    }
  }

  if (req.sessionId && req.userTurnId) {
    const targetSlot = req.documentSlot || 'primary'
    const checkExists = deps.fileExists ?? existsSync
    for (const [key, cached] of committedDocCreations.entries()) {
      if (
        cached.sessionId === req.sessionId &&
        cached.userTurnId === req.userTurnId &&
        cached.slot === targetSlot &&
        cached.payloadFingerprint === payloadFingerprint
      ) {
        if (checkExists(cached.path)) {
          return { path: cached.path }
        } else {
          committedDocCreations.delete(key)
        }
      }
    }
    for (const inFlight of inFlightDocCreations.values()) {
      if (
        inFlight.sessionId === req.sessionId &&
        inFlight.userTurnId === req.userTurnId &&
        inFlight.slot === targetSlot &&
        inFlight.payloadFingerprint === payloadFingerprint
      ) {
        return inFlight.promise
      }
    }
  }

  const opPromise = (async () => {
    let targetPath = allocateUniquePath(deps, req.title, req.format)
    try {
      const checkExists = deps.fileExists ?? existsSync
      while (checkExists(targetPath)) {
        reservedPaths.delete(targetPath)
        reservedCanonicalKeys.delete(pathReservationKey(targetPath, deps.isCaseSensitive))
        targetPath = allocateUniquePath(deps, req.title, req.format)
      }

      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          if (checkExists(targetPath) && attempt > 0) {
            reservedPaths.delete(targetPath)
            reservedCanonicalKeys.delete(pathReservationKey(targetPath, deps.isCaseSensitive))
            targetPath = allocateUniquePath(deps, req.title, req.format)
          }

          if (deps.publishExclusive) {
            const ext = req.format === 'docx' ? '.docx' : '.md'
            const tmpName = `.${basename(targetPath, ext)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp${ext}`
            const tmpPath = join(dirname(targetPath), tmpName)
            try {
              await writeKnowledgeDocumentContent(deps, req, tmpPath)
              await deps.publishExclusive(tmpPath, targetPath)
            } finally {
              const exists = deps.fileExists ? deps.fileExists(tmpPath) : existsSync(tmpPath)
              if (exists) {
                await fsPromises.unlink(tmpPath).catch(() => {})
              }
            }
          } else if (deps.fileExists) {
            // Simulated / in-memory test environment: verify targetPath doesn't exist on mock disk before write
            if (deps.fileExists(targetPath)) {
              const err = new Error(
                `EEXIST: file already exists, open '${targetPath}'`,
              ) as NodeJS.ErrnoException
              err.code = 'EEXIST'
              throw err
            }
            await writeKnowledgeDocumentContent(deps, req, targetPath)
          } else {
            // Real filesystem environment (production): use exclusive same-directory temp file + atomic publish
            const ext = req.format === 'docx' ? '.docx' : '.md'
            const tmpName = `.${basename(targetPath, ext)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp${ext}`
            const tmpPath = join(dirname(targetPath), tmpName)
            try {
              await writeKnowledgeDocumentContent(deps, req, tmpPath)
              await publishFileExclusive(tmpPath, targetPath)
            } finally {
              if (existsSync(tmpPath)) {
                await fsPromises.unlink(tmpPath).catch(() => {})
              }
            }
          }
          break
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if ((msg.includes('output exists') || msg.includes('EEXIST')) && attempt < 9) {
            reservedPaths.delete(targetPath)
            reservedCanonicalKeys.delete(pathReservationKey(targetPath, deps.isCaseSensitive))
            targetPath = allocateUniquePath(deps, req.title, req.format)
            continue
          }
          throw err
        }
      }

      if (slotKey) {
        if (committedDocCreations.size >= 100) {
          const oldest = committedDocCreations.keys().next().value
          if (oldest !== undefined) committedDocCreations.delete(oldest)
        }
        committedDocCreations.set(slotKey, {
          path: targetPath,
          createdAt: Date.now(),
          payloadFingerprint,
          sessionId: req.sessionId,
          userTurnId: req.userTurnId,
          slot: req.documentSlot || 'primary',
        })
      }
      noteCreatedDocument(deps, targetPath, req.format)

      try {
        deps.recordRecent(targetPath)
      } catch (err) {
        console.warn(
          'Non-fatal: failed to record document in recent list:',
          err instanceof Error ? err.message : String(err),
        )
      }

      return { path: targetPath }
    } finally {
      reservedPaths.delete(targetPath)
      reservedCanonicalKeys.delete(pathReservationKey(targetPath, deps.isCaseSensitive))
    }
  })()

  if (slotKey) {
    inFlightDocCreations.set(slotKey, {
      promise: opPromise,
      payloadFingerprint,
      sessionId: req.sessionId,
      userTurnId: req.userTurnId,
      slot: req.documentSlot || 'primary',
    })
  }

  try {
    return await opPromise
  } finally {
    if (slotKey) {
      inFlightDocCreations.delete(slotKey)
    }
  }
}
