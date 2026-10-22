import { app, type BrowserWindow } from 'electron'

import { docsQueryDirty, requestDocsClose } from '../../../docs/src/main/docs-main'
import { requestSheetsClose, resetSheetsShuttingDown } from '../../../sheets/src/main/sheets-main'
import { requestSlidesClose } from '../../../slides/src/main/slides-main'
import { requestPdfClose } from '../../../pdf/src/main/pdf-main'
import { requestMarkdownClose } from '../../../markdown/src/main/markdown-main'
import { requestHtmlClose } from '../../../html/src/main/html-main'
import type { TabManager } from './tab-manager'
import { quitCoordinator } from './quit-coordinator'

/**
 * Unsaved-changes guard for the shell window: closing the whole window walks
 * every dirty sheets/pdf/slides/docs tab through the same
 * save/don't-save/cancel prompt the tab close path uses, and any cancel
 * aborts the close. docs dirtiness lives renderer-side, so any live docs tab
 * forces the async path and gets queried there (clean tabs pass through
 * without activation).
 *
 * Cancelling the close event also cancels an in-flight app.quit(), and on
 * macOS window-all-closed does not quit, so once the prompts have all been
 * confirmed a close that began as a quit must be finished with app.quit()
 * rather than win.close(): the latter closes the only window and leaves the
 * app running with none (genoffice#2098, ⌘Q needing two presses whenever a
 * Docs tab is open).
 *
 * Installed separately from index.ts (same helpers as the detached-window
 * guard) so the handler itself stays unit-testable: it takes the window, the
 * tab manager and the quit tracker as arguments and therefore needs no
 * Electron to run.
 */
/**
 * Prompts all dirty sheets/pdf/markdown/html/slides/docs tabs in the manager sequentially.
 * Returns true if all were saved or discarded, false if user canceled.
 */
export async function promptDirtyTabs(win: BrowserWindow, manager: TabManager): Promise<boolean> {
  const dirtySheets = manager.dirtySheetsTabs()
  const dirtyPdf = manager.dirtyPdfTabs()
  const dirtyMarkdown = manager.dirtyMarkdownTabs()
  const dirtyHtml = manager.dirtyHtmlTabs()
  const dirtySlides = manager.dirtySlidesTabs()
  const docsTabs = manager.docsTabs()

  for (const tab of dirtySheets) {
    manager.activateTab(tab.id)
    if (!(await requestSheetsClose(tab.webContents, win))) return false
  }
  for (const tab of dirtyPdf) {
    manager.activateTab(tab.id)
    if (!(await requestPdfClose(tab.webContents, win))) return false
  }
  for (const tab of dirtyMarkdown) {
    manager.activateTab(tab.id)
    if (!(await requestMarkdownClose(tab.webContents, win))) return false
  }
  for (const tab of dirtyHtml) {
    manager.activateTab(tab.id)
    if (!(await requestHtmlClose(tab.webContents, win))) return false
  }
  for (const tab of dirtySlides) {
    manager.activateTab(tab.id)
    if (!(await requestSlidesClose(tab.webContents, win))) return false
  }
  for (const tab of docsTabs) {
    if (!(await docsQueryDirty(tab.webContents))) continue
    manager.activateTab(tab.id)
    if (!(await requestDocsClose(tab.webContents, win))) return false
  }
  return true
}

export interface QuitTracker {
  /** a quit is in progress: between before-quit and its windows' close events */
  quitting(): boolean
  /** keep quitting() alive past the close event while prompts run */
  hold(): void
  release(): void
  /** the quit was cancelled: a prompt was denied */
  reset(): void
  quit(): void
}

/**
 * Electron fires no event for a cancelled quit, so the flag may not stay
 * latched: it is true only during the synchronous window-close pass that
 * app.quit() runs (cleared on the next macrotask) unless a guard that
 * prevented one of those closes holds it while its prompts are open.
 */
function electronQuitTracker(): QuitTracker {
  let quitting = false
  let holds = 0
  app.on('before-quit', () => {
    quitting = true
    setImmediate(() => {
      if (holds === 0) quitting = false
    })
  })
  return {
    quitting: () => quitting,
    hold: () => {
      holds += 1
    },
    release: () => {
      holds -= 1
      if (holds === 0) quitting = false
    },
    reset: () => {
      quitting = false
    },
    quit: () => app.quit(),
  }
}

let shared: QuitTracker | undefined

export function shellQuitTracker(): QuitTracker {
  return (shared ??= electronQuitTracker())
}

export function installShellCloseGuard(
  win: BrowserWindow,
  manager: TabManager,
  quitTracker: QuitTracker = shellQuitTracker(),
): void {
  let closeConfirmed = false
  // a second close event while the save prompts are still open (double ⌘Q, an
  // OS retry) must not re-enter the whole prompt chain
  let closePromptInFlight = false
  let holdingQuit = false

  win.on('close', (event) => {
    if (closeConfirmed || quitCoordinator.isConfirmed()) return
    const hasDirty =
      manager.dirtySheetsTabs().length > 0 ||
      manager.dirtyPdfTabs().length > 0 ||
      manager.dirtyMarkdownTabs().length > 0 ||
      manager.dirtyHtmlTabs().length > 0 ||
      manager.dirtySlidesTabs().length > 0 ||
      manager.docsTabs().length > 0

    if (!hasDirty) {
      closeConfirmed = true
      return
    }

    event.preventDefault()
    // a ⌘Q that lands while a red-button prompt is already open still turns
    // that close into a quit
    if (quitTracker.quitting() && !holdingQuit) {
      holdingQuit = true
      quitTracker.hold()
    }
    if (closePromptInFlight || quitCoordinator.isPromptInFlight()) return
    closePromptInFlight = true
    quitCoordinator.setPromptInFlight(true)
    void (async () => {
      try {
        const allowed = await promptDirtyTabs(win, manager)
        if (allowed) {
          closeConfirmed = true
          if (win.isDestroyed()) return
          // read now, not at the close event: a detached window may have vetoed
          // the quit in the meantime
          if (quitTracker.quitting()) quitTracker.quit()
          else win.close()
        } else {
          quitTracker.reset()
          resetSheetsShuttingDown()
          quitCoordinator.abortQuit()
        }
      } catch (err) {
        console.error('[shell] window close prompt failed:', err)
        quitTracker.reset()
        resetSheetsShuttingDown()
        quitCoordinator.abortQuit()
      } finally {
        closePromptInFlight = false
        quitCoordinator.setPromptInFlight(false)
        if (holdingQuit) {
          holdingQuit = false
          quitTracker.release()
        }
      }
    })()
  })
}
