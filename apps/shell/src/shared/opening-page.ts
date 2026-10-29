import type { OpeningCardDefinition } from './opening-card-types'
import { buildMaterialCss } from './opening-card-css'
import { DEFAULT_SCENE_FOR_APP, sceneMeta, type OpeningApp } from './opening-scenes-meta'
import { SCENE_BOOT, SCENE_LIB } from './opening-scenes-lib'

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

export const escapeHtml = (text: string): string =>
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
 * Behind the opening card, over the document area only: the page the editor is about to show, in
 * the app's colour. The editor's own tab strip and ribbon are not drawn here (they are the real
 * ones, revealing themselves above this); the card leaves them uncovered.
 */
export function backdropHtml(_appName: SplashApp): string {
  return '<div class="skel" aria-hidden="true"></div>'
}

/** `root` is `:root` in a page of its own and `:host` when the page is drawn inside a shadow root. */
const backdropCss = (root: string): string => `${root}{--skbg:#f7f8fa;--skhaze:rgba(var(--rgb),.14)}
@media (prefers-color-scheme:dark){${root}{--skbg:#1a1d22;--skhaze:rgba(var(--rgb),.2)}}
.skel{position:absolute;inset:0;background:var(--skbg);overflow:hidden}
.skel::before{content:"";position:absolute;left:-10%;right:-10%;top:-60px;height:220px;background:radial-gradient(closest-side,var(--skhaze),transparent);animation:haze 4.6s ease-in-out infinite}
@keyframes haze{50%{opacity:.55;transform:scale(1.08)}}
@media (prefers-reduced-motion:reduce){.skel::before{animation:none}}`

/** The pieces of the splash page, so it can be written out as a document or drawn inside a shadow root. */
export interface OpeningPageParts {
  /** the stylesheet */
  css: string
  /** the class, attributes and children of what is `<body>` in a page of its own */
  bodyClass: string
  bodyAttrs: string
  bodyInner: string
  /** the scene script (the lib and its boot), empty when nothing runs */
  script: string
  sceneId: string
  isCanvasScene: boolean
  rgb: string
  lt: string
  title: string
}

/**
 * Where the page is shown. `document`: a page of its own (the opening window): `body` is the page
 * and lengths are those of the window. `shadow`: inside a shadow root of the studio: `.pg` stands in
 * for `body`, `:host` for `:root`, and the size container it is in for the window.
 */
export type OpeningPageTarget = 'document' | 'shadow'

/** The splash page: the app's colour and badge, the file name, one line of why, an animated sea. */
export function openingPageHtml(
  words: OpeningWords,
  fileName: string,
  appName: SplashApp = 'docs',
  tier: SplashTier = 'lite',
  scene?: string,
  /** `window`: the scene fills its own small window; `card`: a small card on a plain backdrop (over a tab) */
  layout: 'window' | 'card' = 'window',
  cardDef?: OpeningCardDefinition,
  mediaDataUrl?: string,
): string {
  const parts = openingPageParts(
    words,
    fileName,
    appName,
    tier,
    scene,
    layout,
    cardDef,
    mediaDataUrl,
    'document',
  )
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(parts.title)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
${parts.css}
</style></head>
<body${parts.bodyClass ? ` class="${parts.bodyClass}"` : ''}${parts.bodyAttrs}>
${parts.bodyInner}
${parts.script}
</body></html>`
}

export function openingPageParts(
  words: OpeningWords,
  fileName: string,
  appName: SplashApp = 'docs',
  tier: SplashTier = 'lite',
  scene?: string,
  /** `window`: the scene fills its own small window; `card`: a small card on a plain backdrop (over a tab) */
  layout: 'window' | 'card' = 'window',
  cardDef?: OpeningCardDefinition,
  mediaDataUrl?: string,
  target: OpeningPageTarget = 'document',
): OpeningPageParts {
  const theme = SPLASH_THEMES[appName]
  const rgb = rgbOf(theme.color)
  const isCanvasScene = !cardDef || cardDef.contentKind === 'canvas-scene'
  const sceneId = cardDef?.sceneId ?? scene ?? DEFAULT_SCENE_FOR_APP[appName]
  const script =
    !isCanvasScene || tier === 'minimal' ? '' : `<script>${SCENE_LIB}${SCENE_BOOT}</script>`
  const [bg1, bg2] = sceneMeta(sceneId).bg

  let materialCss = ''
  let mediaStyle = ''
  if (cardDef?.material) {
    const built = buildMaterialCss(cardDef.material, { appColor: theme.color })
    materialCss = built.inlineCss
  }
  if (mediaDataUrl) {
    const dim =
      typeof cardDef?.mediaDim === 'number' && !Number.isNaN(cardDef.mediaDim)
        ? Math.max(0, Math.min(1, cardDef.mediaDim))
        : 0.25
    const fit = cardDef?.mediaFit === 'contain' ? 'contain' : 'cover'
    if (/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(mediaDataUrl)) {
      mediaStyle = `.stage { background-image: linear-gradient(rgba(0,0,0,${dim}), rgba(0,0,0,${dim})), url('${mediaDataUrl}') !important; background-size: ${fit} !important; background-position: center !important; }`
    }
  }

  const R = target === 'shadow' ? ':host' : ':root'
  const B = target === 'shadow' ? '.pg' : 'body'
  const VW = target === 'shadow' ? 'cqw' : 'vw'
  const VH = target === 'shadow' ? 'cqh' : 'vh'
  const css = `${R}{color-scheme:dark;--accent:${theme.color};--rgb:${rgb};--bg1:${bg1};--bg2:${bg2};--fg:#f3f5fa;--muted:#aab3c8;--backdrop:#eef0f4}
@media (prefers-color-scheme:dark){${R}{--backdrop:#15171c}}
html,${B}{margin:0;height:100%;overflow:hidden}
${B}{font:14px/1.35 "Segoe UI",system-ui,-apple-system,sans-serif;color:var(--fg);user-select:none;cursor:default}
.stage{position:absolute;inset:0;overflow:hidden;
background:linear-gradient(160deg,var(--bg1) 0%,var(--bg2) 60%,rgba(var(--rgb),.35) 140%);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
${B}.card{display:flex;align-items:center;justify-content:center;background:var(--backdrop)}
${B}.card .stage{z-index:2}
${B}.card .skel{z-index:1}
${B}.card .stage{position:relative;inset:auto;width:min(480px,86${VW});height:min(240px,70${VH});border-radius:18px;
box-shadow:0 24px 70px rgba(0,0,0,.38),0 0 0 1px rgba(255,255,255,.1)}
#sea{position:absolute;inset:0;width:100%;height:100%}
.glow{position:absolute;left:50%;bottom:-70px;width:420px;height:200px;margin-left:-210px;border-radius:50%;
background:radial-gradient(closest-side,rgba(var(--rgb),.45),rgba(var(--rgb),0));animation:breathe 3.2s ease-in-out infinite}
${B}[data-tier="full"] .glow,${B}[data-tier="lite"] .glow{display:none}
@keyframes breathe{50%{transform:scale(1.15);opacity:.75}}
.bubble{display:none;position:absolute;bottom:-12px;border-radius:50%;background:rgba(var(--rgb),.45);animation:rise linear infinite}
${B}[data-tier="minimal"] .bubble{display:block}
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
${B}{transition:opacity .3s ease}${B}.leaving{opacity:0}
${layout === 'card' ? backdropCss(R) : ''}
${materialCss}
${mediaStyle}
@media (prefers-reduced-motion:reduce){.badge,.glow,.bubble,.bar i{animation:none}}
${target === 'shadow' ? '.pg{position:relative;width:100%;height:100%}' : ''}`
  return {
    css,
    bodyClass: layout === 'card' ? 'card' : '',
    bodyAttrs: ` data-app="${appName}" data-scene="${sceneId}" data-tier="${tier}" data-rgb="${rgb}" data-lt="${lighterRgbOf(theme.color)}"`,
    bodyInner: `${layout === 'card' ? backdropHtml(appName) : ''}
<div class="stage">
${isCanvasScene ? '<canvas id="sea" aria-hidden="true"></canvas><div class="glow"></div>' : ''}
<span class="bubble b1"></span><span class="bubble b2"></span><span class="bubble b3"></span>
<div class="badge" aria-hidden="true">${escapeHtml(theme.letter)}</div>
<div class="text" role="status"><div class="title">${escapeHtml(words.title)}</div>
<div class="name">${escapeHtml(fileName)}</div>
<div class="hint">${escapeHtml(words.hint)}</div></div>
<div class="bar" role="progressbar" aria-label="${escapeHtml(words.title)}"><i></i></div>
</div>`,
    script,
    sceneId,
    isCanvasScene,
    rgb,
    lt: lighterRgbOf(theme.color),
    title: words.title,
  }
}

/** The gradient the real opening page paints behind a scene (its `.stage` rule), for anything that shows the scene's canvas on its own. */
export function sceneStageBackground(sceneId: string, app: SplashApp = 'docs'): string {
  const [bg1, bg2] = sceneMeta(sceneId).bg
  return `linear-gradient(160deg,${bg1} 0%,${bg2} 60%,rgba(${rgbOf(SPLASH_THEMES[app].color)},.35) 140%)`
}

/** The size of the opening window's stage; thumbnails are taken at it so a scene is composed as it is in the real window. */
export const THUMB_SIZE = { width: 480, height: 240 } as const

/**
 * The real opening page cut down to its scene: only the canvas, no badge, text or bar. Once the
 * scene has run for its `thumbMs` it posts its canvas to the parent as `{ goThumb: id, url }`, so a
 * gallery can show a frame of the very scene code the opening window runs. Load it in a hidden
 * iframe of `THUMB_SIZE`, sandboxed with `allow-scripts`.
 */
export function sceneThumbnailPage(
  sceneId: string,
  thumbId: string,
  app: SplashApp = 'docs',
): string {
  const words = openingWords('en', 'open')
  const page = openingPageHtml(words, '', app, 'lite', sceneId, 'window')
  const delay = Math.max(100, sceneMeta(sceneId).thumbMs ?? 100)
  const extra =
    '<style>.stage{background:none!important;box-shadow:none!important}' +
    '.badge,.text,.bar,.bubble,.glow{display:none!important}html,body{background:transparent}</style>'
  const send =
    "<script>setTimeout(function(){var c=document.getElementById('sea');var u='';" +
    "try{u=c.toDataURL('image/png')}catch(e){}" +
    `parent.postMessage({goThumb:${JSON.stringify(thumbId)},url:u},'*')},${delay})</script>`
  return page.replace('</head>', () => `${extra}</head>`).replace('</body>', () => `${send}</body>`)
}
