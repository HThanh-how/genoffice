import { cpus, totalmem } from 'node:os'
import { BrowserWindow, app, powerMonitor } from 'electron'
import { CUSTOM_SCENE, DEFAULT_OPENING_PREFS } from '../../shared/opening-scenes-meta'
import type { OpeningApp, OpeningPrefs } from '../../shared/opening-scenes-meta'
import { chooseOpeningCardId } from '../../shared/opening-card-groups'

/** What each app drew at random last time, so the next open plays another card. */
const lastRandomPicks = new Map<OpeningApp, string>()

import { sampleFileName } from '../../shared/opening-card-css'
export * from '../../shared/opening-page'
import {
  SPLASH_THEMES,
  openingWords,
  escapeHtml,
  skeletonHtml,
  openingPageHtml,
  chooseSplashTier,
} from '../../shared/opening-page'
import type { SplashApp, SplashTier, OpeningKind } from '../../shared/opening-page'
import { getBuiltInCard } from '../../shared/opening-card-families'
import { buildIsolatedHtmlHostDocument } from '../../shared/opening-card-html-sanitizer'

/** Where the person's choices and the pages they imported come from (set once at startup). */
export interface OpeningConfig {
  prefs(): OpeningPrefs
  /** the imported HTML page of an app, or null */
  customHtml(app: SplashApp): string | null
  /** data URL getter for personal media assets */
  mediaDataUrl?(assetId: string): string | null
  /** getter for managed HTML card assets ({ html, css }) */
  htmlCardContent?(assetId: string): { html: string; css: string } | null
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
  const chosen = chooseOpeningCardId(prefs, options.app, options.scene, lastRandomPicks)
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

  const cardDef = getBuiltInCard(chosen) ?? prefs.customCards?.find((c) => c.id === chosen)

  // AI-generated or custom HTML opening card scene
  if (cardDef?.contentKind === 'ai-html' && cardDef.htmlAssetId && config.htmlCardContent) {
    const htmlAsset = config.htmlCardContent(cardDef.htmlAssetId)
    if (htmlAsset) {
      return buildIsolatedHtmlHostDocument(
        htmlAsset.html,
        htmlAsset.css,
        {
          fileName: options.fileName,
          title: words.title,
          hint: words.hint,
          appName: SPLASH_THEMES[options.app].letter,
          accentColor: cardDef.material.accentColor || SPLASH_THEMES[options.app].color,
        },
        {
          reducedMotion: tier === 'minimal',
          isCardLayout: options.layout === 'card',
          skeletonHtml: options.layout === 'card' ? skeletonHtml(options.app) : undefined,
        },
      )
    }
  }

  let mediaDataUrl: string | undefined
  if (cardDef?.mediaAssetId && config.mediaDataUrl) {
    const url = config.mediaDataUrl(cardDef.mediaAssetId)
    if (url) mediaDataUrl = url
  }

  return openingPageHtml(
    words,
    options.fileName,
    options.app,
    tier,
    chosen === CUSTOM_SCENE ? undefined : chosen,
    options.layout,
    cardDef,
    mediaDataUrl,
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

export { sampleFileName }

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
    fileName: sampleFileName(options.app, options.lang),
    lang: options.lang,
    kind: 'open',
    app: options.app,
    scene: options.scene,
    layout: 'card',
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
