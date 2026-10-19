import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HomeApi } from '../apps/shell/src/shared/home-api'
import { closeAndSaveVideo, launchShell, screenshotPath, waitForPageWithUrl } from './helpers'

test('Ask workspace shares persisted history and exports the visible answer from a long thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'genoffice-unified-chat-'))
  const profile = join(root, 'profile')
  const output = join(root, 'exports')
  await mkdir(profile)
  await mkdir(output)
  let launched: Awaited<ReturnType<typeof launchShell>> | undefined
  try {
    launched = await launchShell({
      onboardingSeen: true,
      userDataDir: profile,
      settings: { defaultSaveDir: output },
      videoDir: 'unified-home-chat',
    })
    let home = await waitForPageWithUrl(launched.app, '/renderer/index.html')
    const id = await home.evaluate(async () => {
      const api = (window as Window & { aiOffice: HomeApi }).aiOffice
      const settings = await api.getAiSettings()
      settings.provider = 'openai'
      settings.providers.openai = { apiKey: 'unused-local-fixture', model: 'fixture-model' }
      await api.setAiSettings(settings)
      const messages = Array.from({ length: 60 }, (_, i) => ({
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        text: i % 2 === 0 ? `Question ${i / 2}` : `Answer ${(i - 1) / 2}: persisted content`,
      }))
      const session = await api.homeChatSave({ title: 'Unified history fixture', messages })
      if (!session) throw new Error('Fixture history was not saved')
      localStorage.setItem('genoffice.homeChat.last', session.id)
      return session.id
    })
    await home.reload()
    await home.locator('.nav-item').filter({ hasText: 'Ask AI' }).click()
    const panel = home.locator('.home-chat-panel')
    await expect(panel).toHaveCount(1)
    await expect(panel).toHaveClass(/is-workspace/)
    await expect(panel).toContainText('Answer 29: persisted content')
    await expect(panel.locator('textarea')).toBeEnabled()
    await expect(home.getByText('Sign in to Genspark to use AI chat', { exact: true })).toHaveCount(
      0,
    )
    const lastAnswer = panel.locator('.hc-msg.assistant').last()
    await lastAnswer.locator('.hc-save-btn').first().click()
    await expect(lastAnswer.locator('.hc-save-btn-saved')).toBeVisible()
    const files = (await readdir(output)).filter((file) => file.endsWith('.md'))
    expect(files).toHaveLength(1)
    expect(await readFile(join(output, files[0]!), 'utf8')).toContain(
      'Answer 29: persisted content',
    )
    expect(await readFile(join(output, files[0]!), 'utf8')).not.toContain('Answer 0:')
    await home.screenshot({ path: screenshotPath('unified-home-chat-desktop') })
    await closeAndSaveVideo(launched, 'unified-home-chat-first-launch')
    launched = undefined

    // A real process restart must restore the same conversation, not just React state.
    launched = await launchShell({
      userDataDir: profile,
      onboardingSeen: true,
      videoDir: 'unified-home-chat-restart',
    })
    home = await waitForPageWithUrl(launched.app, '/renderer/index.html')
    await home.locator('.nav-item').filter({ hasText: 'Ask AI' }).click()
    await expect(home.locator('.home-chat-panel')).toContainText('Answer 29: persisted content')
    await expect(home.locator('.home-chat-panel textarea')).toBeEnabled()
    expect(
      await home.evaluate(async (sessionId) => {
        const api = (window as Window & { aiOffice: HomeApi }).aiOffice
        return (await api.homeChatGet(sessionId))?.messages.length
      }, id),
    ).toBe(60)
    await home.setViewportSize({ width: 700, height: 800 })
    // A responsive rail must not cover the only control that can close it.
    await home.locator('.home-chat-panel .hc-header button').first().click({ trial: true })
    await home.screenshot({ path: screenshotPath('unified-home-chat-narrow') })
    const bounds = await home.locator('.home-chat-panel').boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(701)
  } finally {
    if (launched) {
      await closeAndSaveVideo(launched, 'unified-home-chat')
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('a deferred export cannot update another conversation at the same message index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'genoffice-export-ownership-'))
  const launched = await launchShell({
    userDataDir: root,
    onboardingSeen: true,
    videoDir: 'unified-export-ownership',
  })
  try {
    const home = await waitForPageWithUrl(launched.app, '/renderer/index.html')
    await home.evaluate(async () => {
      const api = (window as Window & { aiOffice: HomeApi }).aiOffice
      await api.homeChatSave({
        title: 'Session B',
        messages: [
          { role: 'user', text: 'Question B' },
          { role: 'assistant', text: 'Answer B' },
        ],
      })
      const a = await api.homeChatSave({
        title: 'Session A',
        messages: [
          { role: 'user', text: 'Question A' },
          { role: 'assistant', text: 'Answer A' },
        ],
      })
      if (!a) throw new Error('Fixture session missing')
      localStorage.setItem('genoffice.homeChat.last', a.id)
    })
    await home.reload()
    await home.locator('.nav-item').filter({ hasText: 'Ask AI' }).click()
    const panel = home.locator('.home-chat-panel')
    await expect(panel).toContainText('Answer A')
    await launched.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('kb:create-document')
      ipcMain.handle(
        'kb:create-document',
        () =>
          new Promise((resolve) => {
            Object.assign(globalThis, {
              releaseFixtureExport: () => resolve({ path: '/fixture/answer-a.md' }),
            })
          }),
      )
    })
    await panel.locator('.hc-msg.assistant .hc-save-btn').first().click()
    await expect
      .poll(() =>
        launched.app.evaluate(() => typeof Reflect.get(globalThis, 'releaseFixtureExport')),
      )
      .toBe('function')
    await panel.locator('.hc-row-main').filter({ hasText: 'Session B' }).click()
    await expect(panel).toContainText('Answer B')
    await launched.app.evaluate(() => Reflect.get(globalThis, 'releaseFixtureExport')())
    // Flush the late IPC completion and React update through the renderer's next frames.
    await home.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await expect(panel.locator('.hc-save-btn-saved')).toHaveCount(0)
    await expect(panel).not.toContainText('answer-a.md')
  } finally {
    await closeAndSaveVideo(launched, 'unified-export-ownership')
    await rm(root, { recursive: true, force: true })
  }
})
