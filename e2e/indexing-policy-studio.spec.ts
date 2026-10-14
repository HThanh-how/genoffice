import { test, expect } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo } from './helpers'

const ARTIFACT_DIR =
  '/Users/huythanh/.gemini/antigravity/brain/8f15fa04-dd93-42f0-834c-819c2df5ce12'

test('captures all 7 enterprise indexing policy studio screenshots and validates interactions', async () => {
  const scratchDir = await mkdtemp(join(tmpdir(), 'genoffice-studio-e2e-'))
  const launched = await launchShell({
    onboardingSeen: true,
    scanFolder: scratchDir,
    videoDir: 'studio-shots',
  })
  const { page } = launched

  try {
    // 1. Open Index Dashboard
    const navItem = page
      .locator('.nav-item')
      .filter({ hasText: /Index|Chỉ mục/ })
      .first()
    await expect(navItem).toBeVisible()
    await navItem.click()
    await expect(page.locator('.idx-page')).toBeVisible()

    // 2. Switch to Settings Tab
    const settingsTab = page.locator('#index-tab-settings')
    await expect(settingsTab).toBeVisible()
    await settingsTab.click()

    // 3. Wait for Indexing Rules Studio container
    const studio = page.locator('.ixs-studio')
    await expect(studio).toBeVisible()

    // State 1: Dark theme, compact rules
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot-1-dark-compact.png') })

    // State 2: Light theme
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot-2-light-theme.png') })

    // Reset back to dark theme
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))

    // State 3: Allowlist mode
    const allowlistBtn = page.locator('.ixs-mode-btn').filter({ hasText: /Allowlist/i })
    await allowlistBtn.click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot-3-allowlist-mode.png') })

    // State 4: Large rule set (add sample rules via IPC to show pagination and density)
    await page.evaluate(async () => {
      const sampleRules = []
      for (let i = 1; i <= 25; i++) {
        sampleRules.push({
          id: `enterprise-rule-${i}`,
          pattern:
            i % 2 === 0
              ? `**/financial_q${(i % 4) + 1}/**/*.xlsx`
              : `**/compliance_archive_${i}/**`,
          enabled: true,
          scope: 'global',
          action: i % 3 === 0 ? 'allow' : 'ignore',
          description: `Enterprise policy rule ${i}`,
          source: 'user',
        })
      }
      const api = (
        window as unknown as {
          aiOffice?: { saveIgnorePolicyConfig?: (c: unknown) => Promise<unknown> }
        }
      ).aiOffice
      if (api?.saveIgnorePolicyConfig) {
        await api.saveIgnorePolicyConfig({ rules: sampleRules })
      }
    })
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot-4-large-ruleset.png') })

    // State 5: .genofficeignore Editor Drawer
    const openEditorBtn = page.locator('.ixs-btn-open-editor')
    await expect(openEditorBtn).toBeVisible()
    await openEditorBtn.click()
    await expect(page.locator('.ixs-editor-drawer')).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot-5-editor-drawer.png') })

    // State 7: Validation / Save error state in Drawer
    const textarea = page.locator('.ixs-editor-textarea')
    await textarea.fill('@mode unknown-mode\n!valid.docx\n')
    const saveBtn = page.locator('.ixs-btn-save-drawer')
    await expect(saveBtn).toBeVisible()
    await saveBtn.click()
    await page.waitForTimeout(400)
    await expect(page.locator('.ixs-alert-danger')).toBeVisible()
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot-7-validation-error.png') })

    // Close drawer
    const closeDrawerBtn = page.locator('.ixs-btn-close-drawer')
    await closeDrawerBtn.click()
    await expect(page.locator('.ixs-editor-drawer')).toHaveCount(0)

    // State 6: Path Tester showing conflicting Allow/Ignore rules
    const testInput = page.locator('.ixs-tester-input')
    await testInput.fill('/workspace/financial_q1/secret_report.xlsx')
    const testBtn = page.locator('.ixs-tester-btn')
    await testBtn.click()
    await page.waitForTimeout(500)
    await expect(page.locator('.ixs-tester-result')).toBeVisible()
    await page.screenshot({ path: join(ARTIFACT_DIR, 'screenshot-6-path-tester-conflict.png') })
  } finally {
    await closeAndSaveVideo(launched, 'studio-shots')
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {})
  }
})
