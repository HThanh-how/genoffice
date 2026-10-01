import { test, expect } from '@playwright/test'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

test('file warnings preserve ongoing progress and expose localized retry actions', async () => {
  const launched = await launchShell({ onboardingSeen: true, lang: 'vi', videoDir: 'index-issues' })
  try {
    await launched.app.evaluate(({ ipcMain }) => {
      const fixture = {
        activity: {
          folder: {
            root: '/selected',
            startedAt: 1,
            state: 'complete',
            running: false,
            discovered: 20,
            enrolled: 20,
            skipped: 0,
            errors: 0,
          },
          memory: { enabled: true, modelState: 'ready', pending: 12, errors: 2, cpuMode: 'gentle' },
          folderProgress: {
            totalFiles: 20,
            readyFiles: 6,
            pendingFiles: 12,
            errorFiles: 2,
            emptyFiles: 0,
            completedChunks: 6,
            totalChunks: 20,
            percent: 30,
          },
        },
        issues: {
          total: 2,
          items: [
            { id: 1, path: '/selected/scanned.pdf', name: 'Hồ sơ scan.pdf', reason: 'no-text' },
            { id: 2, path: '/selected/locked.docx', name: 'Có mật khẩu.docx', reason: 'password' },
          ],
        },
        retryCount: 0,
        revealCount: 0,
      }
      Object.assign(globalThis, { __issuesFixture: fixture })
      for (const channel of [
        'home:get-indexing-activity',
        'home:get-document-index-issues',
        'home:retry-document-index',
        'home:reveal-document-index-file',
      ])
        ipcMain.removeHandler(channel)
      ipcMain.handle('home:get-indexing-activity', () => fixture.activity)
      ipcMain.handle('home:get-document-index-issues', () => fixture.issues)
      ipcMain.handle('home:retry-document-index', () => {
        fixture.retryCount++
        return { ok: false, error: 'paused' }
      })
      ipcMain.handle('home:reveal-document-index-file', () => {
        fixture.revealCount++
        return { ok: true }
      })
    })
    const home = await waitForPageWithUrl(launched.app, 'shell/out')
    const launcher = home.locator('.indexing-activity-launcher')
    await expect(launcher).toContainText('Đang lập chỉ mục')
    await expect(launcher.locator('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '30')
    await expect(launcher.locator('.index-progress-ring')).not.toHaveClass(/is-error/)
    await home.locator('.indexing-activity-issues-toggle').click()
    const rows = home.locator('.indexing-activity-issue')
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText('OCR')
    await expect(rows.last()).toContainText(/mật khẩu/)
    await rows.last().getByRole('button', { name: 'Thử lại' }).click()
    await expect(rows.last().getByRole('alert')).toBeVisible()
    await expect(rows.last().getByRole('alert')).not.toContainText('paused')
    await rows.first().getByRole('button', { name: 'Hiện trong thư mục' }).click()
    await expect
      .poll(() => launched.app.evaluate(() => (globalThis as any).__issuesFixture.revealCount))
      .toBe(1)
    await home.screenshot({ path: 'e2e/artifacts/index-issues-vi.png' })
    await home.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await home.screenshot({ path: 'e2e/artifacts/index-issues-dark.png' })
    await launched.app.evaluate(() => {
      const f = (globalThis as any).__issuesFixture
      Object.assign(f.activity.folderProgress, { pendingFiles: 0, readyFiles: 18, percent: 99 })
    })
    await expect(launcher.locator('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '100')
    await expect(launcher).toContainText(/cảnh báo/)
    await home.locator('.home-hero').click()
    await expect(home.locator('.indexing-activity-panel')).toHaveCount(0)
  } finally {
    await closeAndSaveVideo(launched, 'index-issues')
  }
})
