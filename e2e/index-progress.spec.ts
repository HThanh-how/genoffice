import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

test('folder progress collapses independently and document ring completes without a percentage', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'genoffice-progress-'))
  const path = join(scratch, 'Class roster.md')
  await writeFile(path, '# Class 2/1\nGuardian phone: 0912345678')
  const launched = await launchShell({
    onboardingSeen: true,
    openFile: path,
    videoDir: 'index-progress',
  })
  try {
    await launched.app.evaluate(({ ipcMain }, root) => {
      const fixture = {
        document: { state: 'extracting', percent: null, completedChunks: 0, totalChunks: 0 },
        activity: {
          folder: {
            root,
            startedAt: 1,
            state: 'running',
            running: true,
            discovered: 4,
            enrolled: 4,
            skipped: 0,
            errors: 0,
          },
          memory: { enabled: true, modelState: 'ready', pending: 4, errors: 0 },
          folderProgress: {
            totalFiles: 4,
            readyFiles: 1,
            pendingFiles: 3,
            errorFiles: 0,
            completedChunks: 1,
            totalChunks: 4,
            percent: null,
          },
        },
      }
      Object.assign(globalThis, { __indexProgressFixture: fixture })
      ipcMain.removeHandler('document-memory:progress')
      ipcMain.handle('document-memory:progress', () => fixture.document)
      ipcMain.removeHandler('home:get-indexing-activity')
      ipcMain.handle('home:get-indexing-activity', () => fixture.activity)
      ipcMain.removeHandler('home:get-document-index-snapshot')
      ipcMain.handle('home:get-document-index-snapshot', () => ({
        memory: {
          enabled: fixture.activity.memory.enabled,
          modelState: fixture.activity.memory.modelState,
          documents: fixture.activity.folderProgress.readyFiles,
          chunks: fixture.activity.folderProgress.completedChunks,
          vectors: fixture.activity.folderProgress.completedChunks,
          pending: fixture.activity.memory.pending,
          errors: fixture.activity.memory.errors ?? 0,
          dbPath: '',
          files: [],
        },
        activity: fixture.activity,
        mode: {
          mode: 'background',
          effective: { tier: 'full', paused: false },
          activeReason: 'standard',
          availableModes: ['gentle', 'background', 'active'],
        },
        issues: { total: 0, groups: [] },
        now: {
          extracting: [],
          embedding: {},
          positions: {},
          pages: {},
          queued: 0,
          paused: false,
        },
        storageBudget: { limitState: 'normal', usageRatio: 0.1 },
        timestamp: Date.now(),
      }))
    }, scratch)
    const editor = await waitForPageWithUrl(launched.app, '://markdown/')
    const ring = editor.locator('.document-index-indicator [role="progressbar"]')
    await expect(ring).toBeVisible()
    await expect(ring).not.toHaveAttribute('aria-valuenow')
    await launched.app.evaluate(() => {
      const fixture = (globalThis as any).__indexProgressFixture
      fixture.document = { state: 'indexing', percent: 25, completedChunks: 1, totalChunks: 4 }
    })
    await expect(ring).toHaveAttribute('aria-valuenow', '25')
    await expect(editor.locator('.document-index-indicator')).toContainText('25%')
    await editor.screenshot({ path: 'e2e/artifacts/index-progress-working.png' })
    await launched.app.evaluate(() => {
      const fixture = (globalThis as any).__indexProgressFixture
      fixture.document = { state: 'ready', percent: 100, completedChunks: 4, totalChunks: 4 }
    })
    await expect(ring).toHaveAttribute('aria-valuenow', '100')
    await expect(editor.locator('.document-index-indicator')).not.toContainText('%')
    const home = await waitForPageWithUrl(launched.app, 'shell/out')
    await home.locator('.tab-item.tab-home').click()

    await home
      .locator('.nav-item')
      .filter({ hasText: /Index|Chỉ mục/ })
      .click()
    await expect(home.locator('.idx-page')).toBeVisible()

    const statusCard = home.locator('.idx-status-card.is-indexing')
    await expect(statusCard).toBeVisible()
    await expect(statusCard.locator('.idx-progress-percent')).toHaveText('25%')
    await expect(statusCard).toContainText('4')

    await home.screenshot({ path: 'e2e/artifacts/index-progress-folder.png' })

    await launched.app.evaluate(() => {
      const fixture = (globalThis as any).__indexProgressFixture
      Object.assign(fixture.activity.folder, { running: false, state: 'complete' })
      fixture.activity.memory.pending = 0
      Object.assign(fixture.activity.folderProgress, {
        readyFiles: 4,
        pendingFiles: 0,
        completedChunks: 4,
        totalChunks: 4,
        percent: 100,
      })
    })

    await expect(home.locator('.idx-status-card.is-idle')).toBeVisible()
    await expect(home.locator('.idx-status-card.is-idle')).toContainText(
      /Ready for search|Sẵn sàng tìm kiếm/,
    )

    await home.locator('.idx-back').click()
    await expect(home.locator('.idx-page')).toHaveCount(0)
    await expect(home.locator('.home-hero')).toBeVisible()
  } finally {
    await closeAndSaveVideo(launched, 'index-progress')
    await rm(scratch, { recursive: true, force: true })
  }
})
