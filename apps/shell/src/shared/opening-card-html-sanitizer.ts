/**
 * Opening Card Studio — HTML/CSS Sanitizer & Security Boundary
 * Enforces strict structural sanitization, attribute whitelisting,
 * and CSS validation for AI-generated and custom HTML opening cards.
 *
 * Placed in shared so both renderer (preview iframe) and main process
 * (isolated overlay view) use the exact same security and rendering logic.
 */

export const MAX_HTML_CHARS = 64 * 1024 // 64 KB
export const MAX_CSS_CHARS = 64 * 1024 // 64 KB

export interface OpeningPlaceholderParams {
  fileName: string
  fileType?: string
  title: string
  hint: string
  appName?: string
  accentColor?: string
}

export function escapeHtmlText(text: string): string {
  return String(text || '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      case "'":
        return '&#39;'
      default:
        return char
    }
  })
}

// Allowed visual & layout HTML elements
const ALLOWED_TAGS = new Set([
  'div',
  'span',
  'main',
  'section',
  'article',
  'header',
  'footer',
  'nav',
  'aside',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'i',
  'b',
  'em',
  'strong',
  'small',
  'sub',
  'sup',
  'hr',
  'br',
  'ul',
  'ol',
  'li',
  'svg',
  'path',
  'circle',
  'rect',
  'ellipse',
  'line',
  'polygon',
  'polyline',
  'g',
  'defs',
  'lineargradient',
  'radialgradient',
  'stop',
  'use',
  'text',
  'tspan',
])

// Allowed element attributes
const ALLOWED_ATTRS = new Set([
  'class',
  'id',
  'style',
  'role',
  'aria-hidden',
  'aria-label',
  'aria-live',
  'aria-atomic',
  'width',
  'height',
  'viewbox',
  'xmlns',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'd',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'points',
  'offset',
  'stop-color',
  'stop-opacity',
  'transform',
  'opacity',
  'gradientunits',
])

// Dangerous patterns in CSS
const FORBIDDEN_CSS_PATTERNS = [
  /@import/i,
  /expression\s*\(/i,
  /javascript\s*:/i,
  /-moz-binding/i,
  /behavior\s*:/i,
  /url\s*\(\s*['"]?\s*(?:https?|ftp|file):/i,
  /<[^>]+>/i, // HTML injection in CSS
]

/**
 * Validates and sanitizes raw CSS rules.
 * Blocks external @import, remote url() downloads, expressions, and script schemes.
 */
export function sanitizeOpeningCss(rawCss: string): {
  ok: boolean
  sanitizedCss?: string
  error?: string
} {
  if (typeof rawCss !== 'string') {
    return { ok: false, error: 'CSS must be a string' }
  }

  const trimmed = rawCss.trim()
  if (trimmed.length > MAX_CSS_CHARS) {
    return { ok: false, error: `CSS exceeds maximum size of ${MAX_CSS_CHARS / 1024} KB` }
  }

  for (const pattern of FORBIDDEN_CSS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { ok: false, error: `CSS contains prohibited or unsafe rule: ${pattern.source}` }
    }
  }

  // Sanitize any remaining url() usages: block unless none or harmless
  const urlMatches = trimmed.match(/url\s*\(([^)]*)\)/gi)
  if (urlMatches) {
    for (const match of urlMatches) {
      const inner = match.replace(/^url\s*\(\s*['"]?|['"]?\s*\)$/gi, '').trim()
      if (!inner.startsWith('data:image/svg+xml') && !inner.startsWith('#')) {
        return {
          ok: false,
          error: 'Remote or external URLs are not permitted in card CSS',
        }
      }
    }
  }

  return { ok: true, sanitizedCss: trimmed }
}

/**
 * Validates and sanitizes an HTML fragment.
 * Removes all <script>, <iframe>, <object>, <form>, event handlers (onload, onerror, onclick),
 * and disallows tags outside the visual whitelist.
 */
export function sanitizeOpeningHtml(rawHtml: string): {
  ok: boolean
  sanitizedHtml?: string
  error?: string
} {
  if (typeof rawHtml !== 'string') {
    return { ok: false, error: 'HTML must be a string' }
  }

  const trimmed = rawHtml.trim()
  if (trimmed.length > MAX_HTML_CHARS) {
    return { ok: false, error: `HTML exceeds maximum size of ${MAX_HTML_CHARS / 1024} KB` }
  }

  // Fast check: Reject explicit dangerous tags immediately
  const dangerousTagRegex =
    /<\s*\/?\s*(?:script|iframe|object|embed|form|base|meta|link|style|applet|portal)\b/i
  if (dangerousTagRegex.test(trimmed)) {
    return { ok: false, error: 'HTML contains prohibited executable or embedding tags' }
  }

  // Fast check: Reject inline event handlers (on\w+=)
  const eventHandlerRegex = /\bon[a-z]+\s*=/i
  if (eventHandlerRegex.test(trimmed)) {
    return { ok: false, error: 'HTML contains prohibited inline event handlers' }
  }

  // Fast check: Reject javascript: and file: URLs
  const scriptSchemeRegex = /(?:javascript|vbscript|file):/i
  if (scriptSchemeRegex.test(trimmed)) {
    return { ok: false, error: 'HTML contains prohibited script or local file schemes' }
  }

  // Structural sanitization: parse elements and strip anything outside ALLOWED_TAGS and ALLOWED_ATTRS
  let sanitized = ''
  let pos = 0
  const len = trimmed.length

  while (pos < len) {
    const tagOpenIndex = trimmed.indexOf('<', pos)
    if (tagOpenIndex === -1) {
      sanitized += trimmed.slice(pos)
      break
    }

    // Append text before tag
    sanitized += trimmed.slice(pos, tagOpenIndex)

    // Check for comments <!-- ... -->
    if (trimmed.startsWith('<!--', tagOpenIndex)) {
      const commentEnd = trimmed.indexOf('-->', tagOpenIndex + 4)
      if (commentEnd === -1) break
      pos = commentEnd + 3
      continue
    }

    const tagCloseIndex = trimmed.indexOf('>', tagOpenIndex)
    if (tagCloseIndex === -1) {
      // Malformed tag, stop
      break
    }

    const rawTag = trimmed.slice(tagOpenIndex, tagCloseIndex + 1)
    pos = tagCloseIndex + 1

    // Parse tag name and attributes
    const match = /^<\s*(\/?)\s*([a-zA-Z0-9:-]+)([\s\S]*?)(\/?)\s*>$/.exec(rawTag)
    if (!match) {
      continue
    }

    const isClosing = match[1] === '/'
    const tagName = match[2].toLowerCase()
    const rawAttrs = match[3]
    const isSelfClosing = match[4] === '/'

    if (!ALLOWED_TAGS.has(tagName)) {
      // Disallowed tag: skip tag
      continue
    }

    if (isClosing) {
      sanitized += `</${tagName}>`
      continue
    }

    // Sanitize attributes
    const safeAttrs: string[] = []
    const attrRegex = /([a-zA-Z0-9:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
    let attrMatch: RegExpExecArray | null

    while ((attrMatch = attrRegex.exec(rawAttrs)) !== null) {
      const attrName = attrMatch[1].toLowerCase()
      const attrValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? ''

      // Skip event handlers or unknown attributes
      if (attrName.startsWith('on') || !ALLOWED_ATTRS.has(attrName)) {
        continue
      }

      // Check for javascript: or expression() in attribute value
      if (scriptSchemeRegex.test(attrValue) || /expression\s*\(/i.test(attrValue)) {
        continue
      }

      // Sanitize style attribute specifically
      if (attrName === 'style') {
        const styleRes = sanitizeOpeningCss(attrValue)
        if (!styleRes.ok || !styleRes.sanitizedCss) continue
        safeAttrs.push(`style="${escapeHtmlText(styleRes.sanitizedCss)}"`)
        continue
      }

      safeAttrs.push(`${attrName}="${escapeHtmlText(attrValue)}"`)
    }

    const attrStr = safeAttrs.length > 0 ? ` ${safeAttrs.join(' ')}` : ''
    sanitized += isSelfClosing ? `<${tagName}${attrStr} />` : `<${tagName}${attrStr}>`
  }

  return { ok: true, sanitizedHtml: sanitized }
}

/**
 * Safely replaces dynamic placeholders with escaped user/document strings.
 * Guarantees that arbitrary filename strings (even with HTML tags) cannot escape.
 */
export function interpolateOpeningPlaceholders(
  template: string,
  params: OpeningPlaceholderParams,
): string {
  if (typeof template !== 'string') return ''

  const safeFileName = escapeHtmlText(params.fileName)
  const safeTitle = escapeHtmlText(params.title)
  const safeHint = escapeHtmlText(params.hint)
  const safeAppName = escapeHtmlText(params.appName || 'GenOffice')
  const safeFileType = escapeHtmlText(params.fileType || '')
  const safeAccentColor = escapeHtmlText(params.accentColor || '#2b7cd3')

  return template
    .replace(/\{\{\s*fileName\s*\}\}/gi, () => safeFileName)
    .replace(/\{\{\s*title\s*\}\}/gi, () => safeTitle)
    .replace(/\{\{\s*hint\s*\}\}/gi, () => safeHint)
    .replace(/\{\{\s*appName\s*\}\}/gi, () => safeAppName)
    .replace(/\{\{\s*fileType\s*\}\}/gi, () => safeFileType)
    .replace(/\{\{\s*accentColor\s*\}\}/gi, () => safeAccentColor)
    .replace(/\{\{\s*color\s*\}\}/gi, () => safeAccentColor)
}

/**
 * Assembles a complete, sandboxed host HTML document for isolated card rendering.
 * Used by isolated WebContentsView (app opening overlay) and iframe preview.
 * Includes strict CSP (scripts disabled), CSS animations, leaving transition, and placeholders.
 */
export function buildIsolatedHtmlHostDocument(
  sanitizedHtml: string,
  sanitizedCss: string,
  params: OpeningPlaceholderParams,
  options: {
    reducedMotion?: boolean
    isCardLayout?: boolean
    skeletonHtml?: string
  } = {},
): string {
  const content = interpolateOpeningPlaceholders(sanitizedHtml, params)
  const title = escapeHtmlText(params.title || 'Opening…')

  const csp =
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:">'

  const motionRules = options.reducedMotion
    ? `\n* { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; }\n`
    : ''

  const baseCss = `
:root {
  color-scheme: dark light;
  --accent: ${params.accentColor || '#2b7cd3'};
}
html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  user-select: none;
  cursor: default;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
body {
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  transition: opacity 0.3s ease;
}
body.leaving {
  opacity: 0 !important;
}
.opening-card-container {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}
${motionRules}
`

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  ${csp}
  <style>
${baseCss}
${sanitizedCss}
  </style>
</head>
<body${options.isCardLayout ? ' class="card-layout"' : ''}>
  ${options.skeletonHtml ? options.skeletonHtml : ''}
  <div class="opening-card-container">
    ${content}
  </div>
</body>
</html>`
}
