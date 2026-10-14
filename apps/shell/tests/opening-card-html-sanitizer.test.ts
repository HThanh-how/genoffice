import { describe, expect, it } from 'vitest'
import {
  buildIsolatedHtmlHostDocument,
  escapeHtmlText,
  interpolateOpeningPlaceholders,
  sanitizeOpeningCss,
  sanitizeOpeningHtml,
} from '../src/main/fork/opening-card-html-sanitizer'

describe('opening-card-html-sanitizer', () => {
  describe('escapeHtmlText', () => {
    it('escapes &, <, >, ", and single quote', () => {
      expect(escapeHtmlText('Report <1> & "2" \'test\'')).toBe(
        'Report &lt;1&gt; &amp; &quot;2&quot; &#39;test&#39;',
      )
    })

    it('handles empty or non-string inputs safely', () => {
      expect(escapeHtmlText('')).toBe('')
      // @ts-expect-error test non-string
      expect(escapeHtmlText(null)).toBe('')
    })
  })

  describe('sanitizeOpeningHtml', () => {
    it('allows valid visual HTML layout elements', () => {
      const html = `
        <div class="card" role="status">
          <header class="card-header">
            <svg viewBox="0 0 100 100" width="32" height="32">
              <circle cx="50" cy="50" r="40" fill="#2b7cd3" />
            </svg>
            <h1 class="card-title">{{title}}</h1>
          </header>
          <main class="card-body">
            <p class="filename">{{fileName}}</p>
            <span class="hint">{{hint}}</span>
          </main>
        </div>
      `
      const res = sanitizeOpeningHtml(html)
      expect(res.ok).toBe(true)
      expect(res.sanitizedHtml).toContain('<div class="card" role="status">')
      expect(res.sanitizedHtml).toContain('<circle cx="50" cy="50" r="40" fill="#2b7cd3"')
      expect(res.sanitizedHtml).toContain('{{fileName}}')
    })

    it('rejects <script> tag injection', () => {
      const html = '<div class="card"><script>alert(1)</script>Hello</div>'
      const res = sanitizeOpeningHtml(html)
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/prohibited/i)
    })

    it('rejects <iframe> and <object> embedding', () => {
      expect(sanitizeOpeningHtml('<iframe src="file:///etc/passwd"></iframe>').ok).toBe(false)
      expect(sanitizeOpeningHtml('<object data="malicious.swf"></object>').ok).toBe(false)
      expect(sanitizeOpeningHtml('<embed src="something"></embed>').ok).toBe(false)
    })

    it('rejects inline event handlers (onerror, onload, onclick)', () => {
      expect(sanitizeOpeningHtml('<img src="x" onerror="alert(1)">').ok).toBe(false)
      expect(sanitizeOpeningHtml('<div onclick="doBadThing()">Click me</div>').ok).toBe(false)
    })

    it('rejects javascript: and file: schemes', () => {
      expect(sanitizeOpeningHtml('<a href="javascript:alert(1)">Test</a>').ok).toBe(false)
      expect(sanitizeOpeningHtml('<img src="file:///etc/hosts">').ok).toBe(false)
    })

    it('rejects payloads exceeding max size limit', () => {
      const huge = '<div>' + 'A'.repeat(70 * 1024) + '</div>'
      const res = sanitizeOpeningHtml(huge)
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/maximum size/i)
    })
  })

  describe('sanitizeOpeningCss', () => {
    it('preserves valid keyframes, gradients, and layout rules', () => {
      const css = `
        .card {
          width: 420px;
          height: 220px;
          border-radius: 18px;
          background: linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.05));
          backdrop-filter: blur(20px);
          animation: float 4s ease-in-out infinite;
        }
        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-8px); }
        }
      `
      const res = sanitizeOpeningCss(css)
      expect(res.ok).toBe(true)
      expect(res.sanitizedCss).toContain('@keyframes float')
      expect(res.sanitizedCss).toContain('backdrop-filter: blur(20px)')
    })

    it('rejects @import rules', () => {
      const css = '@import url("https://attacker.com/evil.css"); .card { color: red; }'
      const res = sanitizeOpeningCss(css)
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/prohibited or unsafe/i)
    })

    it('rejects expression() and javascript: in CSS', () => {
      expect(sanitizeOpeningCss('.card { width: expression(alert(1)); }').ok).toBe(false)
      expect(sanitizeOpeningCss('.card { background: url("javascript:alert(1)"); }').ok).toBe(false)
    })

    it('rejects external http/https/file URLs in CSS', () => {
      expect(
        sanitizeOpeningCss('.card { background-image: url("https://evil.com/bg.png"); }').ok,
      ).toBe(false)
      expect(
        sanitizeOpeningCss('.card { background-image: url("file:///tmp/secret.png"); }').ok,
      ).toBe(false)
    })
  })

  describe('interpolateOpeningPlaceholders', () => {
    it('interpolates placeholders and escapes malicious filenames', () => {
      const tpl =
        '<div class="doc"><span class="title">{{title}}</span><span class="name">{{fileName}}</span></div>'
      const params = {
        title: 'Opening…',
        hint: 'Please wait',
        fileName: 'malicious_<script>alert(1)</script>.docx',
        appName: 'Word',
      }
      const output = interpolateOpeningPlaceholders(tpl, params)
      expect(output).not.toContain('<script>')
      expect(output).toContain('malicious_&lt;script&gt;alert(1)&lt;/script&gt;.docx')
      expect(output).toContain('Opening…')
    })
  })

  describe('buildIsolatedHtmlHostDocument', () => {
    it('creates an isolated HTML document with strict CSP and leaving transition', () => {
      const html = '<div class="glass-panel"><h1>{{title}}</h1><p>{{fileName}}</p></div>'
      const css = '.glass-panel { background: rgba(255,255,255,0.2); }'
      const doc = buildIsolatedHtmlHostDocument(html, css, {
        title: 'Opening document…',
        hint: 'Preparing sheets',
        fileName: 'financials.xlsx',
      })

      expect(doc).toContain('<!doctype html>')
      expect(doc).toContain('Content-Security-Policy')
      expect(doc).toContain("default-src 'none'")
      expect(doc).not.toContain('<script')
      expect(doc).toContain('body.leaving')
      expect(doc).toContain('financials.xlsx')
    })

    it('handles reduced motion by setting animation-duration to minimal', () => {
      const doc = buildIsolatedHtmlHostDocument(
        '<div>Test</div>',
        '',
        { title: 'T', hint: 'H', fileName: 'F.docx' },
        { reducedMotion: true },
      )
      expect(doc).toContain('animation-duration: 0.001ms !important')
    })
  })
})
