import { BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'

/**
 * In-app message box that replaces the operating system's one (on Windows the stock box is
 * grey, ignores dark mode and ignores the app font). Same contract as `dialog.showMessageBox`
 * (type, message, detail, buttons, defaultId, cancelId, checkbox), so existing call sites keep
 * working. It is a small frameless, parented modal window with inline HTML: no preload and no
 * IPC, the page reports its answer by navigating to a private URL that the main process
 * intercepts.
 */

const RESULT_SCHEME = 'genoffice-dialog:'
const WIDTH = 440
const MAX_HEIGHT = 640

type Parent = BrowserWindow | null | undefined

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

const ICONS: Record<string, string> = {
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 11v6M12 7.5v.01"/>',
  question:
    '<circle cx="12" cy="12" r="10"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1.9-1.1 1.8M12 17v.01"/>',
  warning: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v5M12 17.5v.01"/>',
  error: '<circle cx="12" cy="12" r="10"/><path d="m8.5 8.5 7 7m0-7-7 7"/>',
}

export function messageBoxHtml(options: MessageBoxOptions): string {
  const buttons = options.buttons?.length ? options.buttons : ['OK']
  const defaultId = Math.min(Math.max(options.defaultId ?? 0, 0), buttons.length - 1)
  const cancelId = options.cancelId ?? (buttons.length > 1 ? buttons.length - 1 : 0)
  const type = options.type && options.type !== 'none' ? options.type : ''
  const icon = type
    ? `<svg class="icon ${type}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[type] ?? ICONS.info}</svg>`
    : ''
  const title = options.message ? esc(options.message) : ''
  const detail = options.detail ? `<p class="detail">${esc(options.detail)}</p>` : ''
  const checkbox = options.checkboxLabel
    ? `<label class="check"><input type="checkbox" id="cb"${options.checkboxChecked ? ' checked' : ''}> <span>${esc(options.checkboxLabel)}</span></label>`
    : ''
  const buttonHtml = buttons
    .map(
      (label, i) =>
        `<button type="button" data-i="${i}"${i === defaultId ? ' class="primary" autofocus' : ''}>${esc(label)}</button>`,
    )
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${esc(options.title ?? '')}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1f1f1f;--muted:#5f6368;--line:#e3e3e3;--btn:#f1f1f1;--btn-h:#e6e6e6;--accent:#2f6fed;--accent-fg:#fff;--warn:#d98200;--err:#d93025}
@media (prefers-color-scheme:dark){:root{--bg:#242424;--fg:#ececec;--muted:#a0a0a0;--line:#3a3a3a;--btn:#333;--btn-h:#3d3d3d;--accent:#5b8def;--accent-fg:#0b1530;--warn:#f0a030;--err:#f0645a}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-user-select:none;user-select:none;overflow:hidden}
.box{border:1px solid var(--line);padding:22px 22px 16px;display:flex;flex-direction:column;gap:18px;-webkit-app-region:drag}
.body{display:flex;gap:14px;align-items:flex-start}
.icon{flex:0 0 28px;width:28px;height:28px;margin-top:1px}
.icon.info,.icon.question{color:var(--accent)}.icon.warning{color:var(--warn)}.icon.error{color:var(--err)}
.text{min-width:0;flex:1}
.msg{margin:0;font-size:15px;font-weight:600;white-space:pre-wrap;overflow-wrap:anywhere}
.detail{margin:6px 0 0;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;max-height:320px;overflow-y:auto}
.check{display:flex;gap:8px;align-items:center;margin-top:12px;color:var(--muted);-webkit-app-region:no-drag}
.actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;-webkit-app-region:no-drag}
button{font:inherit;min-height:32px;padding:0 16px;border:1px solid var(--line);border-radius:8px;background:var(--btn);color:var(--fg);cursor:pointer}
button:hover{background:var(--btn-h)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:600}
button.primary:hover{filter:brightness(1.08);background:var(--accent)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style></head><body>
<div class="box"><div class="body">${icon}<div class="text"><p class="msg">${title}</p>${detail}${checkbox}</div></div>
<div class="actions">${buttonHtml}</div></div>
<script>
const done=(i)=>{const cb=document.getElementById('cb');location.href='${RESULT_SCHEME}//r?i='+i+'&c='+(cb&&cb.checked?1:0)};
document.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>done(+b.dataset.i)));
addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();done(${cancelId})}else if(e.key==='Enter'&&!(document.activeElement instanceof HTMLButtonElement)){e.preventDefault();done(${defaultId})}});
</script></body></html>`
}

/** Drop-in for `dialog.showMessageBox([parent,] options)`. */
export function showThemedMessageBox(
  parentOrOptions: Parent | MessageBoxOptions,
  maybeOptions?: MessageBoxOptions,
): Promise<MessageBoxReturnValue> {
  const hasParent = maybeOptions !== undefined
  const parent = hasParent ? (parentOrOptions as Parent) : undefined
  const options = (hasParent ? maybeOptions : parentOrOptions) as MessageBoxOptions
  const buttons = options.buttons?.length ? options.buttons : ['OK']
  const cancelId = options.cancelId ?? (buttons.length > 1 ? buttons.length - 1 : 0)
  const live = parent && !parent.isDestroyed() ? parent : undefined

  return new Promise((resolve) => {
    let settled = false
    const win = new BrowserWindow({
      width: WIDTH,
      height: 180,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: !!live,
      ...(live ? { parent: live, modal: process.platform !== 'darwin' } : {}),
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#242424' : '#ffffff',
      title: options.title ?? '',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    const finish = (response: number, checked: boolean): void => {
      if (settled) return
      settled = true
      resolve({ response, checkboxChecked: checked })
      if (!win.isDestroyed()) win.destroy()
    }
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const intercept = (event: Electron.Event, url: string): void => {
      event.preventDefault()
      if (!url.startsWith(RESULT_SCHEME)) return
      const params = new URL(url).searchParams
      const index = Number(params.get('i'))
      finish(
        Number.isInteger(index) && index >= 0 && index < buttons.length ? index : cancelId,
        params.get('c') === '1',
      )
    }
    win.webContents.on('will-navigate', intercept)
    win.on('closed', () => finish(cancelId, !!options.checkboxChecked))
    win.webContents.once('did-finish-load', () => {
      void win.webContents
        .executeJavaScript('document.querySelector(".box").getBoundingClientRect().height')
        .then((h: number) => {
          if (win.isDestroyed()) return
          win.setContentSize(WIDTH, Math.min(MAX_HEIGHT, Math.ceil(h)))
          win.center()
          win.show()
        })
        .catch(() => win.show())
    })
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(messageBoxHtml(options))}`)
  })
}

const SYNC_CHANNEL = 'genoffice:dialog-sync'
let installed = false

/**
 * Replaces `dialog.showMessageBox` for the whole main process, and answers the synchronous
 * `window.confirm` / `window.alert` bridge installed by `installRendererDialogs`.
 */
export function installThemedDialogs(): void {
  if (installed) return
  installed = true
  ;(dialog as { showMessageBox: unknown }).showMessageBox = showThemedMessageBox
  ipcMain.on(SYNC_CHANNEL, (event, kind: unknown, message: unknown) => {
    const text = typeof message === 'string' ? message : String(message ?? '')
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: MessageBoxOptions =
      kind === 'confirm'
        ? { type: 'question', message: text, buttons: ['OK', 'Cancel'], defaultId: 0, cancelId: 1 }
        : { type: 'info', message: text, buttons: ['OK'] }
    void showThemedMessageBox(win, options).then((r) => {
      event.returnValue = kind === 'confirm' ? r.response === 0 : undefined
    })
  })
}

export const DIALOG_SYNC_CHANNEL = SYNC_CHANNEL
