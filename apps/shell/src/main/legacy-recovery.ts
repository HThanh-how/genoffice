import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { atomicWriteFile } from './atomic-write'

const execFileAsync = promisify(execFile)
const VAULT = '.genoffice'
const ORIGINALS = 'originals'
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const LINKS_FILE = 'legacy-doc-links.json'
let recoveryQueue: Promise<void> = Promise.resolve()

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const result = recoveryQueue.then(work, work)
  recoveryQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export interface LegacyRecoveryEntry {
  id: string
  sourcePath: string
  convertedPath: string
  archivedAt: number
  expiresAt: number
}

interface StoredEntry extends LegacyRecoveryEntry {
  backupName: string
}

/** Old format and the new format that replaces it. */
const LEGACY_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['.doc', '.docx'],
  ['.xls', '.xlsx'],
  ['.ppt', '.pptx'],
]

/** The old extension (lower-case) when `converted` is the new-format twin of `source`, else null. */
function legacyExtensionOf(source: string, converted: string): string | null {
  const from = extname(source).toLowerCase()
  const to = extname(converted).toLowerCase()
  return LEGACY_PAIRS.some(([a, b]) => a === from && b === to) ? from : null
}

function vaultFor(sourcePath: string): string {
  return join(dirname(sourcePath), VAULT)
}

function registryPath(userData: string): string {
  return join(userData, 'legacy-recovery-folders.json')
}

interface LegacyLink {
  sourcePath: string
  convertedPath: string
  sourceHash: string
}

async function links(userData: string): Promise<LegacyLink[]> {
  try {
    const value: unknown = JSON.parse(await readFile(join(userData, LINKS_FILE), 'utf8'))
    return Array.isArray(value)
      ? value.filter(
          (item): item is LegacyLink =>
            !!item &&
            typeof item.sourcePath === 'string' &&
            typeof item.convertedPath === 'string' &&
            typeof item.sourceHash === 'string',
        )
      : []
  } catch {
    return []
  }
}

/** Text-only imports keep the original, but reopening it must reuse the same editable copy. */
async function rememberLegacyDocCopyInternal(
  sourcePath: string,
  convertedPath: string,
  sourceHash: string,
  userData: string,
): Promise<void> {
  const current = (await links(userData)).filter((entry) => entry.sourcePath !== sourcePath)
  await mkdir(userData, { recursive: true })
  await atomicWriteFile(
    join(userData, LINKS_FILE),
    Buffer.from(
      JSON.stringify([{ sourcePath, convertedPath, sourceHash }, ...current].slice(0, 500)),
    ),
  )
}

async function linkedLegacyDocCopyInternal(
  sourcePath: string,
  userData: string,
): Promise<string | null> {
  const current = await links(userData)
  const link = current.find((item) => item.sourcePath === sourcePath)
  if (!link) return null
  try {
    if ((await stat(sourcePath)).size > 50 * 1024 * 1024) throw new Error('Source too large')
    const source = await readFile(sourcePath)
    await stat(link.convertedPath)
    if (createHash('sha256').update(source).digest('hex') === link.sourceHash)
      return link.convertedPath
  } catch {
    // The original or editable copy has been moved or deleted.
  }
  await atomicWriteFile(
    join(userData, LINKS_FILE),
    Buffer.from(JSON.stringify(current.filter((item) => item.sourcePath !== sourcePath))),
  )
  return null
}

async function folders(userData: string): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(await readFile(registryPath(userData), 'utf8'))
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : []
  } catch {
    return []
  }
}

async function saveFolders(userData: string, paths: string[]): Promise<void> {
  await mkdir(userData, { recursive: true })
  await atomicWriteFile(registryPath(userData), Buffer.from(JSON.stringify([...new Set(paths)])))
}

function metadataPath(vault: string, id: string): string {
  return join(vault, ORIGINALS, `${id}.json`)
}

function backupPath(vault: string, entry: StoredEntry): string {
  return join(vault, ORIGINALS, entry.backupName)
}

async function readEntries(vault: string, allowMoved = false): Promise<StoredEntry[]> {
  let names: string[]
  try {
    names = await readdir(join(vault, ORIGINALS))
  } catch {
    return []
  }
  const entries: StoredEntry[] = []
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue
    try {
      const item = JSON.parse(await readFile(join(vault, ORIGINALS, name), 'utf8')) as StoredEntry
      if (
        item.id + '.json' !== name ||
        !item.backupName ||
        basename(item.backupName) !== item.backupName ||
        (!allowMoved && dirname(item.sourcePath) !== dirname(vault)) ||
        !legacyExtensionOf(item.sourcePath, item.convertedPath) ||
        !Number.isFinite(item.archivedAt)
      )
        continue
      entries.push(item)
    } catch {
      // A damaged entry is left in place for manual recovery.
    }
  }
  return entries
}

function rebasePath(path: string, oldDir: string, newDir: string): string {
  const rel = relative(oldDir, path)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return join(newDir, rel)
  return path
}

async function rebaseLegacyRecoveryInternal(
  userData: string,
  oldDir: string,
  newDir: string,
): Promise<void> {
  const current = await folders(userData)
  const rebased: string[] = []
  for (const vault of current) {
    const newVault = rebasePath(vault, oldDir, newDir)
    rebased.push(newVault)
    if (newVault === vault) continue
    for (const entry of await readEntries(newVault, true)) {
      await atomicWriteFile(
        metadataPath(newVault, entry.id),
        Buffer.from(
          JSON.stringify({
            ...entry,
            sourcePath: rebasePath(entry.sourcePath, oldDir, newDir),
            convertedPath: rebasePath(entry.convertedPath, oldDir, newDir),
          }),
        ),
      )
    }
  }
  if (rebased.some((vault, i) => vault !== current[i])) await saveFolders(userData, rebased)
  const currentLinks = await links(userData)
  const rebasedLinks = currentLinks.map((link) => ({
    ...link,
    sourcePath: rebasePath(link.sourcePath, oldDir, newDir),
    convertedPath: rebasePath(link.convertedPath, oldDir, newDir),
  }))
  if (
    rebasedLinks.some(
      (link, i) =>
        link.sourcePath !== currentLinks[i].sourcePath ||
        link.convertedPath !== currentLinks[i].convertedPath,
    )
  )
    await atomicWriteFile(join(userData, LINKS_FILE), Buffer.from(JSON.stringify(rebasedLinks)))
}

async function removeEmptyVault(vault: string): Promise<boolean> {
  try {
    await rmdir(join(vault, ORIGINALS))
    if (process.platform === 'win32') await execFileAsync('attrib', ['-h', vault]).catch(() => {})
    await rmdir(vault)
    return true
  } catch {
    await hideOnWindows(vault)
    return false
  }
}

async function hideOnWindows(vault: string): Promise<void> {
  if (process.platform !== 'win32') return
  await execFileAsync('attrib', ['+h', vault]).catch(() => {})
}

/** Keep the original next to its converted document in a hidden, recoverable vault. */
async function archiveLegacyDocInternal(
  sourcePath: string,
  convertedPath: string,
  userData: string,
  expectedSourceHash: string,
  now = Date.now(),
): Promise<LegacyRecoveryEntry> {
  const oldExtension = legacyExtensionOf(sourcePath, convertedPath)
  if (!oldExtension) throw new Error('Expected an old-format file and its new-format copy')
  if (resolve(sourcePath) === resolve(convertedPath))
    throw new Error('Source and target must differ')
  await stat(convertedPath)
  const vault = vaultFor(sourcePath)
  const originals = join(vault, ORIGINALS)
  const id = randomUUID()
  const entry: StoredEntry = {
    id,
    sourcePath,
    convertedPath,
    backupName: `${id}${oldExtension}`,
    archivedAt: now,
    expiresAt: now + RETENTION_MS,
  }
  await mkdir(originals, { recursive: true })
  await hideOnWindows(vault)
  const backup = backupPath(vault, entry)
  let copied = false
  let recorded = false
  try {
    await copyFile(sourcePath, backup, constants.COPYFILE_EXCL)
    copied = true
    const [sourceInfo, backupInfo] = await Promise.all([stat(sourcePath), stat(backup)])
    if (sourceInfo.size !== backupInfo.size) throw new Error('Incomplete legacy backup')
    const backupHash = createHash('sha256')
      .update(await readFile(backup))
      .digest('hex')
    if (backupHash !== expectedSourceHash)
      throw new Error('The original file changed during conversion')
    await writeFile(metadataPath(vault, id), JSON.stringify(entry), { flag: 'wx' })
    recorded = true
    await saveFolders(userData, [...(await folders(userData)), vault])
    const currentInfo = await stat(sourcePath)
    if (
      currentInfo.dev !== sourceInfo.dev ||
      currentInfo.ino !== sourceInfo.ino ||
      currentInfo.size !== sourceInfo.size ||
      createHash('sha256')
        .update(await readFile(sourcePath))
        .digest('hex') !== expectedSourceHash
    )
      throw new Error('The original file changed during conversion')
    await unlink(sourcePath)
    return entry
  } catch (error) {
    // Until unlink succeeds the source remains the user's authoritative copy.
    if (recorded) await unlink(metadataPath(vault, id)).catch(() => {})
    if (copied) await unlink(backup).catch(() => {})
    await removeEmptyVault(vault)
    throw error
  }
}

/** Expiry is independent of the .docx path: renaming or moving it never destroys a backup early. */
async function listLegacyRecoveryInternal(
  userData: string,
  now = Date.now(),
): Promise<LegacyRecoveryEntry[]> {
  const active: string[] = []
  const result: LegacyRecoveryEntry[] = []
  for (const vault of await folders(userData)) {
    const entries = await readEntries(vault)
    for (const entry of entries) {
      const backup = backupPath(vault, entry)
      try {
        await stat(backup)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          await unlink(metadataPath(vault, entry.id)).catch(() => {})
        else active.push(vault)
        continue
      }
      if (entry.expiresAt <= now) {
        try {
          await unlink(backup)
          await unlink(metadataPath(vault, entry.id))
        } catch {
          // Keep the registry so cleanup can retry on the next launch.
          active.push(vault)
        }
      } else {
        active.push(vault)
        result.push({
          id: entry.id,
          sourcePath: entry.sourcePath,
          convertedPath: entry.convertedPath,
          archivedAt: entry.archivedAt,
          expiresAt: entry.expiresAt,
        })
      }
    }
    if (!(await removeEmptyVault(vault))) active.push(vault)
  }
  await saveFolders(userData, active)
  return result.sort((a, b) => b.archivedAt - a.archivedAt)
}

/** Never overwrite a file that has appeared at the old path since conversion. */
async function restoreLegacyDocInternal(userData: string, id: string): Promise<string> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid recovery ID')
  for (const vault of await folders(userData)) {
    const entry = (await readEntries(vault)).find((item) => item.id === id)
    if (!entry) continue
    try {
      await copyFile(backupPath(vault, entry), entry.sourcePath, constants.COPYFILE_EXCL)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error(
          'A file with the original name already exists. Rename it before restoring.',
          {
            cause: error,
          },
        )
      throw error
    }
    await unlink(backupPath(vault, entry))
    await unlink(metadataPath(vault, id))
    await listLegacyRecoveryInternal(userData)
    return entry.sourcePath
  }
  throw new Error('The original file is no longer available')
}

export function rememberLegacyDocCopy(
  sourcePath: string,
  convertedPath: string,
  sourceHash: string,
  userData: string,
): Promise<void> {
  return serialized(() =>
    rememberLegacyDocCopyInternal(sourcePath, convertedPath, sourceHash, userData),
  )
}

export function linkedLegacyDocCopy(sourcePath: string, userData: string): Promise<string | null> {
  return serialized(() => linkedLegacyDocCopyInternal(sourcePath, userData))
}

export function archiveLegacyDoc(
  sourcePath: string,
  convertedPath: string,
  userData: string,
  expectedSourceHash: string,
  now = Date.now(),
): Promise<LegacyRecoveryEntry> {
  return serialized(() =>
    archiveLegacyDocInternal(sourcePath, convertedPath, userData, expectedSourceHash, now),
  )
}

export function listLegacyRecovery(
  userData: string,
  now = Date.now(),
): Promise<LegacyRecoveryEntry[]> {
  return serialized(() => listLegacyRecoveryInternal(userData, now))
}

export function restoreLegacyDoc(userData: string, id: string): Promise<string> {
  return serialized(() => restoreLegacyDocInternal(userData, id))
}

/** Keep recovery locations valid when a folder is renamed or moved inside GenOffice. */
export function rebaseLegacyRecovery(
  userData: string,
  oldDir: string,
  newDir: string,
): Promise<void> {
  return serialized(() => rebaseLegacyRecoveryInternal(userData, oldDir, newDir))
}
