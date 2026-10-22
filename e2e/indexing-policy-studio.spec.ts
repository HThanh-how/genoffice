import { test, expect, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo } from './helpers'

/**
 * Visual + workflow coverage for the redesigned Indexing Rules Studio.
 * Every screenshot goes to test.info().outputPath() so artifacts are portable
 * across machines (no hardcoded user directories).
 *
 * The Rules table always contains the seven built-in default rules plus the
 * rules parsed from the seeded .genofficeignore, so counts are asserted as
 * "at least N" rather than exact.
 */

async function openStudio(page: Page): Promise<void> {
  const navItem = page
    .locator('.nav-item')
    .filter({ hasText: /Index|Chỉ mục/ })
    .first()
  await expect(navItem).toBeVisible()
  await navItem.click()
  await expect(page.locator('.idx-page')).toBeVisible()
  const settingsTab = page.locator('#index-tab-settings')
  await expect(settingsTab).toBeVisible()
  await settingsTab.click()
  await page
    .locator('.ixs-row > summary')
    .filter({ hasText: /Ignore rules|Quy tắc loại trừ/ })
    .click()
  await expect(page.locator('.ixr')).toBeVisible()
  await page.locator('.ixr').scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  // Keep the donation prompt out of the frame so screenshots show the studio.
  const starPrompt = page.locator('.star-prompt-close')
  if (await starPrompt.isVisible().catch(() => false)) {
    await starPrompt.click()
    await page.waitForTimeout(300)
  }
}

async function studioNav(page: Page, label: string): Promise<void> {
  await page.locator('.ixr-nav button').filter({ hasText: label }).first().click()
  await page.waitForTimeout(400)
  await page.locator('.ixr').scrollIntoViewIfNeeded()
}

async function ruleCount(page: Page): Promise<number> {
  const text = await page.locator('.ixr-pagination').textContent()
  const match = /(\d+)\s+rules/.exec(text ?? '')
  return match ? Number(match[1]) : 0
}

function ignoreFileContent(ignoreCount: number): string {
  const lines = ['# GenOffice indexing policy', '@mode standard', '']
  for (let i = 1; i <= ignoreCount; i++) {
    lines.push(`**/archive_${i}/**`)
  }
  lines.push('!*.pdf', '!*.xlsx', '*.tmp', '*.bak')
  return lines.join('\n') + '\n'
}

test('studio overview, rules, tester and editor states (dark theme)', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'genoffice-studio-dark-'))
  await writeFile(join(scratch, '.genofficeignore'), ignoreFileContent(90))
  const launched = await launchShell({
    onboardingSeen: true,
    scanFolder: scratch,
    settings: { theme: 'dark' },
    viewport: { width: 1360, height: 902 },
    videoDir: 'studio-dark',
  })
  const { page } = launched
  try {
    await openStudio(page)
    await page.screenshot({ path: test.info().outputPath('overview-dark.png') })

    await studioNav(page, 'Rules')
    expect(await ruleCount(page)).toBeGreaterThanOrEqual(94)
    await expect(page.locator('.ixr-table tbody .ixr-row')).toHaveCount(25)
    await page.screenshot({ path: test.info().outputPath('rules-100.png') })

    // Allow filter narrows the table to the two allow directives.
    await page.locator('.ixr-segmented button').filter({ hasText: 'Allow' }).first().click()
    await page.waitForTimeout(400)
    await expect(page.locator('.ixr-table tbody .ixr-row')).toHaveCount(2)
    await page.screenshot({ path: test.info().outputPath('rules-filter-allow.png') })

    await studioNav(page, 'Overview')
    await page.fill('#ixr-tester-input', join(scratch, 'archive_1', 'note.docx'))
    await page.locator('.ixr-tester-form .ixr-btn').click()
    await expect(page.locator('.ixr-test-result')).toBeVisible()
    await expect(page.locator('.ixr-outcome')).toHaveText('Ignored')
    await page.screenshot({ path: test.info().outputPath('tester-ignored.png') })

    await studioNav(page, '.genofficeignore')
    await expect(page.locator('.ixr-editor-text')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('editor.png') })

    // Dirty draft: navigating away must prompt Save / Discard / Cancel.
    await page.fill('.ixr-editor-text', '@mode standard\n*.tmp\n')
    await studioNav(page, 'Overview')
    await expect(page.locator('.ui-feedback-dialog')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('unsaved-changes-dialog.png') })
    await page.locator('.ui-feedback-button').filter({ hasText: 'Cancel' }).click()
    await expect(page.locator('.ixr-editor-text')).toBeVisible()

    // Validation error state.
    await page.fill('.ixr-editor-text', '@mode unknown-mode\n')
    await page.locator('.ixr-editor-actions .ixr-btn-primary').click()
    await expect(page.locator('.ixr-error-list')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('editor-validation-error.png') })

    // Conflict state: the file changed on disk while the draft was open.
    await writeFile(join(scratch, '.genofficeignore'), '@mode standard\n# changed externally\n')
    await page.locator('.ixr-editor-actions .ixr-btn-primary').click()
    await expect(page.locator('.ixr-alert.warning')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('editor-conflict.png') })

    // The redesign replaced emoji controls with vector icons.
    const studioText = await page.locator('.ixr').textContent()
    expect(studioText).not.toMatch(/✦|🛡|📄|✏️|🗑|🔍|📋/)
  } finally {
    await closeAndSaveVideo(launched, 'studio-dark')
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
})

test('light theme and 1024x768 layout', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'genoffice-studio-narrow-'))
  await writeFile(join(scratch, '.genofficeignore'), ignoreFileContent(30))
  const launched = await launchShell({
    onboardingSeen: true,
    scanFolder: scratch,
    settings: { theme: 'light' },
    viewport: { width: 1024, height: 768 },
    videoDir: 'studio-narrow',
  })
  const { page } = launched
  try {
    await openStudio(page)
    await page.screenshot({ path: test.info().outputPath('overview-light.png') })
    await studioNav(page, 'Rules')
    await expect(page.locator('.ixr-table tbody .ixr-row')).toHaveCount(25)
    await page.screenshot({ path: test.info().outputPath('rules-narrow.png') })
  } finally {
    await closeAndSaveVideo(launched, 'studio-narrow')
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
})

test('1,000-rule workspace renders with pagination', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'genoffice-studio-large-'))
  await writeFile(join(scratch, '.genofficeignore'), ignoreFileContent(996))
  const launched = await launchShell({
    onboardingSeen: true,
    scanFolder: scratch,
    settings: { theme: 'dark' },
    viewport: { width: 1360, height: 902 },
    videoDir: 'studio-large',
  })
  const { page } = launched
  try {
    await openStudio(page)
    await studioNav(page, 'Rules')
    expect(await ruleCount(page)).toBeGreaterThanOrEqual(1000)
    await page.selectOption('.ixr-page-size select', '100')
    await page.waitForTimeout(400)
    await expect(page.locator('.ixr-table tbody .ixr-row')).toHaveCount(100)
    await page.screenshot({ path: test.info().outputPath('rules-1000.png') })
  } finally {
    await closeAndSaveVideo(launched, 'studio-large')
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
})

test('real Settings widths: 1280x800 and 1920x1080 high-DPI', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'genoffice-studio-hidpi-'))
  await writeFile(join(scratch, '.genofficeignore'), ignoreFileContent(10))
  const launched = await launchShell({
    onboardingSeen: true,
    scanFolder: scratch,
    settings: { theme: 'dark' },
    viewport: { width: 1920, height: 1080, deviceScaleFactor: 1.5 },
    videoDir: 'studio-hidpi',
  })
  const { page } = launched
  try {
    await openStudio(page)
    await page.screenshot({ path: test.info().outputPath('overview-highdpi.png') })

    // Resize the real window to 1280x800 and re-shoot the Rules view.
    await launched.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800)
    })
    await page.waitForTimeout(600)
    await studioNav(page, 'Rules')
    await page.screenshot({ path: test.info().outputPath('rules-1280.png') })
  } finally {
    await closeAndSaveVideo(launched, 'studio-hidpi')
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
})
