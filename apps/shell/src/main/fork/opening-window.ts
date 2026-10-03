import { cpus, totalmem } from 'node:os'
import { BrowserWindow, app, powerMonitor } from 'electron'

/**
 * A small "Opening…" splash for the seconds a legacy .doc / .ppt takes to be converted. Without it a
 * click on the file seems to do nothing for up to a minute (the online conversion is the slow part)
 * and the person tries again or thinks it failed. It shows only when the wait is noticeable, in the
 * colour of the app that is opening the file, and its animation is as rich as the machine can afford:
 * a jellyfish drifting up through glowing water on a good computer, a lighter version on a modest
 * one, and a calm glow with a progress bar on the weakest, on battery, or when the system asks for
 * reduced motion.
 */

export type SplashApp = 'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html'
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

const EN: Record<'doc' | 'ppt', OpeningWords> = {
  doc: {
    title: 'Opening document…',
    hint: 'Converting the old .doc format. This can take a few seconds.',
  },
  ppt: {
    title: 'Opening presentation…',
    hint: 'Converting the old .ppt format. This can take a few seconds.',
  },
}
const VI: Record<'doc' | 'ppt', OpeningWords> = {
  doc: {
    title: 'Đang mở tài liệu…',
    hint: 'Đang chuyển định dạng .doc cũ, có thể mất vài giây.',
  },
  ppt: {
    title: 'Đang mở bản trình chiếu…',
    hint: 'Đang chuyển định dạng .ppt cũ, có thể mất vài giây.',
  },
}

export const openingWords = (lang: string, kind: 'doc' | 'ppt'): OpeningWords =>
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
 * The jellyfish: a pulsing bell and trailing tentacles rising through the water, with drifting
 * specks. Plain canvas, no libraries; `full` draws more of everything at 60 fps, `lite` fewer at 30,
 * and it stops while the window is hidden.
 */
const JELLY_SCRIPT = `
(function(){
  var body=document.body, tier=body.dataset.tier, rgb=body.dataset.rgb, lt=body.dataset.lt;
  var canvas=document.getElementById('sea'); if(!canvas||tier==='minimal') return;
  var ctx=canvas.getContext('2d'); if(!ctx) return;
  var dpr=Math.min(window.devicePixelRatio||1, tier==='full'?2:1.5);
  var W=canvas.clientWidth, H=canvas.clientHeight;
  canvas.width=Math.round(W*dpr); canvas.height=Math.round(H*dpr); ctx.scale(dpr,dpr);
  var full=tier==='full', fps=full?60:30, step=1000/fps;
  function rnd(a,b){return a+Math.random()*(b-a)}
  var jellies=[], count=full?4:2;
  for(var i=0;i<count;i++) jellies.push({x:rnd(W*0.15,W*0.85), y:rnd(H*0.2,H*1.1), s:rnd(0.55,1.15), p:rnd(0,6.28), v:rnd(10,24), d:rnd(-6,6)});
  jellies.sort(function(a,b){return a.s-b.s});
  var specks=[], nSpecks=full?36:14;
  for(var k=0;k<nSpecks;k++) specks.push({x:rnd(0,W), y:rnd(0,H), r:rnd(0.6,1.8), v:rnd(4,14), p:rnd(0,6.28)});
  function jelly(j,t){
    var pulse=Math.sin(t*2.2+j.p), bw=34*j.s*(1.04-0.1*pulse), bh=26*j.s*(1+0.16*pulse);
    var a=0.35+0.45*(j.s/1.15), x=j.x+Math.sin(t*0.7+j.p)*8*j.s, y=j.y;
    var g=ctx.createRadialGradient(x,y-bh*0.25,2,x,y,bw*1.25);
    g.addColorStop(0,'rgba('+lt+','+Math.min(1,1.15*a)+')'); g.addColorStop(0.55,'rgba('+rgb+','+(0.8*a)+')'); g.addColorStop(1,'rgba('+rgb+',0.05)');
    if(full){ctx.shadowColor='rgba('+rgb+',0.9)'; ctx.shadowBlur=22*j.s}
    ctx.fillStyle=g; ctx.beginPath(); ctx.ellipse(x,y,bw,bh,0,Math.PI,0);
    ctx.quadraticCurveTo(x,y+bh*0.45,x-bw,y); ctx.fill();
    ctx.shadowBlur=0; ctx.strokeStyle='rgba('+lt+','+(0.55*a)+')'; ctx.lineWidth=1; ctx.beginPath(); ctx.ellipse(x,y,bw,bh,0,Math.PI,0); ctx.stroke();
    ctx.lineWidth=Math.max(0.8,1.5*j.s); ctx.lineCap='round';
    var n=full?7:5, len=64*j.s;
    for(var q=0;q<n;q++){
      var ox=x+((q/(n-1))*2-1)*bw*0.85, grad=ctx.createLinearGradient(0,y,0,y+len);
      grad.addColorStop(0,'rgba('+lt+','+(0.75*a)+')'); grad.addColorStop(1,'rgba('+rgb+',0)');
      ctx.strokeStyle=grad; ctx.beginPath(); ctx.moveTo(ox,y+bh*0.15);
      for(var s=1;s<=10;s++){
        var f=s/10; ctx.lineTo(ox+Math.sin(t*2.1+q*0.9+f*4+j.p)*(2+f*10)*j.s, y+bh*0.15+f*len);
      }
      ctx.stroke();
    }
  }
  var last=0, start=performance.now(), running=true;
  document.addEventListener('visibilitychange',function(){running=!document.hidden; if(running) requestAnimationFrame(frame)});
  function frame(now){
    if(!running) return;
    if(now-last<step-1){requestAnimationFrame(frame); return}
    var dt=Math.min(0.1,(now-(last||now))/1000); last=now; var t=(now-start)/1000;
    ctx.clearRect(0,0,W,H);
    var glow=ctx.createRadialGradient(W*0.5,H*1.05,10,W*0.5,H*1.05,H*1.1);
    glow.addColorStop(0,'rgba('+rgb+','+(0.30+0.08*Math.sin(t*1.3))+')'); glow.addColorStop(1,'rgba('+rgb+',0)');
    ctx.fillStyle=glow; ctx.fillRect(0,0,W,H);
    ctx.globalCompositeOperation='lighter';
    for(var i=0;i<specks.length;i++){var c=specks[i]; c.y-=c.v*dt; c.x+=Math.sin(t+c.p)*6*dt;
      if(c.y<-4){c.y=H+4; c.x=rnd(0,W)}
      ctx.fillStyle='rgba('+rgb+','+(0.25+0.2*Math.sin(t*2+c.p))+')'; ctx.beginPath(); ctx.arc(c.x,c.y,c.r,0,6.283); ctx.fill();}
    for(var j=0;j<jellies.length;j++){var e=jellies[j]; e.y-=e.v*dt; e.x+=e.d*dt;
      if(e.y<-90||e.x<-40||e.x>W+40){e.y=H+70; e.x=rnd(W*0.1,W*0.9); e.d=rnd(-6,6)}
      jelly(e,t);}
    ctx.globalCompositeOperation='source-over';
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
`

/** The splash page: the app's colour and badge, the file name, one line of why, an animated sea. */
export function openingPageHtml(
  words: OpeningWords,
  fileName: string,
  appName: SplashApp = 'docs',
  tier: SplashTier = 'lite',
): string {
  const theme = SPLASH_THEMES[appName]
  const rgb = rgbOf(theme.color)
  const script = tier === 'minimal' ? '' : `<script>${JELLY_SCRIPT}</script>`
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(words.title)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
:root{color-scheme:dark;--accent:${theme.color};--rgb:${rgb};--bg1:#0b1226;--bg2:#101a38;--fg:#f3f5fa;--muted:#aab3c8}
html,body{margin:0;height:100%;overflow:hidden}
body{position:relative;font:14px/1.35 "Segoe UI",system-ui,-apple-system,sans-serif;color:var(--fg);user-select:none;cursor:default;
background:linear-gradient(160deg,var(--bg1) 0%,var(--bg2) 60%,rgba(var(--rgb),.35) 140%);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
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
@media (prefers-reduced-motion:reduce){.badge,.glow,.bubble,.bar i{animation:none}}
</style></head>
<body data-tier="${tier}" data-rgb="${rgb}" data-lt="${lighterRgbOf(theme.color)}">
<canvas id="sea" aria-hidden="true"></canvas><div class="glow"></div>
<span class="bubble b1"></span><span class="bubble b2"></span><span class="bubble b3"></span>
<div class="badge" aria-hidden="true">${escapeHtml(theme.letter)}</div>
<div class="text" role="status"><div class="title">${escapeHtml(words.title)}</div>
<div class="name">${escapeHtml(fileName)}</div>
<div class="hint">${escapeHtml(words.hint)}</div></div>
<div class="bar" role="progressbar" aria-label="${escapeHtml(words.title)}"><i></i></div>
${script}
</body></html>`
}

/** Waits this long before showing, so a quick open does not flash a window. */
export const OPENING_DELAY_MS = 600

function machineTier(): SplashTier {
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
  kind: 'doc' | 'ppt'
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
    const html = openingPageHtml(
      openingWords(options.lang, options.kind),
      options.fileName,
      options.app ?? (options.kind === 'ppt' ? 'slides' : 'docs'),
      machineTier(),
    )
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
