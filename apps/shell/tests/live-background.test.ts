import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_LIVE_BACKGROUND_PREFS,
  isSafeRelativeName,
  mediaKindOfName,
  normalizeLiveBackgroundPrefs,
  normalizeLiveBackgroundState,
  parseWallpaperEngineProject,
  shouldPlayLiveBackground,
  wallpaperEngineTypeReason,
} from '../src/shared/fork/live-background'
import {
  parseByteRange,
  resolveLiveBackgroundSource,
  scanWallpaperEngine,
} from '../src/main/fork/live-background-resolve'

describe('live background prefs', () => {
  it('pauses when Home is inactive, obscured or unfocused, and respects battery and motion settings', () => {
    const active = {
      isVideo: true,
      homeActive: true,
      hidden: false,
      focused: true,
      reducedMotion: false,
      saver: true,
      onBattery: false,
    }
    expect(shouldPlayLiveBackground(active)).toBe(true)
    for (const change of [
      { isVideo: false },
      { homeActive: false },
      { hidden: true },
      { focused: false },
      { reducedMotion: true },
      { onBattery: true },
    ])
      expect(shouldPlayLiveBackground({ ...active, ...change })).toBe(false)
    expect(shouldPlayLiveBackground({ ...active, saver: false, onBattery: true })).toBe(true)
    expect(shouldPlayLiveBackground({ ...active, saver: false, focused: false })).toBe(false)
  })
  it('is off by default and clamps garbage', () => {
    expect(DEFAULT_LIVE_BACKGROUND_PREFS.enabled).toBe(false)
    expect(DEFAULT_LIVE_BACKGROUND_PREFS.openingEnabled).toBe(false)
    expect(
      normalizeLiveBackgroundPrefs({ sourcePath: 'x', openingEnabled: true }).openingEnabled,
    ).toBe(true)
    expect(normalizeLiveBackgroundPrefs(undefined)).toEqual(DEFAULT_LIVE_BACKGROUND_PREFS)
    expect(normalizeLiveBackgroundPrefs('x')).toEqual(DEFAULT_LIVE_BACKGROUND_PREFS)
    const p = normalizeLiveBackgroundPrefs({
      enabled: 'yes',
      sourcePath: 5,
      dim: 500,
      blur: -3,
      saver: 'no',
      index: 1.6,
    })
    expect(p).toEqual({
      enabled: false,
      openingEnabled: false,
      sourcePath: '',
      dim: 90,
      blur: 0,
      saver: true,
      index: 2,
    })
  })

  it('only trusts genoffice-bg:// media urls coming over IPC', () => {
    const bad = normalizeLiveBackgroundState({
      status: 'ok',
      media: { kind: 'video', url: 'file:///C:/secret.mp4', title: 't' },
    })
    expect(bad.media).toBeNull()
    const good = normalizeLiveBackgroundState({
      status: 'ok',
      media: { kind: 'video', url: 'genoffice-bg://file/main?v=1', posterUrl: 'https://x/y' },
    })
    expect(good.media?.url).toBe('genoffice-bg://file/main?v=1')
    expect(good.media?.posterUrl).toBeNull()
  })
})

describe('Wallpaper Engine project.json', () => {
  it('lower-cases the type (the Workshop has both "video" and "Video")', () => {
    expect(parseWallpaperEngineProject({ type: 'Video', file: 'a.mp4', title: ' T ' })).toEqual({
      type: 'video',
      file: 'a.mp4',
      title: 'T',
      preview: '',
    })
    expect(parseWallpaperEngineProject({ file: 'a.mp4' })).toBeNull()
    expect(parseWallpaperEngineProject([])).toBeNull()
  })

  it('maps types to reasons', () => {
    expect(wallpaperEngineTypeReason('video')).toBeNull()
    expect(wallpaperEngineTypeReason('scene')).toBe('we-scene')
    expect(wallpaperEngineTypeReason('web')).toBe('we-web')
    expect(wallpaperEngineTypeReason('application')).toBe('we-application')
    expect(wallpaperEngineTypeReason('preset')).toBe('we-unknown')
  })

  it('refuses names that escape the item folder', () => {
    expect(isSafeRelativeName('a.mp4')).toBe(true)
    expect(isSafeRelativeName('sub/dir/a.mp4')).toBe(true)
    expect(isSafeRelativeName('..\\..\\x.mp4')).toBe(false)
    expect(isSafeRelativeName('a/../../x.mp4')).toBe(false)
    expect(isSafeRelativeName('C:\\x.mp4')).toBe(false)
    expect(isSafeRelativeName('/etc/x.mp4')).toBe(false)
    expect(isSafeRelativeName('')).toBe(false)
  })

  it('classifies extensions', () => {
    expect(mediaKindOfName('A.MP4')).toBe('video')
    expect(mediaKindOfName('a.webm')).toBe('video')
    expect(mediaKindOfName('a.JPG')).toBe('image')
    expect(mediaKindOfName('scene.pkg')).toBeNull()
    expect(mediaKindOfName('noext')).toBeNull()
  })
})

describe('byte ranges', () => {
  it('parses the forms a <video> element sends', () => {
    expect(parseByteRange(null, 100)).toBeNull()
    expect(parseByteRange('bytes=0-', 100)).toEqual([0, 99])
    expect(parseByteRange('bytes=10-19', 100)).toEqual([10, 19])
    expect(parseByteRange('bytes=90-500', 100)).toEqual([90, 99])
    expect(parseByteRange('bytes=-10', 100)).toEqual([90, 99])
    expect(parseByteRange('bytes=100-', 100)).toBe('invalid')
    expect(parseByteRange('bytes=20-10', 100)).toBe('invalid')
    expect(parseByteRange('items=0-1', 100)).toBe('invalid')
  })
})

describe('resolveLiveBackgroundSource', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'live-bg-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const item = (name: string, project: unknown, files: string[]) => {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'project.json'), `\uFEFF${JSON.stringify(project)}`)
    for (const f of files) writeFileSync(join(dir, f), 'x')
    return dir
  }

  it('missing path', async () => {
    const r = await resolveLiveBackgroundSource(join(root, 'nope'), 0)
    expect(r.status).toBe('missing')
  })

  it('a plain video / picture file, and a file of the wrong kind', async () => {
    writeFileSync(join(root, 'a.mp4'), 'x')
    writeFileSync(join(root, 'b.txt'), 'x')
    const v = await resolveLiveBackgroundSource(join(root, 'a.mp4'), 0)
    expect(v.status).toBe('ok')
    expect(v.item?.kind).toBe('video')
    const t = await resolveLiveBackgroundSource(join(root, 'b.txt'), 0)
    expect(t.status).toBe('unsupported')
    expect(t.reason).toBe('file-type')
  })

  it('a Wallpaper Engine video item (type in any case, BOM in project.json)', async () => {
    const dir = item(
      '111',
      { type: 'Video', file: 'clip.mp4', title: 'Clip', preview: 'preview.jpg' },
      ['clip.mp4', 'preview.jpg'],
    )
    const r = await resolveLiveBackgroundSource(dir, 0)
    expect(r.status).toBe('ok')
    expect(r.item?.origin).toBe('wallpaper-engine')
    expect(r.item?.title).toBe('Clip')
    expect(r.item?.path).toBe(join(dir, 'clip.mp4'))
    expect(r.item?.poster).toBe(join(dir, 'preview.jpg'))
  })

  it('a scene item is explained and its preview used as a still', async () => {
    const dir = item(
      '222',
      { type: 'scene', file: 'scene.json', title: 'S', preview: 'preview.gif' },
      ['scene.pkg', 'preview.gif'],
    )
    const r = await resolveLiveBackgroundSource(dir, 0)
    expect(r.status).toBe('unsupported')
    expect(r.reason).toBe('we-scene')
    expect(r.item).toBeNull()
    expect(r.fallbackStill?.path).toBe(join(dir, 'preview.gif'))
    expect(r.fallbackStill?.kind).toBe('image')
  })

  it('web and application items are explained without a still when there is no preview', async () => {
    const web = item('333', { type: 'web', file: 'index.html', title: 'W' }, ['index.html'])
    const app = item('444', { type: 'application', file: 'a.exe', title: 'A' }, ['a.exe'])
    expect((await resolveLiveBackgroundSource(web, 0)).reason).toBe('we-web')
    expect((await resolveLiveBackgroundSource(app, 0)).reason).toBe('we-application')
    expect((await resolveLiveBackgroundSource(app, 0)).fallbackStill).toBeNull()
  })

  it('does not follow a project.json file name out of the item folder', async () => {
    writeFileSync(join(root, 'outside.mp4'), 'x')
    const dir = item('555', { type: 'video', file: '..\\outside.mp4', title: 'E' }, [])
    const r = await resolveLiveBackgroundSource(dir, 0)
    expect(r.status).toBe('unsupported')
    expect(r.reason).toBe('we-invalid')
    expect(r.item).toBeNull()
  })

  it('a video item pointing at a non-video, or at a missing file, is invalid', async () => {
    const a = item('666', { type: 'video', file: 'x.txt' }, ['x.txt'])
    const b = item('777', { type: 'video', file: 'gone.mp4', preview: 'preview.jpg' }, [
      'preview.jpg',
    ])
    expect((await resolveLiveBackgroundSource(a, 0)).reason).toBe('we-invalid')
    expect((await resolveLiveBackgroundSource(b, 0)).reason).toBe('we-invalid')
    expect((await resolveLiveBackgroundSource(b, 0)).fallbackStill?.path).toBe(
      join(b, 'preview.jpg'),
    )
  })

  it('a corrupt project.json is invalid, not a crash', async () => {
    const dir = join(root, '888')
    mkdirSync(dir)
    writeFileSync(join(dir, 'project.json'), '{ not json')
    const r = await resolveLiveBackgroundSource(dir, 0)
    expect(r.status).toBe('unsupported')
    expect(r.reason).toBe('we-invalid')
  })

  it('a Workshop-style folder lists the video items, skips scenes, and wraps the index', async () => {
    item('10', { type: 'video', file: 'a.mp4', title: 'A' }, ['a.mp4'])
    item('2', { type: 'video', file: 'b.mp4', title: 'B' }, ['b.mp4'])
    item('3', { type: 'Scene', file: 'scene.json', title: 'S' }, [])
    writeFileSync(join(root, 'loose.webm'), 'x')
    const first = await resolveLiveBackgroundSource(root, 0)
    expect(first.status).toBe('ok')
    expect(first.count).toBe(3)
    expect(first.skipped).toBe(1)
    // natural order: "2", "10", "loose.webm"
    expect(first.item?.title).toBe('B')
    expect((await resolveLiveBackgroundSource(root, 1)).item?.title).toBe('A')
    expect((await resolveLiveBackgroundSource(root, 2)).item?.title).toBe('loose.webm')
    expect((await resolveLiveBackgroundSource(root, 3)).item?.title).toBe('B')
    expect((await resolveLiveBackgroundSource(root, -1)).item?.title).toBe('loose.webm')
  })

  it('lists video and unsupported projects with still previews', async () => {
    item('1', { type: 'video', file: 'a.mp4', title: 'A', preview: 'p.jpg' }, ['a.mp4', 'p.jpg'])
    item('2', { type: 'scene', title: 'B', preview: 'p.jpg' }, ['p.jpg'])
    const list = await scanWallpaperEngine(root)
    expect(list.map(({ title, reason }) => ({ title, reason }))).toEqual([
      { title: 'A', reason: null },
      { title: 'B', reason: 'we-scene' },
    ])
    expect(list.every((entry) => entry.preview?.endsWith('p.jpg'))).toBe(true)
  })

  it('a folder with only scenes is empty and says why', async () => {
    item('1', { type: 'scene', file: 'scene.json' }, [])
    const r = await resolveLiveBackgroundSource(root, 0)
    expect(r.status).toBe('empty')
    expect(r.reason).toBe('we-scene')
    expect(r.skipped).toBe(1)
  })

  it('an empty folder', async () => {
    const r = await resolveLiveBackgroundSource(root, 0)
    expect(r.status).toBe('empty')
    expect(r.reason).toBeNull()
  })
})

// Reads (never writes) the machine's real Wallpaper Engine Workshop folder when it exists.
const WORKSHOP = 'C:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\431960'
describe.runIf(existsSync(WORKSHOP))('against the real Wallpaper Engine Workshop folder', () => {
  it('lists only playable video items and every one resolves to an existing mp4/webm', async () => {
    const first = await resolveLiveBackgroundSource(WORKSHOP, 0)
    const total = readdirSync(WORKSHOP).length
    expect(first.status).toBe('ok')
    expect(first.count + first.skipped).toBeLessThanOrEqual(total)
    expect(first.count).toBeGreaterThan(0)
    for (let i = 0; i < first.count; i++) {
      const r = await resolveLiveBackgroundSource(WORKSHOP, i)
      expect(r.item?.kind).toBe('video')
      expect(r.item?.origin).toBe('wallpaper-engine')
      expect(existsSync(r.item!.path)).toBe(true)
    }
  }, 60000)
})
