import { test, expect } from '@playwright/test'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from './helpers'

test('Ask AI and the fork index dashboard remain separate home views', async () => {
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'upstream-home-navigation' })
  try {
    const home = await waitForPageWithUrl(launched.app, 'shell/out')
    const sidebar = home.locator('.sidebar')
    const ask = sidebar.getByRole('button', { name: 'Ask AI', exact: true })
    const index = sidebar.getByRole('button', { name: 'Index', exact: true })
    await ask.click()
    await expect(home.locator('.home-chat-panel.is-workspace')).toBeVisible()
    await expect(home.locator('.home-chat-launcher')).toHaveCount(0)
    await expect(sidebar.locator('.nav-item.active')).toHaveCount(1)
    await index.click()
    await expect(home.locator('.idx-page')).toBeVisible()
    await expect(home.locator('.home-chat-panel.is-workspace')).toHaveCount(0)
    await expect(sidebar.locator('.nav-item.active')).toHaveCount(1)
    await ask.click()
    await expect(home.locator('.home-chat-panel.is-workspace')).toBeVisible()
    await expect(home.locator('.home-chat-launcher')).toHaveCount(0)
    await expect(home.locator('.idx-page')).toHaveCount(0)
    await home.evaluate(() => window.dispatchEvent(new Event('genoffice-open-index')))
    await expect(home.locator('.idx-page')).toBeVisible()
    await expect(home.locator('.home-chat-panel.is-workspace')).toHaveCount(0)
    await sidebar.getByRole('button', { name: /^Recent/ }).click()
    await expect(home.locator('.idx-page')).toHaveCount(0)
    await expect(home.locator('.home-chat-panel.is-workspace')).toHaveCount(0)
    await expect(sidebar.locator('.nav-item.active')).toHaveCount(1)
  } finally {
    await closeAndSaveVideo(launched, 'upstream-home-navigation')
  }
})
