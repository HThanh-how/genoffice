import type { WebContents } from 'electron'

/**
 * While a tab opens a document, the editor's own tab strip and ribbon come in on their own: every
 * real control starts hidden and settles into its real place, left to right, out of a soft blur,
 * its label decoding letter by letter (a glyph that thickens from a dot to a block, then scrambled
 * letters, then the real one, as in ascii-reveal's `decode` preset), while one band of light sweeps
 * across the ribbon. Nothing is drawn that the editor does not have, so there is nothing to line
 * up: the controls are the real ones, hidden and then shown. Only opacity, blur and transform
 * animate.
 *
 * The decode is adapted from ascii-reveal's `decode` preset
 * (https://github.com/quanhoangindex/ascii-reveal, MIT, © 2026 Quan Hoang).
 */

const HIDDEN = '.ribbon-tab,.ribbon-body button,.ribbon-body select,.ribbon-body input'

export const OPENING_REVEAL_CSS = `
html.gx-pre :is(${HIDDEN}){opacity:0!important}
html.gx-go :is(${HIDDEN}){animation:gx-in 640ms cubic-bezier(.16,.84,.3,1) both;animation-delay:calc(var(--gx-base,250ms) + var(--gx-i,0) * var(--gx-step,12ms));-webkit-text-fill-color:transparent}
#gx-text{position:fixed;pointer-events:none;z-index:2147483000}
@keyframes gx-in{from{opacity:0;filter:blur(6px);transform:translateY(5px) scale(.96)}60%{filter:blur(1px)}to{filter:blur(0);transform:none}}
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
  var RAMP = ' .:-=+*#%@'
  var SCRAMBLE = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&*+=?/'
  var stop = null
  function clean() {
    if (stop) stop()
    de.classList.remove('gx-pre', 'gx-go')
    var sheen = document.getElementById('gx-sheen')
    if (sheen) sheen.remove()
    var text = document.getElementById('gx-text')
    if (text) text.remove()
  }
  function hash(a, b, c) {
    var h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(((b | 0) + 0x9e3779b9) | 0, 0x85ebca6b) ^ Math.imul(((c | 0) + 0x632be5ab) | 0, 0xc2b2ae35)
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15
    return (h >>> 0) / 4294967296
  }
  function textNodesOf(el) {
    var out = []
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (var n = walker.nextNode(); n; n = walker.nextNode()) if (/\\S/.test(n.nodeValue)) out.push(n)
    return out
  }
  function go(ribbon) {
    de.classList.remove('gx-pre')
    var all = Array.prototype.slice.call(ribbon.querySelectorAll(HIDDEN))
    var items = all.map(function (el) { return { el: el, box: el.getBoundingClientRect(), alpha: parseFloat(getComputedStyle(el).opacity) } })
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

    // every letter of every label: where it will be, when it starts and when it lands
    var dpr = Math.min(2, window.devicePixelRatio || 1)
    var canvas = document.createElement('canvas')
    canvas.id = 'gx-text'
    canvas.width = Math.max(1, Math.ceil(ribbonBox.width * dpr))
    canvas.height = Math.max(1, Math.ceil(ribbonBox.height * dpr))
    canvas.style.cssText = 'left:' + ribbonBox.left + 'px;top:' + ribbonBox.top + 'px;width:' + ribbonBox.width + 'px;height:' + ribbonBox.height + 'px'
    var ctx = canvas.getContext('2d')
    var range = document.createRange()
    var chars = []
    var lastEnd = 0
    items.forEach(function (it, i) {
      it.el.style.setProperty('--gx-i', String(i))
      textNodesOf(it.el).forEach(function (node) {
        var cs = getComputedStyle(node.parentElement)
        var label = { alpha: isNaN(it.alpha) ? 1 : it.alpha, color: cs.color, size: cs.fontSize, font: cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily, asc: 0, desc: 0 }
        ctx.font = label.font
        var m = ctx.measureText('Hg')
        label.asc = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent
        label.desc = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent
        var text = node.nodeValue
        var n = text.length
        var spread = Math.min(420, 80 + n * 10)
        var seed = i * 31 + chars.length
        for (var c = 0; c < n; c++) {
          var ch = text.charAt(c)
          if (/\\s/.test(ch)) continue
          range.setStart(node, c)
          range.setEnd(node, c + 1)
          var r = range.getBoundingClientRect()
          if (!r.width) continue
          var s0 = base + i * step + 40 + (c / n) * spread * 0.72 + hash(c, seed, 1) * spread * 0.28
          var s1 = s0 + 170 + hash(c, seed, 2) * 130
          if (s1 > lastEnd) lastEnd = s1
          chars.push({ ch: ch, x: r.left - ribbonBox.left, y: r.top - ribbonBox.top, w: r.width, h: r.height, s0: s0, s1: s1, ph: hash(c, seed, 3) * 1000, k: chars.length, label: label })
        }
      })
    })
    document.body.appendChild(canvas)

    var sheen = document.createElement('div')
    sheen.id = 'gx-sheen'
    sheen.style.cssText = 'left:' + ribbonBox.left + 'px;top:' + ribbonBox.top + 'px;width:' + ribbonBox.width + 'px;height:' + ribbonBox.height + 'px'
    sheen.appendChild(document.createElement('i'))
    document.body.appendChild(sheen)
    de.classList.add('gx-go')
    done(bottom)

    var t0 = performance.now()
    var raf = 0
    var FLASH_MS = 420
    function frame() {
      var t = performance.now() - t0
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, ribbonBox.width, ribbonBox.height)
      chars.forEach(function (c) {
        if (t < c.s0) return
        var L = c.label
        if (t < c.s1) {
          var q = (t - c.s0) / (c.s1 - c.s0)
          var tick = Math.floor((t + c.ph) / 60)
          var g
          if (q < 0.7) {
            var idx = 1 + Math.floor((q / 0.7) * (RAMP.length - 1))
            if (hash(c.k, tick, 5) < 0.35) idx += hash(c.k, tick, 6) < 0.5 ? -1 : 1
            g = RAMP.charAt(Math.max(1, Math.min(RAMP.length - 1, idx)))
          } else g = SCRAMBLE.charAt(Math.floor(hash(c.k, tick, 7) * SCRAMBLE.length))
          ctx.font = '400 ' + L.size + ' ui-monospace, "Cascadia Mono", Consolas, monospace'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.globalAlpha = 0.5 * L.alpha
          ctx.fillStyle = L.color
          ctx.fillText(g, c.x + c.w / 2, c.y + c.h * 0.48)
        } else {
          ctx.font = L.font
          ctx.textAlign = 'left'
          ctx.textBaseline = 'alphabetic'
          var y = c.y + (c.h - (L.asc + L.desc)) / 2 + L.asc
          ctx.globalAlpha = L.alpha
          ctx.fillStyle = L.color
          ctx.fillText(c.ch, c.x, y)
          var f = 1 - Math.min(1, (t - c.s1) / FLASH_MS)
          if (f > 0 && accent) {
            ctx.globalAlpha = f * 0.85 * L.alpha
            ctx.fillStyle = accent
            ctx.fillText(c.ch, c.x, y)
          }
        }
      })
      raf = t < lastEnd + FLASH_MS + 60 ? requestAnimationFrame(frame) : 0
    }
    raf = requestAnimationFrame(frame)
    stop = function () { if (raf) cancelAnimationFrame(raf) }
    setTimeout(function () {
      clean()
      de.style.removeProperty('--gx-step')
      de.style.removeProperty('--gx-base')
      de.style.removeProperty('--gx-c')
      items.forEach(function (it) { it.el.style.removeProperty('--gx-i') })
    }, Math.max(base + items.length * step + 900, lastEnd + FLASH_MS + 200))
  }
  var tries = 0
  function look() {
    // a tab still waiting behind Home starts when it comes to the front
    if (document.hidden) { document.addEventListener('visibilitychange', look, { once: true }); return }
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
