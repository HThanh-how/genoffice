import { nativeTheme, WebContentsView } from 'electron'
import type { BrowserWindow } from 'electron'
import type { OverlayDeps, OverlayHandle } from './opening-overlay'
import { buildOpeningPage, openingEnabled } from './opening-window'

/** The real thing: a view over the tab content that plays the app's opening scene. */
export function electronOverlayDeps(
  parent: () => BrowserWindow | null,
  lang: () => string,
): OverlayDeps {
  return {
    enabled: openingEnabled,
    now: () => Date.now(),
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    },
    create: (spec): OverlayHandle => {
      const view = new WebContentsView({
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          devTools: false,
        },
      })
      // until the scene paints, show the scene's own backdrop (not white, not a different grey)
      view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#15171c' : '#eef0f4')
      view.webContents.on('will-navigate', (event) => event.preventDefault())
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const window = parent()
      window?.contentView.addChildView(view)
      view.setVisible(false)
      const html = buildOpeningPage({
        fileName: spec.fileName,
        lang: lang(),
        kind: 'open',
        app: spec.app,
        // a small card over the tab, not a scene that fills it
        layout: 'card',
      })
      void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      let gone = false
      let inset = 0
      let bounds: { x: number; y: number; width: number; height: number } | null = null
      const place = (): void => {
        if (gone || !bounds) return
        const top = Math.min(inset, Math.max(0, bounds.height - 1))
        view.setBounds({ ...bounds, y: bounds.y + top, height: bounds.height - top })
      }
      return {
        setVisible: (visible) => {
          if (!gone) view.setVisible(visible)
        },
        setBounds: (next) => {
          bounds = next
          place()
        },
        setInset: (px) => {
          inset = Math.max(0, Math.round(px))
          place()
        },
        fadeOut: () => {
          if (gone || view.webContents.isDestroyed()) return
          void view.webContents
            .executeJavaScript("document.body.classList.add('leaving')")
            .catch(() => undefined)
        },
        destroy: () => {
          if (gone) return
          gone = true
          try {
            parent()?.contentView.removeChildView(view)
          } catch {
            // the window is already closing
          }
          if (!view.webContents.isDestroyed()) view.webContents.close()
        },
      }
    },
  }
}
