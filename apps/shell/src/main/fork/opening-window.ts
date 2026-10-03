import { BrowserWindow, app } from 'electron'

/**
 * A small "Opening…" panel for the seconds a legacy .doc / .ppt takes to be converted. Without it a
 * click on the file seems to do nothing for up to a minute (the online conversion is the slow part)
 * and the person tries again or thinks it failed. It shows only when the wait is noticeable.
 */

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

/** The panel's page: light or dark by the system setting, a spinner, the file name, one line of why. */
export function openingPageHtml(words: OpeningWords, fileName: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(words.title)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1f2328;--muted:#656d76;--accent:#2b579a;--track:#d8dee4}
@media (prefers-color-scheme:dark){:root{--bg:#25272b;--fg:#e8eaed;--muted:#9aa0a6;--accent:#6ea8fe;--track:#3c4043}}
html,body{margin:0;height:100%}
body{display:flex;align-items:center;gap:16px;padding:0 22px;box-sizing:border-box;background:var(--bg);color:var(--fg);
font:14px/1.35 "Segoe UI",system-ui,-apple-system,sans-serif;border:1px solid var(--track);user-select:none;cursor:default}
.spin{flex:none;width:30px;height:30px;border-radius:50%;border:3px solid var(--track);border-top-color:var(--accent);animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.text{min-width:0}
.title{font-weight:600;font-size:15px}
.name,.hint{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:290px}
.name{margin-top:2px}
.hint{margin-top:2px;color:var(--muted);font-size:12px}
</style></head><body>
<div class="spin" role="progressbar" aria-label="${escapeHtml(words.title)}"></div>
<div class="text"><div class="title">${escapeHtml(words.title)}</div>
<div class="name">${escapeHtml(fileName)}</div>
<div class="hint">${escapeHtml(words.hint)}</div></div>
</body></html>`
}

/** Waits this long before showing, so a quick open does not flash a window. */
export const OPENING_DELAY_MS = 600

/**
 * Shows the panel after a short delay and returns what closes it. Safe to call with no window
 * (before the app is ready, or in tests): it then does nothing.
 */
export function startOpeningNotice(options: {
  fileName: string
  lang: string
  kind: 'doc' | 'ppt'
  delayMs?: number
}): { close(): void } {
  let window: BrowserWindow | null = null
  let closed = false
  const timer = setTimeout(() => {
    if (closed || !app.isReady()) return
    window = new BrowserWindow({
      width: 400,
      height: 110,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      center: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
      },
    })
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const html = openingPageHtml(openingWords(options.lang, options.kind), options.fileName)
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
