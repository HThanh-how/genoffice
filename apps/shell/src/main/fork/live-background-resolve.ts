import { promises as nodeFs } from 'node:fs'
import { basename, join } from 'node:path'
import {
  isSafeRelativeName,
  mediaKindOfName,
  parseWallpaperEngineProject,
  wallpaperEngineTypeReason,
  type LiveBackgroundReason,
  type LiveBackgroundStatus,
} from '../../shared/fork/live-background'

/** The slice of node:fs/promises the resolver needs, so tests can run against a temp directory or a fake. */
export interface ResolveFs {
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number }>
  readdir(path: string): Promise<string[]>
  readFile(path: string, encoding: 'utf8'): Promise<string>
}

export const nodeResolveFs: ResolveFs = {
  stat: (p) => nodeFs.stat(p),
  readdir: (p) => nodeFs.readdir(p),
  readFile: (p, enc) => nodeFs.readFile(p, enc),
}

/** project.json files are a few KB; anything bigger is not one. */
const MAX_PROJECT_JSON_BYTES = 1024 * 1024
/** A folder is enumerated one level deep; this bounds the work for an enormous library. */
const MAX_FOLDER_ENTRIES = 5000

export interface ResolvedItem {
  /** absolute path of the file to play / show */
  path: string
  kind: 'video' | 'image'
  title: string
  /** still preview picture (absolute path) or null */
  poster: string | null
  origin: 'file' | 'folder' | 'wallpaper-engine'
}

export interface ResolvedSource {
  status: LiveBackgroundStatus
  reason: LiveBackgroundReason | null
  title: string
  /** the playable item chosen by `index`, or null */
  item: ResolvedItem | null
  /** unsupported item whose preview picture can still be shown as a still background */
  fallbackStill: ResolvedItem | null
  count: number
  skipped: number
}

const NATURAL = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

async function exists(fs: ResolveFs, path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile()
  } catch {
    return false
  }
}

async function readProject(fs: ResolveFs, dir: string) {
  const file = join(dir, 'project.json')
  try {
    const st = await fs.stat(file)
    if (!st.isFile() || st.size > MAX_PROJECT_JSON_BYTES) return { present: true, project: null }
    const raw = await fs.readFile(file, 'utf8')
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    return { present: true, project: parseWallpaperEngineProject(JSON.parse(text)) }
  } catch (error) {
    // no project.json at all vs. one that cannot be read / parsed
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return { present: code !== 'ENOENT' && code !== 'ENOTDIR', project: null }
  }
}

interface WeOutcome {
  item: ResolvedItem | null
  /** still preview for an unsupported item */
  still: ResolvedItem | null
  reason: LiveBackgroundReason | null
  title: string
}

/** One Wallpaper Engine item folder (the one holding project.json). */
async function resolveWallpaperEngineItem(
  fs: ResolveFs,
  dir: string,
  project: ReturnType<typeof parseWallpaperEngineProject>,
): Promise<WeOutcome> {
  const fallbackTitle = basename(dir)
  if (!project) return { item: null, still: null, reason: 'we-invalid', title: fallbackTitle }
  const title = project.title || fallbackTitle
  let poster: string | null = null
  if (
    project.preview &&
    isSafeRelativeName(project.preview) &&
    mediaKindOfName(project.preview) === 'image'
  ) {
    const candidate = join(dir, project.preview)
    if (await exists(fs, candidate)) poster = candidate
  }
  const reason = wallpaperEngineTypeReason(project.type)
  if (reason) {
    return {
      item: null,
      still: poster
        ? { path: poster, kind: 'image', title, poster: null, origin: 'wallpaper-engine' }
        : null,
      reason,
      title,
    }
  }
  if (
    !isSafeRelativeName(project.file) ||
    mediaKindOfName(project.file) !== 'video' ||
    !(await exists(fs, join(dir, project.file)))
  ) {
    return { item: null, still: null, reason: 'we-invalid', title }
  }
  return {
    item: {
      path: join(dir, project.file),
      kind: 'video',
      title,
      poster,
      origin: 'wallpaper-engine',
    },
    still: null,
    reason: null,
    title,
  }
}

/**
 * Turns the path the user chose into something the renderer can show. A path may be
 *  - a picture or video file;
 *  - a Wallpaper Engine item folder (has project.json): `type: video` plays, everything else is explained;
 *  - a folder of pictures / videos, or of Wallpaper Engine items (e.g. steamapps/workshop/content/431960):
 *    one level deep, playable items sorted naturally; `index` picks one (wraps around).
 * Only reads; nothing under the chosen path is ever written, moved or deleted.
 */
export async function resolveLiveBackgroundSource(
  sourcePath: string,
  index: number,
  fs: ResolveFs = nodeResolveFs,
): Promise<ResolvedSource> {
  const base: ResolvedSource = {
    status: 'missing',
    reason: null,
    title: '',
    item: null,
    fallbackStill: null,
    count: 0,
    skipped: 0,
  }
  let st
  try {
    st = await fs.stat(sourcePath)
  } catch {
    return base
  }

  if (st.isFile()) {
    const kind = mediaKindOfName(sourcePath)
    const title = basename(sourcePath)
    if (kind) {
      return {
        ...base,
        status: 'ok',
        title,
        count: 1,
        item: { path: sourcePath, kind, title, poster: null, origin: 'file' },
      }
    }
    return { ...base, status: 'unsupported', reason: 'file-type', title }
  }
  if (!st.isDirectory()) return base

  // A single Wallpaper Engine item.
  const own = await readProject(fs, sourcePath)
  if (own.present) {
    const we = await resolveWallpaperEngineItem(fs, sourcePath, own.project)
    if (we.item) return { ...base, status: 'ok', title: we.title, count: 1, item: we.item }
    return {
      ...base,
      status: 'unsupported',
      reason: we.reason,
      title: we.title,
      fallbackStill: we.still,
    }
  }

  // A folder: direct media files + direct Wallpaper Engine item sub-folders.
  let names: string[]
  try {
    names = (await fs.readdir(sourcePath)).slice(0, MAX_FOLDER_ENTRIES)
  } catch {
    return base
  }
  names.sort((a, b) => NATURAL.compare(a, b))
  const items: ResolvedItem[] = []
  let skipped = 0
  let lastSkipped: WeOutcome | null = null
  for (const name of names) {
    const full = join(sourcePath, name)
    const kind = mediaKindOfName(name)
    if (kind) {
      items.push({ path: full, kind, title: name, poster: null, origin: 'folder' })
      continue
    }
    let child
    try {
      child = await fs.stat(full)
    } catch {
      continue
    }
    if (!child.isDirectory()) continue
    const sub = await readProject(fs, full)
    if (!sub.present) continue
    const we = await resolveWallpaperEngineItem(fs, full, sub.project)
    if (we.item) items.push(we.item)
    else {
      skipped += 1
      lastSkipped = we
    }
  }
  if (items.length === 0) {
    return {
      ...base,
      status: 'empty',
      reason: skipped > 0 ? (lastSkipped?.reason ?? null) : null,
      skipped,
    }
  }
  const at = ((Math.trunc(index) % items.length) + items.length) % items.length
  const item = items[at]
  return { ...base, status: 'ok', title: item.title, item, count: items.length, skipped }
}

/** `Range: bytes=a-b` -> inclusive byte window, null when absent, 'invalid' when unsatisfiable. */
export function parseByteRange(
  header: string | null,
  size: number,
): [number, number] | null | 'invalid' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid'
  let start: number
  let end: number
  if (m[1] === '') {
    // suffix range: the last N bytes
    const n = Number(m[2])
    if (n <= 0) return 'invalid'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return 'invalid'
  return [start, end]
}
