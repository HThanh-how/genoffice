import { WebContentsView } from 'electron'
import type { BrowserWindow } from 'electron'
import type { OverlayDeps, OverlayHandle } from './opening-overlay'
import { machineTier, openingPageHtml, openingWords } from './opening-window'

/** The real thing: a view over the tab content that plays the app's opening scene. */
export function electronOverlayDeps(
  parent: () => BrowserWindow | null,
  lang: () => string,
): OverlayDeps {
  return {
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
      view.webContents.on('will-navigate', (event) => event.preventDefault())
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const window = parent()
      window?.contentView.addChildView(view)
      view.setVisible(false)
      const html = openingPageHtml(
        openingWords(lang(), 'open'),
        spec.fileName,
        spec.app,
        machineTier(),
      )
      void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      let gone = false
      return {
        setVisible: (visible) => {
          if (!gone) view.setVisible(visible)
        },
        setBounds: (bounds) => {
          if (!gone) view.setBounds(bounds)
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
