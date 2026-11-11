import { createReadStream, promises as fsp } from 'node:fs'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { dialog, type BrowserWindow, type CustomScheme, type IpcMain, protocol } from 'electron'
import { readAppSettings, writeAppSettings } from '../app-settings'
import {
  IMAGE_EXTENSIONS,
  LIVE_BACKGROUND_CHANNELS,
  LIVE_BACKGROUND_SCHEME,
  VIDEO_EXTENSIONS,
  emptyLiveBackgroundState,
  normalizeLiveBackgroundPrefs,
  type LiveBackgroundMedia,
  type LiveBackgroundPrefs,
  type LiveBackgroundState,
} from '../../shared/fork/live-background'
import {
  parseByteRange,
  resolveLiveBackgroundSource,
  scanWallpaperEngine,
  type ResolvedSource,
} from './live-background-resolve'

const SETTINGS_KEY = 'liveBackground'

/**
 * Merged into the process-wide registerSchemesAsPrivileged call (see apps/html preview-protocol: it may run only
 * once). Secure + stream so a secure page can use it for <video> with seeking.
 */
export const LIVE_BACKGROUND_SCHEME_PRIVILEGE: CustomScheme = {
  scheme: LIVE_BACKGROUND_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
}

export interface LiveBackgroundDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  settingsPath: () => string
  /** window the native chooser attaches to */
  parentWindow: () => BrowserWindow | null
  /** tell every window the state changed */
  broadcast: (channel: string, state: LiveBackgroundState) => void
}

export interface LiveBackgroundController {
  /** wires the genoffice-bg:// handler; call after app ready */
  installProtocol(): void
  /** Resolve a user-selected source asynchronously, before any opening operation. */
  setSelectedSource(key: string, path: string, index?: number): Promise<LiveBackgroundMedia | null>
  getSelectedSource(key: string): LiveBackgroundMedia | null
}

function readPrefs(settingsPath: string): LiveBackgroundPrefs {
  return normalizeLiveBackgroundPrefs(readAppSettings(settingsPath)[SETTINGS_KEY])
}

/** Steam's usual Workshop location for Wallpaper Engine, offered as the folder chooser's start point. */
async function workshopHint(): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(
    (v): v is string => !!v,
  )
  for (const root of roots) {
    const dir = join(root, 'Steam', 'steamapps', 'workshop', 'content', '431960')
    try {
      if ((await fsp.stat(dir)).isDirectory()) return dir
    } catch {
      // not installed there
    }
  }
  return undefined
}

/**
 * Registers the live-background IPC. Nothing touches the disk until the user turns the feature on: the disabled
 * state is answered from the settings file alone, and the media is only ever read through the protocol handler.
 */
export function registerLiveBackground(deps: LiveBackgroundDeps): LiveBackgroundController {
  /** what genoffice-bg://file/{main,poster} may serve — only the item the user chose, never a path from a URL */
  let served: { main: string | null; poster: string | null; enabled: boolean } = {
    main: null,
    poster: null,
    enabled: false,
  }
  let workshop: Awaited<ReturnType<typeof scanWallpaperEngine>> = []
  let revision = 0
  let homeMedia: LiveBackgroundMedia | null = null
  const sources = new Map<
    string,
    { main: string; poster: string | null; media: LiveBackgroundMedia }
  >()
  const generations = new Map<string, number>()
  const setSelectedSource = async (
    key: string,
    path: string,
    index = 0,
  ): Promise<LiveBackgroundMedia | null> => {
    if (!/^[a-z0-9_-]{1,64}$/.test(key) || key === 'file' || key === 'home') return null
    const generation = (generations.get(key) ?? 0) + 1
    generations.set(key, generation)
    sources.delete(key)
    if (!path) return null
    const result = await resolveLiveBackgroundSource(path, index)
    if (generations.get(key) !== generation) return null
    const item = result.item ?? result.fallbackStill
    if (!item) return null
    const version = ++revision
    const media: LiveBackgroundMedia = {
      kind: item.kind,
      url: `${LIVE_BACKGROUND_SCHEME}://${key}/main?v=${version}`,
      posterUrl: item.poster ? `${LIVE_BACKGROUND_SCHEME}://${key}/poster?v=${version}` : null,
      title: item.title,
      origin: item.origin,
    }
    sources.set(key, { main: item.path, poster: item.poster, media })
    return media
  }

  const build = async (prefs: LiveBackgroundPrefs): Promise<LiveBackgroundState> => {
    if (!prefs.enabled && !prefs.openingEnabled) {
      homeMedia = null
      served = { main: null, poster: null, enabled: false }
      return emptyLiveBackgroundState(prefs)
    }
    if (!prefs.sourcePath) {
      homeMedia = null
      served = { main: null, poster: null, enabled: true }
      return { ...emptyLiveBackgroundState(prefs), status: 'no-source' }
    }
    const resolved: ResolvedSource = await resolveLiveBackgroundSource(
      prefs.sourcePath,
      prefs.index,
    )
    const shown = resolved.item ?? resolved.fallbackStill
    // the URL (and with it the player) only changes when the file does, not on every settings tweak
    if (shown?.path !== served.main || (resolved.item?.poster ?? null) !== served.poster)
      revision += 1
    served = {
      main: shown?.path ?? null,
      poster: resolved.item?.poster ?? null,
      enabled: true,
    }
    const url = (name: 'main' | 'poster') =>
      `${LIVE_BACKGROUND_SCHEME}://file/${name}?v=${revision}`
    homeMedia = shown
      ? {
          kind: shown.kind,
          url: url('main'),
          posterUrl: resolved.item?.poster ? url('poster') : null,
          title: shown.title,
          origin: shown.origin,
        }
      : null
    return {
      prefs,
      status: resolved.status,
      reason: resolved.reason,
      title: resolved.title,
      count: resolved.count,
      skipped: resolved.skipped,
      media: homeMedia,
    }
  }

  const refresh = async (): Promise<LiveBackgroundState> => build(readPrefs(deps.settingsPath()))

  const save = async (prefs: LiveBackgroundPrefs): Promise<LiveBackgroundState> => {
    writeAppSettings(deps.settingsPath(), { [SETTINGS_KEY]: prefs })
    const state = await build(prefs)
    deps.broadcast(LIVE_BACKGROUND_CHANNELS.changed, state)
    return state
  }

  deps.ipcMain.handle(LIVE_BACKGROUND_CHANNELS.scan, async () => {
    const root = await workshopHint()
    workshop = root ? await scanWallpaperEngine(root) : []
    for (const key of sources.keys()) if (key.startsWith('workshop-preview-')) sources.delete(key)
    return workshop.map((item, index) => {
      const key = `workshop-preview-${index}`
      const url = `${LIVE_BACKGROUND_SCHEME}://${key}/main?v=${++revision}`
      if (item.preview)
        sources.set(key, {
          main: item.preview,
          poster: null,
          media: {
            kind: 'image',
            url,
            posterUrl: null,
            title: item.title,
            origin: 'wallpaper-engine',
          },
        })
      return { title: item.title, reason: item.reason, previewUrl: item.preview ? url : null }
    })
  })
  deps.ipcMain.handle(LIVE_BACKGROUND_CHANNELS.selectWorkshop, (_event, index: unknown) => {
    const item = typeof index === 'number' && Number.isInteger(index) ? workshop[index] : undefined
    if (!item || item.reason) return refresh()
    return save({ ...readPrefs(deps.settingsPath()), sourcePath: item.path, index: 0 })
  })

  deps.ipcMain.handle(LIVE_BACKGROUND_CHANNELS.getState, () => refresh())

  deps.ipcMain.handle(LIVE_BACKGROUND_CHANNELS.setPrefs, (_event, patch: unknown) => {
    const current = readPrefs(deps.settingsPath())
    const raw = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
    const next = normalizeLiveBackgroundPrefs({ ...current, ...raw })
    // a new source starts at its first item
    if (next.sourcePath !== current.sourcePath && raw.index === undefined) next.index = 0
    return save(next)
  })

  deps.ipcMain.handle(LIVE_BACKGROUND_CHANNELS.pickSource, async (_event, mode: unknown) => {
    const current = readPrefs(deps.settingsPath())
    const folder = mode === 'folder'
    const parent = deps.parentWindow()
    const options: Electron.OpenDialogOptions = {
      properties: [folder ? 'openDirectory' : 'openFile'],
      ...(folder
        ? { defaultPath: await workshopHint() }
        : {
            filters: [
              {
                name: 'Video / Image',
                extensions: [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS].map((e) => e.slice(1)),
              },
            ],
          }),
    }
    const result =
      parent && !parent.isDestroyed()
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
    const chosen = result.canceled ? undefined : result.filePaths[0]
    if (!chosen) return refresh()
    // choosing a source is an explicit request to use it
    return save({ ...current, sourcePath: chosen, index: 0 })
  })

  return {
    setSelectedSource,
    getSelectedSource: (key) => {
      if (key === 'opening') return readPrefs(deps.settingsPath()).openingEnabled ? homeMedia : null
      return key === 'home' ? homeMedia : (sources.get(key)?.media ?? null)
    },
    installProtocol() {
      void refresh()
      protocol.handle(LIVE_BACKGROUND_SCHEME, async (request) => {
        // Match the raw URL before URL parsing can normalize traversal segments.
        const match = /^genoffice-bg:\/\/([a-z0-9_-]{1,64})\/(main|poster)(?:\?v=[0-9]+)?$/.exec(
          request.url,
        )
        const source =
          match?.[1] === 'file' ? (served.enabled ? served : null) : sources.get(match?.[1] ?? '')
        const path = match && source ? source[match[2] as 'main' | 'poster'] : null
        if (!path) return new Response(null, { status: 404 })
        const type = MIME[extname(path).toLowerCase()]
        if (!type) return new Response(null, { status: 404 })
        let size: number
        try {
          size = (await fsp.stat(path)).size
        } catch {
          return new Response(null, { status: 404 })
        }
        const range = parseByteRange(request.headers.get('range'), size)
        if (range === 'invalid') {
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${size}` },
          })
        }
        const [start, end] = range ?? [0, Math.max(0, size - 1)]
        const headers: Record<string, string> = {
          'Content-Type': type,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(size === 0 ? 0 : end - start + 1),
          'Cache-Control': 'no-store',
        }
        if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
        if (request.method === 'HEAD' || size === 0) {
          return new Response(null, { status: range ? 206 : 200, headers })
        }
        const stream = createReadStream(path, { start, end })
        return new Response(Readable.toWeb(stream) as ReadableStream, {
          status: range ? 206 : 200,
          headers,
        })
      })
    },
  }
}
