import type { BrowserWindow } from 'electron'

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
 * Installed separately from index.ts (same helpers as the detached-window
 * guard) so the handler itself stays unit-testable: it takes the window and
 * the tab manager as arguments and therefore needs no Electron to run.
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

export function installShellCloseGuard(win: BrowserWindow, manager: TabManager): void {
  let closeConfirmed = false
  // a second close event while the save prompts are still open (double ⌘Q, an
  // OS retry) must not re-enter the whole prompt chain
  let closePromptInFlight = false

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
    if (closePromptInFlight || quitCoordinator.isPromptInFlight()) return
    closePromptInFlight = true
    quitCoordinator.setPromptInFlight(true)
    void (async () => {
      try {
        const allowed = await promptDirtyTabs(win, manager)
        if (allowed) {
          closeConfirmed = true
          if (!win.isDestroyed()) win.close()
        } else {
          resetSheetsShuttingDown()
          quitCoordinator.abortQuit()
        }
      } catch (err) {
        console.error('[shell] window close prompt failed:', err)
        resetSheetsShuttingDown()
        quitCoordinator.abortQuit()
      } finally {
        closePromptInFlight = false
        quitCoordinator.setPromptInFlight(false)
      }
    })()
  })
}
