/**
 * Optional live background (fork-only): a still picture or a looping muted video behind the Home screen.
 *
 * The file is referenced where the user keeps it — nothing is copied into the app, the settings file or the
 * installer. Wallpaper Engine "video" projects are understood directly (project.json -> `file`); its
 * "scene" / "application" / "web" projects are not playable here, and say so instead of failing silently.
 *
 * Pure helpers only (no Electron, no fs) so main, preload, renderer and tests share one definition.
 */

export const LIVE_BACKGROUND_CHANNELS = {
  getState: 'live-background:get-state',
  setPrefs: 'live-background:set-prefs',
  pickSource: 'live-background:pick-source',
  changed: 'live-background:changed',
} as const

/** Privileged scheme that serves ONLY the currently configured file (see main/fork/live-background.ts). */
export const LIVE_BACKGROUND_SCHEME = 'genoffice-bg'

export const VIDEO_EXTENSIONS: readonly string[] = ['.mp4', '.webm', '.m4v', '.mov']
export const IMAGE_EXTENSIONS: readonly string[] = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.avif',
  '.bmp',
]

export const DIM_MIN = 0
export const DIM_MAX = 90
export const BLUR_MAX = 24

export interface LiveBackgroundPrefs {
  /** off by default: nothing is read or decoded until the user switches it on */
  enabled: boolean
  /** a media file, a folder of media, or a Wallpaper Engine item folder (the user's own path) */
  sourcePath: string
  /** 0..90: how strongly the theme's surface colour is laid over the picture so text stays readable */
  dim: number
  /** 0..24 px: gaussian blur applied to the picture (costs GPU on large videos; 0 = none) */
  blur: number
  /** pause when the window loses focus or the computer runs on battery */
  saver: boolean
  /** which playable item of a folder is shown (0-based; wraps around) */
  index: number
}

export const DEFAULT_LIVE_BACKGROUND_PREFS: LiveBackgroundPrefs = {
  enabled: false,
  sourcePath: '',
  dim: 55,
  blur: 0,
  saver: true,
  index: 0,
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Defensive parse of the stored / IPC value; anything unrecognised falls back to the default. */
export function normalizeLiveBackgroundPrefs(value: unknown): LiveBackgroundPrefs {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const d = DEFAULT_LIVE_BACKGROUND_PREFS
  return {
    enabled: raw.enabled === true,
    sourcePath:
      typeof raw.sourcePath === 'string' && raw.sourcePath.length <= 1024 ? raw.sourcePath : '',
    dim: clampInt(raw.dim, DIM_MIN, DIM_MAX, d.dim),
    blur: clampInt(raw.blur, 0, BLUR_MAX, d.blur),
    saver: typeof raw.saver === 'boolean' ? raw.saver : d.saver,
    index: clampInt(raw.index, 0, 100000, d.index),
  }
}

export type LiveBackgroundStatus =
  /** switched off (nothing was read) */
  | 'off'
  /** switched on but no source chosen yet */
  | 'no-source'
  /** `media` is ready to show */
  | 'ok'
  /** the chosen item cannot be played here; see `reason` */
  | 'unsupported'
  /** the path no longer exists */
  | 'missing'
  /** a folder with nothing playable in it */
  | 'empty'

export type LiveBackgroundReason =
  /** Wallpaper Engine scene (.pkg / .tex): proprietary renderer */
  | 'we-scene'
  /** Wallpaper Engine application wallpaper (.exe) */
  | 'we-application'
  /** Wallpaper Engine web wallpaper: needs the wallpaperPropertyListener host API */
  | 'we-web'
  /** project.json of a type this build does not know */
  | 'we-unknown'
  /** project.json exists but is unreadable / lacks a usable `file` */
  | 'we-invalid'
  /** a single file whose extension is neither a picture nor a video */
  | 'file-type'

export interface LiveBackgroundMedia {
  kind: 'video' | 'image'
  /** genoffice-bg://file/main?v=<n> */
  url: string
  /** still frame/preview to show under (or instead of) the video; same scheme */
  posterUrl: string | null
  title: string
  /** where it came from, for the Settings summary */
  origin: 'file' | 'folder' | 'wallpaper-engine'
}

export interface LiveBackgroundState {
  prefs: LiveBackgroundPrefs
  status: LiveBackgroundStatus
  reason: LiveBackgroundReason | null
  /** shown in Settings when the item is unsupported (a preview picture is used as a still background) */
  title: string
  /** set when status is 'ok', or 'unsupported' with a preview picture that is shown instead */
  media: LiveBackgroundMedia | null
  /** playable items in the chosen folder (1 for a single file / item) */
  count: number
  /** items skipped because they cannot be played here (Wallpaper Engine scenes, ...) */
  skipped: number
}

export interface LiveBackgroundApi {
  getLiveBackground(): Promise<LiveBackgroundState>
  setLiveBackgroundPrefs(patch: Partial<LiveBackgroundPrefs>): Promise<LiveBackgroundState>
  /** native chooser; `mode` 'file' picks a picture/video, 'folder' a folder (media folder or Wallpaper Engine item) */
  pickLiveBackgroundSource(mode: 'file' | 'folder'): Promise<LiveBackgroundState>
  onLiveBackgroundChanged(handler: (state: LiveBackgroundState) => void): () => void
}

export function emptyLiveBackgroundState(
  prefs: LiveBackgroundPrefs = DEFAULT_LIVE_BACKGROUND_PREFS,
): LiveBackgroundState {
  return { prefs, status: 'off', reason: null, title: '', media: null, count: 0, skipped: 0 }
}

/** Defensive parse of a state payload received over IPC. */
export function normalizeLiveBackgroundState(value: unknown): LiveBackgroundState {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const prefs = normalizeLiveBackgroundPrefs(raw.prefs)
  const statuses: readonly LiveBackgroundStatus[] = [
    'off',
    'no-source',
    'ok',
    'unsupported',
    'missing',
    'empty',
  ]
  const status = statuses.find((s) => s === raw.status) ?? 'off'
  const reasons: readonly LiveBackgroundReason[] = [
    'we-scene',
    'we-application',
    'we-web',
    'we-unknown',
    'we-invalid',
    'file-type',
  ]
  const reason = reasons.find((r) => r === raw.reason) ?? null
  const m = (raw.media && typeof raw.media === 'object' ? raw.media : null) as Record<
    string,
    unknown
  > | null
  const prefix = `${LIVE_BACKGROUND_SCHEME}://`
  const media: LiveBackgroundMedia | null =
    m &&
    (m.kind === 'video' || m.kind === 'image') &&
    typeof m.url === 'string' &&
    m.url.startsWith(prefix)
      ? {
          kind: m.kind,
          url: m.url,
          posterUrl:
            typeof m.posterUrl === 'string' && m.posterUrl.startsWith(prefix) ? m.posterUrl : null,
          title: typeof m.title === 'string' ? m.title : '',
          origin: m.origin === 'folder' || m.origin === 'wallpaper-engine' ? m.origin : 'file',
        }
      : null
  return {
    prefs,
    status,
    reason,
    title: typeof raw.title === 'string' ? raw.title : '',
    media,
    count: clampInt(raw.count, 0, 1000000, 0),
    skipped: clampInt(raw.skipped, 0, 1000000, 0),
  }
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i).toLowerCase()
}

export function mediaKindOfName(name: string): 'video' | 'image' | null {
  const ext = extOf(name)
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video'
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image'
  return null
}

/** The few project.json fields we use (Wallpaper Engine writes many more, which we ignore). */
export interface WallpaperEngineProject {
  /** lower-cased: Workshop items carry both "video" and "Video" */
  type: string
  /** relative file name inside the item folder, '' when absent */
  file: string
  title: string
  preview: string
}

export function parseWallpaperEngineProject(json: unknown): WallpaperEngineProject | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const o = json as Record<string, unknown>
  const type = typeof o.type === 'string' ? o.type.trim().toLowerCase() : ''
  if (!type) return null
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return { type, file: str(o.file), title: str(o.title).trim(), preview: str(o.preview) }
}

/**
 * A `file` / `preview` name from project.json is only used when it stays inside the item folder: no drive
 * letter, no leading slash, no `..` segment (project.json is data from the Workshop, not trusted).
 */
export function isSafeRelativeName(name: string): boolean {
  if (!name || name.length > 260) return false
  if (/^[a-zA-Z]:/.test(name) || name.startsWith('/') || name.startsWith('\\')) return false
  if (name.includes('\0')) return false
  return !name.split(/[\\/]+/).some((segment) => segment === '..')
}

/** Why a Wallpaper Engine item of this `type` cannot be played here (null = it can: video). */
export function wallpaperEngineTypeReason(type: string): LiveBackgroundReason | null {
  switch (type) {
    case 'video':
      return null
    case 'scene':
      return 'we-scene'
    case 'application':
      return 'we-application'
    case 'web':
      return 'we-web'
    default:
      return 'we-unknown'
  }
}
