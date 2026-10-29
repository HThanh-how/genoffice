import type { WebContents } from 'electron'

/**
 * While a tab opens a document, the editor's own tab strip and ribbon come in on their own: every
 * real control starts hidden and settles into its real place, left to right, out of a soft blur,
 * its label decoding letter by letter out of shaded blocks (░▒▓█), while one band of light sweeps
 * across the ribbon. Nothing is drawn that the editor does not have, so there is nothing to line
 * up: the controls are the real ones, hidden and then shown. Only opacity, blur and transform
 * animate.
 *
 * The decode look is adapted from ascii-reveal's `dither` glyphs
 * (https://github.com/quanhoangindex/ascii-reveal, MIT, © 2026 Quan Hoang).
 */

const HIDDEN = '.ribbon-tab,.ribbon-body button,.ribbon-body select,.ribbon-body input'

export const OPENING_REVEAL_CSS = `
html.gx-pre :is(${HIDDEN}){opacity:0!important}
html.gx-go :is(${HIDDEN}){animation:gx-in 640ms cubic-bezier(.16,.84,.3,1) both;animation-delay:calc(var(--gx-base,250ms) + var(--gx-i,0) * var(--gx-step,12ms))}
@keyframes gx-in{from{opacity:0;filter:blur(6px);transform:translateY(5px) scale(.96)}60%{filter:blur(1px)}to{opacity:1;filter:blur(0);transform:none}}
#gx-sheen{position:fixed;pointer-events:none;overflow:hidden;z-index:2147483000}
#gx-sheen>i{position:absolute;top:-10%;bottom:-10%;left:0;width:38%;opacity:0;transform:translateX(-120%) skewX(-16deg);
background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--gx-c,#8aa4ff) 38%,transparent) 45%,rgba(255,255,255,.34) 50%,color-mix(in srgb,var(--gx-c,#8aa4ff) 38%,transparent) 55%,transparent);
animation:gx-sheen 1250ms cubic-bezier(.4,.1,.3,1) var(--gx-base,250ms) both}
@keyframes gx-sheen{0%{opacity:0;transform:translateX(-120%) skewX(-16deg)}15%{opacity:.5}85%{opacity:.5}100%{opacity:0;transform:translateX(330%) skewX(-16deg)}}
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
  var BLOCKS = '░▒▓█▒░▓'
  var stop = null
  function clean() {
    if (stop) stop()
    de.classList.remove('gx-pre', 'gx-go')
    var sheen = document.getElementById('gx-sheen')
    if (sheen) sheen.remove()
  }
  function hash(a, b, c) {
    var h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(((b | 0) + 0x9e3779b9) | 0, 0x85ebca6b) ^ Math.imul(((c | 0) + 0x632be5ab) | 0, 0xc2b2ae35)
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15
    return (h >>> 0) / 4294967296
  }
  function textNodesOf(el) {
    var out = []
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (var n = walker.nextNode(); n; n = walker.nextNode()) if (/\S/.test(n.nodeValue)) out.push(n)
    return out
  }
  function go(ribbon) {
    var all = Array.prototype.slice.call(ribbon.querySelectorAll(HIDDEN))
    var items = all.map(function (el) { return { el: el, box: el.getBoundingClientRect() } })
      .filter(function (it) { return it.box.width > 6 && it.box.height > 6 })
    items.sort(function (a, b) { return a.box.left - b.box.left || a.box.top - b.box.top })
    var ribbonBox = ribbon.getBoundingClientRect()
    var bottom = Math.ceil(ribbonBox.bottom)
    var step = Math.max(4, Math.min(14, 520 / Math.max(1, items.length)))
    var base = 250
    var accent = getComputedStyle(de).getPropertyValue('--accent').trim()
    de.style.setProperty('--gx-step', step + 'ms')
    de.style.setProperty('--gx-base', base + 'ms')
    if (accent) de.style.setProperty('--gx-c', accent)
    var labels = []
    items.forEach(function (it, i) {
      it.el.style.setProperty('--gx-i', String(i))
      textNodesOf(it.el).forEach(function (node) {
        labels.push({ node: node, text: node.nodeValue, shown: null, start: base + i * step + 60, seed: i * 31 + labels.length })
      })
    })
    var sheen = document.createElement('div')
    sheen.id = 'gx-sheen'
    sheen.style.cssText = 'left:' + ribbonBox.left + 'px;top:' + ribbonBox.top + 'px;width:' + ribbonBox.width + 'px;height:' + ribbonBox.height + 'px'
    sheen.appendChild(document.createElement('i'))
    document.body.appendChild(sheen)
    de.classList.remove('gx-pre')
    de.classList.add('gx-go')
    done(bottom)
    var t0 = performance.now()
    var raf = 0
    var CHAR_MS = 26
    function frame() {
      var t = performance.now() - t0
      var live = false
      labels.forEach(function (l) {
        if (l.finished) return
        var k = (t - l.start) / CHAR_MS
        var out = ''
        for (var c = 0; c < l.text.length; c++) {
          var ch = l.text.charAt(c)
          if (ch === ' ' || k - c > 6) out += ch
          else if (k - c < 0) out += BLOCKS.charAt(Math.floor(hash(c, l.seed, 3) * BLOCKS.length))
          else out += BLOCKS.charAt(Math.floor(hash(c, l.seed, Math.floor(t / 70)) * BLOCKS.length))
        }
        var complete = k - (l.text.length - 1) > 6
        var next = complete ? l.text : out
        if (l.shown === null || l.node.nodeValue === l.shown) { l.node.nodeValue = next; l.shown = next }
        if (complete) l.finished = true
        else live = true
      })
      raf = live ? requestAnimationFrame(frame) : 0
    }
    raf = requestAnimationFrame(frame)
    stop = function () {
      if (raf) cancelAnimationFrame(raf)
      labels.forEach(function (l) { if (l.shown !== null && l.node.nodeValue === l.shown) l.node.nodeValue = l.text })
    }
    setTimeout(function () {
      clean()
      de.style.removeProperty('--gx-step')
      de.style.removeProperty('--gx-base')
      de.style.removeProperty('--gx-c')
      items.forEach(function (it) { it.el.style.removeProperty('--gx-i') })
    }, base + items.length * step + 1800)
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
