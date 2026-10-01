import { test, expect } from '@playwright/test'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

test('isolated index process embeds real local contents while Home remains interactive', async () => {
  test.skip(!process.env.GENOFFICE_EMBEDDING_TEST_CACHE, 'Local pinned model opt-in')
  test.setTimeout(90_000)
  const scratch = await mkdtemp(join(tmpdir(), 'index-cpu-e2e-'))
  const data = join(scratch, 'userdata'),
    folder = join(scratch, 'documents')
  await mkdir(data)
  await mkdir(folder)
  await cp(process.env.GENOFFICE_EMBEDDING_TEST_CACHE!, join(data, 'document-memory-models'), {
    recursive: true,
  })
  for (let i = 0; i < 6; i++)
    await writeFile(
      join(folder, `class-${i}.txt`),
      `Lớp 2/1. Học sinh Nguyễn An ${i}. Điện thoại phụ huynh: 0901234567.`,
    )
  const launched = await launchShell({
    userDataDir: data,
    onboardingSeen: true,
    scanFolder: folder,
    videoDir: 'index-cpu',
  })
  try {
    const home = await waitForPageWithUrl(launched.app, 'shell/out')
    await expect(home.locator('.home-hero')).toBeVisible()
    await home.locator('.home-chat-launcher').click()
    await expect(home.locator('.home-chat-panel')).toBeVisible()
    await expect
      .poll(
        async () => (await home.evaluate(() => window.aiOffice.getDocumentMemoryStatus())).vectors,
        { timeout: 60_000 },
      )
      .toBe(6)
    const activity = await home.evaluate(() => window.aiOffice.getIndexingActivity())
    expect(activity.memory.cpuMode).toBe('gentle')
    expect(activity.folderProgress?.readyFiles).toBe(6)
    const result = await home.evaluate(() =>
      window.aiOffice.documentMemorySearch('số điện thoại học sinh lớp 2/1'),
    )
    expect(result.modelState).toBe('ready')
    expect(result.hits[0]?.text).toContain('0901234567')
  } finally {
    await closeAndSaveVideo(launched, 'index-cpu')
    await rm(scratch, { recursive: true, force: true })
  }
})
