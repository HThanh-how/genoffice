import { test, expect } from '@playwright/test'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

test('file warnings preserve ongoing progress and expose localized retry actions', async () => {
  const launched = await launchShell({
    onboardingSeen: true,
    lang: 'vi',
    videoDir: 'index-issues',
    settings: { starPrompt: { resolved: true } },
  })
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
        'home:star-prompt-should-show',
        'home:get-indexing-activity',
        'home:get-document-index-snapshot',
        'home:get-document-index-issue-summary',
        'home:get-document-index-issues',
        'home:retry-document-index',
        'home:enqueue-document-index',
        'home:reveal-document-index-file',
      ])
        ipcMain.removeHandler(channel)
      ipcMain.handle('home:star-prompt-should-show', () => ({ show: false, docOpens: 0 }))
      ipcMain.handle('home:get-indexing-activity', () => fixture.activity)
      ipcMain.handle('home:get-document-index-snapshot', () => ({
        memory: {
          enabled: fixture.activity.memory.enabled,
          modelState: fixture.activity.memory.modelState,
          documents: fixture.activity.folderProgress.readyFiles,
          chunks: fixture.activity.folderProgress.completedChunks,
          vectors: fixture.activity.folderProgress.completedChunks,
          pending: fixture.activity.memory.pending,
          errors: fixture.activity.memory.errors,
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
        issues: {
          total: fixture.issues.total,
          groups: [
            { reason: 'no-text', count: 1 },
            { reason: 'password', count: 1 },
          ],
        },
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
      ipcMain.handle('home:get-document-index-issue-summary', () => ({
        total: fixture.issues.total,
        groups: [
          { reason: 'no-text', count: 1 },
          { reason: 'password', count: 1 },
        ],
      }))
      ipcMain.handle('home:get-document-index-issues', (_event, _root, offset = 0, reason) => {
        const filtered = reason
          ? fixture.issues.items.filter((item: any) => item.reason === reason)
          : fixture.issues.items
        return {
          total: filtered.length,
          items: filtered.slice(Number(offset) || 0, (Number(offset) || 0) + 10),
        }
      })
      ipcMain.handle('home:retry-document-index', () => {
        fixture.retryCount++
        return { ok: true }
      })
      ipcMain.handle('home:enqueue-document-index', (_event, ids: number[]) => {
        fixture.retryCount += Array.isArray(ids) ? ids.length : 1
        return { queued: Array.isArray(ids) ? ids.length : 1, skipped: 0 }
      })
      ipcMain.handle('home:reveal-document-index-file', () => {
        fixture.revealCount++
        return { ok: true }
      })
    })
    const home = await waitForPageWithUrl(launched.app, 'shell/out')
    await home
      .locator('.nav-item')
      .filter({ hasText: /Chỉ mục|Index/ })
      .click()
    await expect(home.locator('.idx-page')).toBeVisible()

    const statusCard = home.locator('.idx-status.is-working')
    await expect(statusCard).toBeVisible()
    await expect(statusCard.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30')
    await expect(statusCard.locator('.idx-facts > div').nth(1).locator('dd')).toHaveText('12')

    await home.getByRole('tab', { name: 'Cần xử lý' }).click()
    const damaged = home.locator('.idx-issue[data-section="damaged"]')
    const scans = home.locator('.idx-issue[data-section="ocr"]')
    await expect(damaged).toContainText(/mật khẩu/i)
    await expect(scans).toContainText('OCR')
    await damaged.locator('.idx-issue-main').click()
    await damaged.getByRole('button', { name: 'Mở tất cả' }).click()
    const lockedRow = damaged.locator('.ixp-row')
    await expect(lockedRow).toHaveCount(1)
    await expect(lockedRow).toContainText('Có mật khẩu.docx')
    await lockedRow.getByRole('button', { name: 'Thử lại', exact: true }).click()
    await expect
      .poll(() => launched.app.evaluate(() => (globalThis as any).__issuesFixture.retryCount))
      .toBeGreaterThan(0)

    await scans.locator('.idx-issue-main').click()
    await scans.getByRole('button', { name: 'Mở tất cả' }).click()
    const scannedRow = scans.locator('.ixp-row')
    await expect(scannedRow).toHaveCount(1)
    await expect(scannedRow).toContainText('Hồ sơ scan.pdf')
    await scannedRow.getByRole('button', { name: 'Mở thư mục chứa tệp', exact: true }).click()
    await expect
      .poll(() => launched.app.evaluate(() => (globalThis as any).__issuesFixture.revealCount))
      .toBe(1)

    await home.screenshot({ path: 'e2e/artifacts/index-issues-vi.png' })
    await home.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await home.screenshot({ path: 'e2e/artifacts/index-issues-dark.png' })

    await launched.app.evaluate(() => {
      const f = (globalThis as any).__issuesFixture
      f.activity.memory.pending = 0
      Object.assign(f.activity.folderProgress, { pendingFiles: 0, readyFiles: 18, percent: 100 })
    })

    await home.getByRole('tab', { name: 'Tổng quan' }).click()
    await expect(home.locator('.idx-status.is-attention')).toBeVisible()

    await home.locator('.idx-back').click()
    await expect(home.locator('.idx-page')).toHaveCount(0)
    await expect(home.locator('.home-hero')).toBeVisible()
  } finally {
    await closeAndSaveVideo(launched, 'index-issues')
  }
})
