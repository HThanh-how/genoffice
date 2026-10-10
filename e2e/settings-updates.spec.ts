import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

test('About saves a validated source and offers an immediate update check', async () => {
  const launched = await launchShell({
    onboardingSeen: true,
    settings: { starPrompt: { resolved: true } },
    videoDir: 'settings-updates',
  })
  const { page, userDataDir } = launched
  try {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.locator('.set-nav-item').filter({ hasText: 'About' }).click()
    const source = page.getByRole('textbox', { name: 'Update source', exact: true })
    const check = page.getByRole('button', { name: 'Check for updates', exact: true })
    await expect(source).toHaveValue('HThanh-how/genoffice')
    await expect(check).toBeEnabled()
    await source.fill('other-owner/office')
    await expect(check).toBeDisabled()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.locator('.set-field-desc[role="status"]')).toHaveText('Saved')
    await expect(check).toBeEnabled()
    const saved = JSON.parse(await readFile(join(userDataDir, 'app-settings.json'), 'utf8'))
    expect(saved.updateSource).toEqual({ kind: 'github', value: 'other-owner/office' })
    await source.fill('../invalid')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.locator('.set-field-desc[role="status"]')).toHaveText(
      'Invalid update source or connection failed.',
    )
    expect(
      JSON.parse(await readFile(join(userDataDir, 'app-settings.json'), 'utf8')).updateSource,
    ).toEqual(saved.updateSource)
    await source.fill('HThanh-how/genoffice')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(check).toBeEnabled()
    // Stub only the OS dialog in this isolated test instance; exercise the real
    // renderer -> preload -> main IPC and update-source request.
    await launched.app.evaluate(({ net, dialog }) => {
      const state = globalThis as typeof globalThis & { updateCheckDialogCount?: number }
      state.updateCheckDialogCount = 0
      net.fetch = async () => new Response('[]')
      dialog.showMessageBox = (async () => {
        state.updateCheckDialogCount = (state.updateCheckDialogCount ?? 0) + 1
        return { response: 0, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    })
    await check.click()
    await expect
      .poll(() =>
        launched.app.evaluate(
          () =>
            (globalThis as typeof globalThis & { updateCheckDialogCount?: number })
              .updateCheckDialogCount,
        ),
      )
      .toBe(1)
    await page.screenshot({ path: screenshotPath('settings-updates') })
  } finally {
    await closeAndSaveVideo(launched, 'settings-updates')
  }
})
