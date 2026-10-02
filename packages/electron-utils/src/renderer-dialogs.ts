import { contextBridge, ipcRenderer, webFrame } from 'electron'

// Same value as DIALOG_SYNC_CHANNEL in message-box.ts (that module cannot be loaded in a preload).
const CHANNEL = 'genoffice:dialog-sync'

/**
 * Preload helper: routes the page's `window.confirm` / `window.alert` to the in-app message box
 * (see message-box.ts) instead of the operating system's. The calls stay synchronous: the
 * renderer blocks on `sendSync` exactly as it does for the native versions.
 */
export function installRendererDialogs(): void {
  try {
    contextBridge.exposeInMainWorld('__genDialog', {
      confirm: (message: unknown): boolean =>
        ipcRenderer.sendSync(CHANNEL, 'confirm', String(message ?? '')) === true,
      alert: (message: unknown): void => {
        ipcRenderer.sendSync(CHANNEL, 'alert', String(message ?? ''))
      },
    })
    void webFrame
      .executeJavaScript(
        'window.confirm = (m) => window.__genDialog.confirm(m); window.alert = (m) => { window.__genDialog.alert(m) }',
      )
      .catch(() => {})
  } catch {
    // a page that already defines __genDialog keeps the native dialogs
  }
}
