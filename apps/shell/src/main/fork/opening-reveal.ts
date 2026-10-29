import type { WebContents } from 'electron'

/**
 * While a tab opens a document, the editor's own tab strip and ribbon come in on their own: every
 * real icon starts hidden and resolves, left to right, out of a haze, while a tile of shaded
 * blocks (░▒▓█) with a darker dither band sweeping across it sits exactly on top of it and fades
 * as the icon sharpens. Nothing is drawn that the editor does not have, so the icons land in their
 * real place. The tiles are measured from the real buttons; the buttons are only hidden and shown.
 *
 * The glyph rows and the dither look are adapted from ascii-reveal's `dither` skeleton
 * (https://github.com/quanhoangindex/ascii-reveal, MIT, © 2026 Quan Hoang).
 */

const HIDDEN = '.ribbon-tab,.ribbon-body button,.ribbon-body select,.ribbon-body input'

export const OPENING_REVEAL_CSS = `
html.gx-pre :is(${HIDDEN}){opacity:0!important}
html.gx-go :is(${HIDDEN}){animation:gx-in 720ms cubic-bezier(.2,.7,.2,1) both;animation-delay:calc(var(--gx-base,350ms) + var(--gx-i,0) * var(--gx-step,12ms))}
@keyframes gx-in{from{opacity:0;filter:blur(7px)}55%{opacity:.85;filter:blur(2px)}to{opacity:1;filter:blur(0)}}
#gx-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483000;overflow:hidden}
.gx-t{position:absolute;overflow:hidden;white-space:pre;font:9px/9px ui-monospace,"Cascadia Mono",Consolas,monospace;letter-spacing:-.02em;color:var(--gx-c,#6b7a99);border-radius:6px;background:color-mix(in srgb,var(--gx-c,#6b7a99) 9%,transparent);
animation:gx-tile-in 240ms ease-out both,gx-tile-out 420ms ease-in forwards;animation-delay:calc(var(--gx-i) * 10ms),var(--gx-out)}
.gx-t>span{position:absolute;left:0;top:0}
.gx-b{opacity:.3}
.gx-w{opacity:.85;-webkit-mask:linear-gradient(90deg,transparent,#000 45%,#000 55%,transparent) -120% 0/60% 100% no-repeat;mask:linear-gradient(90deg,transparent,#000 45%,#000 55%,transparent) -120% 0/60% 100% no-repeat;
animation:gx-sweep 1.3s cubic-bezier(.45,.05,.55,.95) infinite;animation-delay:calc(var(--gx-x) * 900ms)}
.gx-w2{animation-name:gx-sweep,gx-flip;animation-duration:1.3s,.26s;animation-timing-function:cubic-bezier(.45,.05,.55,.95),steps(1)}
@keyframes gx-tile-in{from{opacity:0;filter:blur(6px)}to{opacity:1;filter:blur(0)}}
@keyframes gx-tile-out{to{opacity:0;filter:blur(4px)}}
@keyframes gx-sweep{to{-webkit-mask-position:220% 0;mask-position:220% 0}}
@keyframes gx-flip{50%{opacity:0}}
`

/**
 * Runs in the tab's page. Resolves with the pixel height of the ribbon once it is on screen (0 when
 * there is none), so the opening card can leave it uncovered.
 */
export const OPENING_REVEAL_SCRIPT = `(function () {
  if (window.__gxReveal) return window.__gxReveal
  var de = document.documentElement
  var done
  var promise = new Promise(function (resolve) { done = resolve })
  window.__gxReveal = promise
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { done(0); return promise }
  de.classList.add('gx-pre')
  var HIDDEN = ${JSON.stringify(HIDDEN)}
  function clean() {
    de.classList.remove('gx-pre', 'gx-go')
    var layer = document.getElementById('gx-layer')
    if (layer) layer.remove()
  }
  function hash(a, b, c) {
    var h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(((b | 0) + 0x9e3779b9) | 0, 0x85ebca6b) ^ Math.imul(((c | 0) + 0x632be5ab) | 0, 0xc2b2ae35)
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15
    return (h >>> 0) / 4294967296
  }
  function rows(seed, nRows, len, ramp) {
    var out = []
    for (var r = 0; r < nRows; r++) {
      var line = ''
      for (var i = 0; i < len; i++) line += ramp.charAt(Math.floor(Math.pow(hash(i, seed + r, 29), 0.9) * ramp.length))
      out.push(line)
    }
    return out.join('\\n')
  }
  function go(ribbon) {
    var all = Array.prototype.slice.call(ribbon.querySelectorAll(HIDDEN))
    var items = all.map(function (el) { return { el: el, box: el.getBoundingClientRect() } })
      .filter(function (it) { return it.box.width > 6 && it.box.height > 6 })
    items.sort(function (a, b) { return a.box.left - b.box.left || a.box.top - b.box.top })
    var ribbonBox = ribbon.getBoundingClientRect()
    var bottom = Math.ceil(ribbonBox.bottom)
    var width = Math.max(1, ribbonBox.width)
    var step = Math.max(4, Math.min(16, 600 / Math.max(1, items.length)))
    var base = 350
    var layer = document.createElement('div')
    layer.id = 'gx-layer'
    var accent = getComputedStyle(de).getPropertyValue('--accent').trim()
    if (accent) layer.style.setProperty('--gx-c', accent)
    de.style.setProperty('--gx-step', step + 'ms')
    de.style.setProperty('--gx-base', base + 'ms')
    items.forEach(function (it, i) {
      it.el.style.setProperty('--gx-i', String(i))
      var b = it.box
      var cols = Math.ceil(b.width / 5.4) + 1
      var nRows = Math.max(1, Math.ceil(b.height / 9))
      var t = document.createElement('i')
      t.className = 'gx-t'
      t.style.cssText = 'left:' + b.left + 'px;top:' + b.top + 'px;width:' + b.width + 'px;height:' + b.height + 'px;--gx-i:' + i +
        ';--gx-x:' + (b.left / width).toFixed(3) + ';--gx-out:' + (base + i * step + 80) + 'ms'
      var seed = 41 + i * 13
      var layers = [['gx-b', '░░░░▒', 0], ['gx-w', '▒▓▓█▓▒', 300], ['gx-w gx-w2', '▒▓▓█▓▒', 600]]
      layers.forEach(function (l) {
        var s = document.createElement('span')
        s.className = l[0]
        s.textContent = rows(seed + l[2], nRows, cols, l[1])
        t.appendChild(s)
      })
      layer.appendChild(t)
    })
    document.body.appendChild(layer)
    de.classList.remove('gx-pre')
    de.classList.add('gx-go')
    done(bottom)
    setTimeout(function () {
      clean()
      de.style.removeProperty('--gx-step')
      de.style.removeProperty('--gx-base')
      items.forEach(function (it) { it.el.style.removeProperty('--gx-i') })
    }, base + items.length * step + 1400)
  }
  var tries = 0
  function look() {
    var ribbon = document.querySelector('.ribbon')
    if (ribbon && ribbon.querySelector('.ribbon-body button')) {
      requestAnimationFrame(function () { requestAnimationFrame(function () { go(ribbon) }) })
      return
    }
    if (++tries > 200) { clean(); done(0); return }
    setTimeout(look, 50)
  }
  look()
  return promise
})()`

/**
 * Start the opening reveal on a tab's page as soon as its document exists. `onRibbon` receives the
 * ribbon's height (0 when the page has none). Never throws: the editor works without it.
 */
export function attachOpeningReveal(wc: WebContents, onRibbon: (height: number) => void): void {
  const start = (): void => {
    if (wc.isDestroyed()) return
    void wc.insertCSS(OPENING_REVEAL_CSS).catch(() => undefined)
    wc.executeJavaScript(OPENING_REVEAL_SCRIPT)
      .then((height: unknown) => {
        if (typeof height === 'number' && height > 0) onRibbon(height)
      })
      .catch(() => undefined)
  }
  wc.once('dom-ready', start)
}
