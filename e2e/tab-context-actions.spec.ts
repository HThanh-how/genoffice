import { test, expect } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from './helpers'
import type { TabsApi } from '../apps/shell/src/shared/tabs-api'

test('tab context menu saves current edits from a background tab and offers native icons', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'genoffice-tab-context-'))
  const source = join(dir, 'notes.md')
  const target = join(dir, 'notes-copy.md')
  await writeFile(source, '# Context menu\n\nOriginal paragraph.\n')
  const launched = await launchShell({
    onboardingSeen: true,
    openFile: source,
    videoDir: 'tab-context-actions',
  })
  const { app } = launched
  try {
    const home = await waitForPageWithUrl(app, 'shell/out')
    const editor = await waitForPageWithUrl(app, '://markdown/')
    await expect(editor.locator('.doc-editor h1')).toHaveText('Context menu')
    const content = editor.locator('[contenteditable="true"]').first()
    await content.click()
    await content.press('ControlOrMeta+End')
    await content.press('Enter')
    await content.pressSequentially('Unsaved context-menu edit.')
    const tabId = await home.evaluate(async () => {
      const api = (window as unknown as { aiOfficeTabs: TabsApi }).aiOfficeTabs
      const tab = (await api.list()).find((item) => item.kind === 'markdown')!
      await api.activate('home')
      return tab.id
    })
    await app.evaluate(({ Menu, dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
      Menu.prototype.popup = function () {
        ;(globalThis as typeof globalThis & { __tabContextMenu?: Electron.Menu }).__tabContextMenu =
          this
      }
    }, target)
    await home.evaluate(
      (id) => (window as unknown as { aiOfficeTabs: TabsApi }).aiOfficeTabs.showTabMenu(id, 20, 20),
      tabId,
    )
    const entries = await app.evaluate(() => {
      const menu = (globalThis as typeof globalThis & { __tabContextMenu?: Electron.Menu })
        .__tabContextMenu!
      return menu.items
        .filter((item) => item.type !== 'separator' && item.enabled)
        .map((item) => ({
          label: item.label,
          icon: !!item.icon && !item.icon.isEmpty(),
          size: item.icon?.getSize(),
        }))
    })
    expect(entries.map((item) => item.label)).toEqual(
      expect.arrayContaining(['Save', 'Save As…', 'Print…']),
    )
    for (const item of entries) {
      expect(item.icon, item.label).toBe(true)
      expect(item.size).toEqual({ width: 16, height: 16 })
    }
    await app.evaluate(({ BrowserWindow }) => {
      const menu = (globalThis as typeof globalThis & { __tabContextMenu?: Electron.Menu })
        .__tabContextMenu!
      const saveAs = menu.getMenuItemById('saveAs')!
      saveAs.click(undefined as never, BrowserWindow.getFocusedWindow()!, undefined as never)
    })
    await expect
      .poll(() => readFile(target, 'utf8').catch(() => ''))
      .toContain('Unsaved context-menu edit.')
    const active = await home.evaluate(async () =>
      (await (window as unknown as { aiOfficeTabs: TabsApi }).aiOfficeTabs.list()).find(
        (item) => item.active,
      ),
    )
    expect(active?.id).toBe(tabId)
    expect(active?.filePath).toBe(target)
    const editorContentsId = await app.evaluate(({ webContents }) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().includes('://markdown/'))!
      const send = contents.send.bind(contents)
      contents.send = (channel, ...args) => {
        if (channel === 'markdown:print-request') {
          ;(
            globalThis as typeof globalThis & { __printedContentsId?: number }
          ).__printedContentsId = contents.id
          return
        }
        send(channel, ...args)
      }
      return contents.id
    })
    await home.evaluate(async (id) => {
      const api = (window as unknown as { aiOfficeTabs: TabsApi }).aiOfficeTabs
      await api.activate('home')
      await api.showTabMenu(id, 20, 20)
    }, tabId)
    await app.evaluate(({ BrowserWindow }) => {
      const menu = (globalThis as typeof globalThis & { __tabContextMenu?: Electron.Menu })
        .__tabContextMenu!
      menu
        .getMenuItemById('print')!
        .click(undefined as never, BrowserWindow.getFocusedWindow()!, undefined as never)
    })
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { __printedContentsId?: number }).__printedContentsId,
      ),
    ).toBe(editorContentsId)
  } finally {
    await closeAndSaveVideo(launched, 'tab-context-actions')
    await rm(dir, { recursive: true, force: true })
  }
})
