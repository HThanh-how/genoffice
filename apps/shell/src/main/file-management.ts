import {
  copyFileSync,
  constants,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  FILE_TOOL_NAMES,
  type FileAction,
  type FileActionProposal,
  type PendingFileAction,
} from '@genoffice/agent-core'
import { isInsideRoot } from './folder-tree'
import { isPathIgnored, isRestrictedRoot } from './document-memory/ignore-policy'
import { isJunkFileName, shouldSkipDirectory } from './document-memory/scan-policy'
import { isValidRawRenameName } from './rename-validation'

export const FILE_ACTION_MAX_BYTES = 128 * 1024 * 1024
export const FILE_ACTION_LIST_LIMIT = 200
export const FILE_ACTION_TTL_MS = 5 * 60 * 1000

export interface FileManagementDeps {
  roots(): string[]
  userData(): string
  trashItem(path: string): Promise<void>
  exportPdf(input: string, output: string): Promise<void>
  now?: () => number
}

function statOrMissing(path: string) {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function identity(path: string, content: boolean): string {
  const s = lstatSync(path)
  return JSON.stringify([s.dev, s.ino, ...(content ? [s.size, s.mtimeMs, s.ctimeMs] : [])])
}

/** No recursive mutations. All checks run again after the user's decision. */
export class FileManagementService {
  private pending = new Map<
    string,
    { owner: number; proposal: PendingFileAction; fingerprint: string }
  >()
  constructor(private deps: FileManagementDeps) {}

  private path(raw: unknown, missing = false): string {
    if (
      typeof raw !== 'string' ||
      raw.length > 4096 ||
      !isAbsolute(raw) ||
      raw.includes('\0') ||
      raw.split(/[\\/]/).includes('..') ||
      // Device/UNC paths and alternate data streams have ambiguous containment on Windows.
      (process.platform === 'win32' && (/^[\\/]{2}/.test(raw) || raw.slice(2).includes(':')))
    )
      throw new Error('An absolute local path without traversal is required')
    const path = resolve(raw)
    const root = this.deps.roots().find((r) => isInsideRoot(r, path))
    if (!root) throw new Error('Path is outside allowed folders')
    const canonicalRoot = realpathSync.native(root)
    const rel = relative(resolve(root), path)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path is outside allowed folders')
    const parts = rel ? rel.split(sep) : []
    if (parts.some((p) => !isValidRawRenameName(p))) throw new Error('Invalid path component')
    if (missing && statOrMissing(path)) throw new Error('Destination already exists')
    const existing = missing ? dirname(path) : path
    const canonical = realpathSync.native(existing)
    if (!isInsideRoot(canonicalRoot, canonical)) throw new Error('Symlink escapes allowed folders')
    // Reject aliases even within a root: the permission card names exactly what will be changed.
    let probe = resolve(root)
    if (lstatSync(probe).isSymbolicLink()) throw new Error('Symlink roots are unsupported')
    for (const part of parts) {
      probe = join(probe, part)
      const stat = statOrMissing(probe)
      if (stat?.isSymbolicLink()) throw new Error('Symlinks are unsupported')
      if (shouldSkipDirectory(part) || isJunkFileName(part)) throw new Error('Path is excluded')
    }
    const protectedPaths = [
      this.deps.userData(),
      ...[
        process.env.SystemRoot,
        process.env.ProgramFiles,
        process.env['ProgramFiles(x86)'],
        process.env.ProgramData,
      ].filter((p): p is string => !!p && isAbsolute(p)),
      ...(process.platform === 'win32'
        ? []
        : ['/dev', '/proc', '/sys', '/boot', '/run', '/var', '/opt']),
    ]
    // Check lexical and real paths; a configured root can itself have aliased ancestors.
    for (const p of [path, canonical]) {
      if (isRestrictedRoot(p) || protectedPaths.some((blocked) => isInsideRoot(blocked, p))) {
        throw new Error('System and application data paths are forbidden')
      }
    }
    if (
      isPathIgnored(path, root) ||
      isPathIgnored(join(canonical, missing ? basename(path) : ''), canonicalRoot)
    ) {
      throw new Error('Path is excluded by indexing policy')
    }
    if (missing) {
      if (!lstatSync(dirname(path)).isDirectory()) throw new Error('Parent must be a directory')
      if (statOrMissing(path)) throw new Error('Destination already exists')
    }
    return path
  }

  private check(raw: unknown): { action: FileAction; fingerprint: string } {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid file action')
    const req = raw as FileAction
    if (!FILE_TOOL_NAMES.includes(req.tool)) throw new Error('Unknown file tool')
    let action: FileAction
    if (req.tool === 'move_file') {
      action = {
        tool: req.tool,
        source: this.path(req.source),
        destination: this.path(req.destination, true),
      }
    } else {
      action = { tool: req.tool, path: this.path(req.path, req.tool === 'create_folder') }
      if (req.tool === 'export_pdf') {
        if (!['.docx', '.md'].includes(extname(action.path!).toLowerCase())) {
          throw new Error('Only saved .docx and .md files can be exported')
        }
        action.destination = this.path(
          action.path!.slice(0, -extname(action.path!).length) + '.pdf',
          true,
        )
      }
    }
    const source = action.source ?? action.path!
    if (!['create_folder', 'list_folder'].includes(action.tool)) {
      const s = lstatSync(source)
      if (!s.isFile() || s.nlink !== 1)
        throw new Error('Only regular files with one link are supported')
      if (s.size > FILE_ACTION_MAX_BYTES) throw new Error('File exceeds 128 MiB limit')
    }
    if (action.tool === 'list_folder' && !lstatSync(source).isDirectory()) {
      throw new Error('Path must be a directory')
    }
    const fingerprint = JSON.stringify([
      action,
      action.tool === 'create_folder' ? identity(dirname(source), false) : identity(source, true),
      action.destination ? identity(dirname(action.destination), false) : null,
    ])
    return { action, fingerprint }
  }

  private prune() {
    for (const [id, entry] of this.pending) {
      if (entry.proposal.expiresAt <= (this.deps.now ?? Date.now)()) this.pending.delete(id)
    }
  }

  propose(owner: number, raw: unknown): FileActionProposal {
    this.prune()
    const checked = this.check(raw)
    if (checked.action.tool === 'list_folder') return { result: this.list(checked.action.path!) }
    if (this.pending.size >= 16 || [...this.pending.values()].some((p) => p.owner === owner)) {
      throw new Error('A file action is already awaiting approval')
    }
    const proposal = {
      id: randomUUID(),
      action: checked.action,
      expiresAt: (this.deps.now ?? Date.now)() + FILE_ACTION_TTL_MS,
    }
    this.pending.set(proposal.id, { owner, proposal, fingerprint: checked.fingerprint })
    return { pending: structuredClone(proposal) }
  }

  async decide(owner: number, id: string, approve: unknown): Promise<unknown> {
    this.prune()
    const entry = this.pending.get(id)
    if (!entry || entry.owner !== owner) throw new Error('Approval is missing or expired')
    this.pending.delete(id) // single use, including a denial or failed validation
    if (approve !== true)
      return { denied: true, message: 'User denied the file action. Do not retry.' }
    const checked = this.check(entry.proposal.action)
    if (checked.fingerprint !== entry.fingerprint)
      throw new Error('File changed; request fresh approval')
    const a = checked.action
    if (a.tool === 'create_folder') mkdirSync(a.path!)
    else if (a.tool === 'delete_file') await this.deps.trashItem(a.path!)
    else if (a.tool === 'move_file') {
      // link is atomic, refuses an existing destination, and rejects cross-device moves.
      // rename() would overwrite on Unix. Never fall back to it.
      const sourceIdentity = identity(a.source!, false)
      linkSync(a.source!, a.destination!)
      try {
        if (
          identity(a.source!, false) !== sourceIdentity ||
          identity(a.destination!, false) !== sourceIdentity
        ) {
          throw new Error('Source changed during move')
        }
        unlinkSync(a.source!)
      } catch (error) {
        // Roll back only our own link; never remove a replacement destination.
        if (
          statOrMissing(a.destination!) &&
          identity(a.destination!, false) === sourceIdentity &&
          lstatSync(a.destination!).nlink > 1
        ) {
          unlinkSync(a.destination!)
        }
        throw error
      }
    } else if (a.tool === 'export_pdf') {
      const tempDir = mkdtempSync(join(dirname(a.destination!), '.genoffice-export-'))
      const tempPdf = join(tempDir, 'export.pdf')
      try {
        await this.deps.exportPdf(a.path!, tempPdf)
        const output = lstatSync(tempPdf)
        if (!output.isFile() || output.isSymbolicLink() || output.size > FILE_ACTION_MAX_BYTES) {
          throw new Error('Invalid or oversized PDF output')
        }
        // Export can take time; revalidate roots, policy, parents and source before publication.
        if (this.check(a).fingerprint !== checked.fingerprint)
          throw new Error('File changed during export')
        copyFileSync(tempPdf, a.destination!, constants.COPYFILE_EXCL)
      } finally {
        if (statOrMissing(tempPdf)) unlinkSync(tempPdf)
        rmdirSync(tempDir)
      }
    }
    return { ok: true, path: a.destination ?? a.path }
  }

  private list(path: string) {
    const entries: { name: string; type: string; size: number; mtimeMs: number }[] = []
    const dir = opendirSync(path)
    let scanned = 0
    let truncated = false
    try {
      for (;;) {
        const entry = dir.readSync()
        if (!entry) break
        if (++scanned > 1000 || entries.length >= FILE_ACTION_LIST_LIMIT) {
          truncated = true
          break
        }
        try {
          const child = this.path(join(path, entry.name))
          const s = lstatSync(child)
          if (!s.isFile() && !s.isDirectory()) continue
          entries.push({
            name: entry.name,
            type: s.isDirectory() ? 'directory' : 'file',
            size: s.size,
            mtimeMs: s.mtimeMs,
          })
        } catch {
          // Ignored, inaccessible and symlink entries are withheld.
        }
      }
    } finally {
      dir.closeSync()
    }
    return { path, entries, truncated }
  }
}
