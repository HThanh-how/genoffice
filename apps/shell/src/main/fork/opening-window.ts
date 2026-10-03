import { cpus, totalmem } from 'node:os'
import { BrowserWindow, app, powerMonitor } from 'electron'
import {
  CUSTOM_SCENE,
  DEFAULT_OPENING_PREFS,
  DEFAULT_SCENE_FOR_APP,
  sceneMeta,
} from '../../shared/opening-scenes-meta'
import type { OpeningApp, OpeningPrefs } from '../../shared/opening-scenes-meta'
import { SCENE_BOOT, SCENE_LIB } from './opening-scenes'

/**
 * A small "Opening…" splash for the seconds a legacy .doc / .ppt takes to be converted. Without it a
 * click on the file seems to do nothing for up to a minute (the online conversion is the slow part)
 * and the person tries again or thinks it failed. It shows only when the wait is noticeable, in the
 * colour of the app that is opening the file, and its animation is as rich as the machine can afford:
 * a jellyfish drifting up through glowing water on a good computer, a lighter version on a modest
 * one, and a calm glow with a progress bar on the weakest, on battery, or when the system asks for
 * reduced motion.
 */

export type SplashApp = OpeningApp
export type SplashTier = 'full' | 'lite' | 'minimal'

export interface SplashTheme {
  /** the app's own colour */
  color: string
  /** the letter on its badge */
  letter: string
}

export const SPLASH_THEMES: Record<SplashApp, SplashTheme> = {
  docs: { color: '#2b7cd3', letter: 'W' },
  sheets: { color: '#21a366', letter: 'X' },
  slides: { color: '#e8663f', letter: 'P' },
  pdf: { color: '#e5483b', letter: 'PDF' },
  markdown: { color: '#4a9eff', letter: 'M' },
  html: { color: '#9aa0a6', letter: '</>' },
}

export interface OpeningWords {
  title: string
  hint: string
}

export type OpeningKind = 'doc' | 'ppt' | 'xls' | 'open'

const EN: Record<OpeningKind, OpeningWords> = {
  open: { title: 'Opening…', hint: 'Getting the document ready.' },
  doc: {
    title: 'Opening document…',
    hint: 'Converting the old .doc format. This can take a few seconds.',
  },
  xls: {
    title: 'Opening spreadsheet…',
    hint: 'Converting the old .xls format. This can take a few seconds.',
  },
  ppt: {
    title: 'Opening presentation…',
    hint: 'Converting the old .ppt format. This can take a few seconds.',
  },
}
const VI: Record<OpeningKind, OpeningWords> = {
  open: { title: 'Đang mở…', hint: 'Đang chuẩn bị tài liệu, vài giây nữa.' },
  doc: {
    title: 'Đang mở tài liệu…',
    hint: 'Đang chuyển định dạng .doc cũ, có thể mất vài giây.',
  },
  xls: {
    title: 'Đang mở bảng tính…',
    hint: 'Đang chuyển định dạng .xls cũ, có thể mất vài giây.',
  },
  ppt: {
    title: 'Đang mở bản trình chiếu…',
    hint: 'Đang chuyển định dạng .ppt cũ, có thể mất vài giây.',
  },
}

export const openingWords = (lang: string, kind: OpeningKind): OpeningWords =>
  (lang === 'vi' ? VI : EN)[kind]

/** What the machine can afford, and what the person has asked for, decide how rich the animation is. */
export function chooseSplashTier(input: {
  cores: number
  memoryGB: number
  onBattery: boolean
  reducedMotion?: boolean
}): SplashTier {
  if (input.reducedMotion) return 'minimal'
  if (input.cores < 4 || input.memoryGB < 6) return 'minimal'
  // on battery the full animation is not worth the charge
  if (input.onBattery || input.cores < 6 || input.memoryGB < 12) return 'lite'
  return 'full'
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) =>
    char === '&'
      ? '&amp;'
      : char === '<'
        ? '&lt;'
        : char === '>'
          ? '&gt;'
          : char === '"'
            ? '&quot;'
            : '&#39;',
  )

/** `#rrggbb` as the "r,g,b" a canvas colour needs; a bad value falls back to blue. */
export function rgbOf(hex: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!match) return '43,124,211'
  return [match[1], match[2], match[3]].map((part) => parseInt(part!, 16)).join(',')
}

/** A lighter tone of the same colour (a third of the way to white), for the glow at the heart of the bell. */
export function lighterRgbOf(hex: string): string {
  return rgbOf(hex)
    .split(',')
    .map((part) => Math.round(Number(part) + (255 - Number(part)) * 0.45))
    .join(',')
}

/**
 * The grey outline of the editor that is opening (tab row, ribbon, and the work area of that kind of
 * file) with a slow shimmer, drawn behind the opening card so the tab never shows a blank page.
 * Plain markup and CSS: it costs nothing and works on every tier.
 */
const bar = (width: number, height = 10): string =>
  `<i class="sk" style="width:${width}px;height:${height}px"></i>`
const bars = (widths: readonly number[], height = 10): string =>
  widths.map((w) => bar(w, height)).join('')
const TEXT_LINES = [92, 88, 95, 70, 90, 86, 40, 94, 91, 78, 89, 60, 93, 87, 45, 90, 82, 66]

export function skeletonHtml(appName: SplashApp): string {
  const chrome = `<div class="sk-tabs">${bars([44, 52, 72, 60, 50, 58, 46], 12)}</div>
<div class="sk-ribbon">
<div class="sk-group">${bars([38, 38, 38], 38)}</div>
<div class="sk-group sk-col">${bars([130, 130], 14)}</div>
<div class="sk-group">${bars([28, 28, 28, 28], 28)}</div>
<div class="sk-group sk-col">${bars([110, 90], 14)}</div>
<div class="sk-group">${bars([70, 70], 38)}</div>
</div>`
  const percent = (w: number): string => `<i class="sk" style="width:${w}%;height:10px"></i>`
  const lines = TEXT_LINES.map(percent).join('')
  let work: string
  switch (appName) {
    case 'sheets':
      work = `<div class="sk-formula">${bar(80, 22)}<i class="sk sk-grow" style="height:22px"></i></div>
<div class="sk-grid" aria-hidden="true"></div>`
      break
    case 'slides':
      work = `<div class="sk-slides"><div class="sk-thumbs">${[0, 1, 2, 3, 4].map(() => '<i class="sk sk-thumb"></i>').join('')}</div>
<div class="sk-stage"><i class="sk sk-slide"></i></div></div>`
      break
    case 'pdf':
      work = `<div class="sk-slides"><div class="sk-thumbs">${[0, 1, 2, 3].map(() => '<i class="sk sk-thumb sk-tall"></i>').join('')}</div>
<div class="sk-stage"><div class="sk-page sk-narrow">${lines}</div></div></div>`
      break
    case 'markdown':
    case 'html':
      work = `<div class="sk-split"><div class="sk-code">${lines}</div><div class="sk-code">${lines}</div></div>`
      break
    default:
      work = `<div class="sk-ruler"><i class="sk sk-grow" style="height:12px"></i></div>
<div class="sk-stage"><div class="sk-page">${lines}</div></div>`
  }
  return `<div class="skel" aria-hidden="true">${chrome}<div class="sk-work">${work}</div></div>`
}

const SKELETON_CSS = `:root{--sk1:#e3e6eb;--sk2:#f3f5f8;--skbg:#f7f8fa;--skpage:#fff}
@media (prefers-color-scheme:dark){:root{--sk1:#262a31;--sk2:#323741;--skbg:#1a1d22;--skpage:#20242a}}
.skel{position:absolute;inset:0;display:flex;flex-direction:column;gap:12px;padding:12px 16px;background:var(--skbg);overflow:hidden}
.sk{display:block;flex:none;border-radius:6px;background:linear-gradient(90deg,var(--sk1) 25%,var(--sk2) 50%,var(--sk1) 75%);background-size:200% 100%;animation:shim 1.7s linear infinite}
@keyframes shim{from{background-position:200% 0}to{background-position:-200% 0}}
.sk-grow{flex:1}
.sk-tabs{display:flex;gap:18px;align-items:center;height:22px}
.sk-ribbon{display:flex;gap:26px;align-items:center;height:76px;padding:8px 6px;border-bottom:1px solid var(--sk1)}
.sk-group{display:flex;gap:8px;align-items:center}.sk-col{flex-direction:column;align-items:flex-start;gap:12px}
.sk-work{flex:1;min-height:0;display:flex;flex-direction:column;gap:10px}
.sk-ruler{display:flex;padding:0 80px}
.sk-stage{flex:1;min-height:0;display:flex;justify-content:center;overflow:hidden}
.sk-page{width:min(640px,92%);padding:44px 52px;display:flex;flex-direction:column;gap:14px;background:var(--skpage);border-radius:4px;box-shadow:0 1px 8px rgba(0,0,0,.12)}
.sk-page.sk-narrow{width:min(520px,90%)}
.sk-page .sk{height:10px}
.sk-formula{display:flex;gap:10px;align-items:center}
.sk-grid{flex:1;border-radius:4px;background:
linear-gradient(90deg,var(--sk1) 0 44px,transparent 44px),
linear-gradient(var(--sk1) 0 22px,transparent 22px),
repeating-linear-gradient(90deg,transparent 0 119px,var(--sk1) 119px 120px),
repeating-linear-gradient(transparent 0 25px,var(--sk1) 25px 26px);background-color:var(--skpage)}
.sk-slides{flex:1;min-height:0;display:flex;gap:16px}
.sk-thumbs{width:150px;flex:none;display:flex;flex-direction:column;gap:12px;overflow:hidden}
.sk-thumb{width:100%;height:84px;border-radius:5px}.sk-thumb.sk-tall{height:170px}
.sk-slide{width:min(760px,94%);aspect-ratio:16/9;height:auto;align-self:center;border-radius:6px}
.sk-split{flex:1;display:flex;gap:16px;min-height:0}
.sk-code{flex:1;padding:22px 26px;display:flex;flex-direction:column;gap:14px;background:var(--skpage);border-radius:6px;overflow:hidden}
.sk-code .sk{height:10px}
@media (prefers-reduced-motion:reduce){.sk{animation:none}}`

/** The splash page: the app's colour and badge, the file name, one line of why, an animated sea. */
export function openingPageHtml(
  words: OpeningWords,
  fileName: string,
  appName: SplashApp = 'docs',
  tier: SplashTier = 'lite',
  scene?: string,
  /** `window`: the scene fills its own small window; `card`: a small card on a plain backdrop (over a tab) */
  layout: 'window' | 'card' = 'window',
): string {
  const theme = SPLASH_THEMES[appName]
  const rgb = rgbOf(theme.color)
  const sceneId = scene ?? DEFAULT_SCENE_FOR_APP[appName]
  const script = tier === 'minimal' ? '' : `<script>${SCENE_LIB}${SCENE_BOOT}</script>`
  const [bg1, bg2] = sceneMeta(sceneId).bg
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(words.title)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
:root{color-scheme:dark;--accent:${theme.color};--rgb:${rgb};--bg1:${bg1};--bg2:${bg2};--fg:#f3f5fa;--muted:#aab3c8;--backdrop:#eef0f4}
@media (prefers-color-scheme:dark){:root{--backdrop:#15171c}}
html,body{margin:0;height:100%;overflow:hidden}
body{font:14px/1.35 "Segoe UI",system-ui,-apple-system,sans-serif;color:var(--fg);user-select:none;cursor:default}
.stage{position:absolute;inset:0;overflow:hidden;
background:linear-gradient(160deg,var(--bg1) 0%,var(--bg2) 60%,rgba(var(--rgb),.35) 140%);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
body.card{display:flex;align-items:center;justify-content:center;background:var(--backdrop)}
body.card .stage{z-index:2}
body.card .skel{z-index:1}
body.card .stage{position:relative;inset:auto;width:min(480px,86vw);height:min(240px,70vh);border-radius:18px;
box-shadow:0 24px 70px rgba(0,0,0,.38),0 0 0 1px rgba(255,255,255,.1)}
#sea{position:absolute;inset:0;width:100%;height:100%}
.glow{position:absolute;left:50%;bottom:-70px;width:420px;height:200px;margin-left:-210px;border-radius:50%;
background:radial-gradient(closest-side,rgba(var(--rgb),.45),rgba(var(--rgb),0));animation:breathe 3.2s ease-in-out infinite}
body[data-tier="full"] .glow,body[data-tier="lite"] .glow{display:none}
@keyframes breathe{50%{transform:scale(1.15);opacity:.75}}
.bubble{display:none;position:absolute;bottom:-12px;border-radius:50%;background:rgba(var(--rgb),.45);animation:rise linear infinite}
body[data-tier="minimal"] .bubble{display:block}
.b1{left:18%;width:7px;height:7px;animation-duration:6s}.b2{left:52%;width:5px;height:5px;animation-duration:7.5s;animation-delay:1.2s}
.b3{left:80%;width:9px;height:9px;animation-duration:5.4s;animation-delay:.6s}
@keyframes rise{to{transform:translateY(-250px);opacity:0}}
.badge{position:absolute;left:24px;top:22px;width:54px;height:54px;border-radius:13px;display:flex;align-items:center;justify-content:center;
font-weight:700;font-size:${theme.letter.length > 1 ? 16 : 28}px;color:#fff;background:linear-gradient(145deg,rgba(var(--rgb),1),rgba(var(--rgb),.55));
box-shadow:0 0 0 1px rgba(255,255,255,.18),0 8px 26px rgba(var(--rgb),.55);animation:sink 4.2s ease-in-out infinite}
@keyframes sink{0%,100%{transform:translateY(-3px);box-shadow:0 0 0 1px rgba(255,255,255,.18),0 8px 26px rgba(var(--rgb),.55)}
50%{transform:translateY(5px);box-shadow:0 0 0 1px rgba(255,255,255,.1),0 4px 40px rgba(var(--rgb),.8)}}
.text{position:absolute;left:24px;right:24px;bottom:30px}
.title{font-weight:600;font-size:16px}
.name,.hint{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.name{margin-top:2px}.hint{margin-top:2px;color:var(--muted);font-size:12px}
.bar{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,.08);overflow:hidden}
.bar i{display:block;width:34%;height:100%;background:linear-gradient(90deg,transparent,var(--accent),transparent);animation:sweep 1.6s ease-in-out infinite}
@keyframes sweep{from{transform:translateX(-110%)}to{transform:translateX(320%)}}
body{transition:opacity .3s ease}body.leaving{opacity:0}
${layout === 'card' ? SKELETON_CSS : ''}
@media (prefers-reduced-motion:reduce){.badge,.glow,.bubble,.bar i{animation:none}}
</style></head>
<body${layout === 'card' ? ' class="card"' : ''} data-app="${appName}" data-scene="${sceneId}" data-tier="${tier}" data-rgb="${rgb}" data-lt="${lighterRgbOf(theme.color)}">
${layout === 'card' ? skeletonHtml(appName) : ''}
<div class="stage">
<canvas id="sea" aria-hidden="true"></canvas><div class="glow"></div>
<span class="bubble b1"></span><span class="bubble b2"></span><span class="bubble b3"></span>
<div class="badge" aria-hidden="true">${escapeHtml(theme.letter)}</div>
<div class="text" role="status"><div class="title">${escapeHtml(words.title)}</div>
<div class="name">${escapeHtml(fileName)}</div>
<div class="hint">${escapeHtml(words.hint)}</div></div>
<div class="bar" role="progressbar" aria-label="${escapeHtml(words.title)}"><i></i></div>
</div>
${script}
</body></html>`
}

/** Where the person's choices and the pages they imported come from (set once at startup). */
export interface OpeningConfig {
  prefs(): OpeningPrefs
  /** the imported HTML page of an app, or null */
  customHtml(app: SplashApp): string | null
}

let config: OpeningConfig = { prefs: () => DEFAULT_OPENING_PREFS, customHtml: () => null }

export function setOpeningConfig(next: OpeningConfig): void {
  config = next
}

export const openingEnabled = (): boolean => config.prefs().enabled

const MAX_CUSTOM_HTML_BYTES = 512 * 1024

/**
 * The person's own HTML page as the opening scene. It runs with no network at all (not even to
 * load an image or a font from the web) and gets the file name and colours in `window.GENOFFICE_OPEN`
 * and as {{fileName}} {{title}} {{hint}} {{color}} in its text. `body.leaving` is set when it should fade.
 */
export function customPageHtml(
  userHtml: string,
  info: { fileName: string; title: string; hint: string; app: SplashApp; color: string },
): string {
  const csp =
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; media-src data: blob:\">"
  // the data goes in as JSON; a "<" in it must not be able to close the script
  const data = JSON.stringify(info).replace(/</g, '\\u003c')
  const boot = `<script>window.GENOFFICE_OPEN=${data}</script><style>body{transition:opacity .3s ease}body.leaving{opacity:0}</style>`
  const filled = userHtml
    .slice(0, MAX_CUSTOM_HTML_BYTES)
    .replace(/\{\{\s*fileName\s*\}\}/g, () => escapeHtml(info.fileName))
    .replace(/\{\{\s*title\s*\}\}/g, () => escapeHtml(info.title))
    .replace(/\{\{\s*hint\s*\}\}/g, () => escapeHtml(info.hint))
    .replace(/\{\{\s*color\s*\}\}/g, () => escapeHtml(info.color))
  const doctype = /^\s*<!doctype[^>]*>/i.exec(filled)
  return doctype
    ? `${doctype[0]}${csp}${boot}${filled.slice(doctype[0].length)}`
    : `${csp}${boot}${filled}`
}

/** The page to show while a file opens, with the person's choices applied. */
export function buildOpeningPage(options: {
  fileName: string
  lang: string
  kind: OpeningKind
  app: SplashApp
  /** play this scene instead of the one chosen (for a preview) */
  scene?: string
  /** `card`: a small card on a plain backdrop, for laying over a tab */
  layout?: 'window' | 'card'
  /** the machine's own tier, unless the person fixed one */
  forceTier?: SplashTier
}): string {
  const prefs = config.prefs()
  const words = openingWords(options.lang, options.kind)
  const tier = options.forceTier ?? (prefs.tier === 'auto' ? machineTier() : prefs.tier)
  const chosen = options.scene ?? prefs.scenes[options.app]
  if (chosen === CUSTOM_SCENE) {
    const user = config.customHtml(options.app)
    if (user !== null) {
      return customPageHtml(user, {
        fileName: options.fileName,
        title: words.title,
        hint: words.hint,
        app: options.app,
        color: SPLASH_THEMES[options.app].color,
      })
    }
  }
  return openingPageHtml(
    words,
    options.fileName,
    options.app,
    tier,
    chosen === CUSTOM_SCENE ? undefined : chosen,
    options.layout,
  )
}

/** Waits this long before showing, so a quick open does not flash a window. */
export const OPENING_DELAY_MS = 600

export function machineTier(): SplashTier {
  let onBattery = false
  try {
    onBattery = powerMonitor.isOnBatteryPower()
  } catch {
    // no power information: treat as plugged in
  }
  return chooseSplashTier({
    cores: cpus().length,
    memoryGB: totalmem() / 1024 ** 3,
    onBattery,
  })
}

/**
 * Shows the splash after a short delay and returns what closes it. Safe to call with no window
 * (before the app is ready, or in tests): it then does nothing.
 */
export function startOpeningNotice(options: {
  fileName: string
  lang: string
  kind: OpeningKind
  /** the app that will open the file; a .doc opens in Docs, a .ppt in Slides */
  app?: SplashApp
  delayMs?: number
}): { close(): void } {
  let window: BrowserWindow | null = null
  let closed = false
  const timer = setTimeout(() => {
    if (closed || !app.isReady()) return
    window = new BrowserWindow({
      width: 480,
      height: 240,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      center: true,
      backgroundColor: '#0b1226',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
      },
    })
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const html = buildOpeningPage({
      fileName: options.fileName,
      lang: options.lang,
      kind: options.kind,
      app:
        options.app ??
        (options.kind === 'ppt' ? 'slides' : options.kind === 'xls' ? 'sheets' : 'docs'),
    })
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    window.once('ready-to-show', () => {
      if (!closed) window?.showInactive()
    })
  }, options.delayMs ?? OPENING_DELAY_MS)
  return {
    close() {
      closed = true
      clearTimeout(timer)
      if (window && !window.isDestroyed()) window.close()
      window = null
    },
  }
}

/** Plays a scene in a small window for a few seconds, for the settings page's "Preview". It closes by itself, or when you click elsewhere. */
export function previewOpeningScene(options: {
  app: SplashApp
  scene: string
  lang: string
}): void {
  if (!app.isReady()) return
  const window = new BrowserWindow({
    width: 480,
    height: 240,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    center: true,
    backgroundColor: '#0b1226',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const html = buildOpeningPage({
    fileName: options.lang === 'vi' ? 'Bảng tính của tôi.xlsx' : 'My document.xlsx',
    lang: options.lang,
    kind: 'open',
    app: options.app,
    scene: options.scene,
  })
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  const timer = setTimeout(() => {
    if (!window.isDestroyed()) window.close()
  }, 9000)
  window.once('ready-to-show', () => window.show())
  window.on('blur', () => {
    if (!window.isDestroyed()) window.close()
  })
  window.once('closed', () => clearTimeout(timer))
}
