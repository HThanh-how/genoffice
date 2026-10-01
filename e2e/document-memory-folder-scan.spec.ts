import { test, expect } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

test('selected folder launch indexes nested content without opening documents or scanning siblings', async () => {
  test.setTimeout(120_000)
  const scratch = await mkdtemp(join(tmpdir(), 'genoffice-folder-e2e-'))
  const folder = join(scratch, 'Selected folder')
  await mkdir(join(folder, 'nested'), { recursive: true })
  await writeFile(
    join(folder, 'nested', 'budget.txt'),
    'Moonstone class 2/1 guardian phone 0912345678',
  )
  await writeFile(join(scratch, 'outside.txt'), 'Outside sentinel')
  await writeFile(join(folder, 'ignored.exe'), 'ignored')
  const launched = await launchShell({
    onboardingSeen: true,
    videoDir: 'folder-scan',
    scanFolder: folder,
  })
  try {
    const page = await waitForPageWithUrl(launched.app, 'shell/out')
    await expect
      .poll(() => page.evaluate(() => window.aiOffice.getDocumentFolderScanStatus()), {
        timeout: 30_000,
      })
      .toMatchObject({ running: false, root: folder, discovered: 1, enrolled: 1 })
    await expect
      .poll(
        async () => (await page.evaluate(() => window.aiOffice.getDocumentMemoryStatus())).chunks,
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0)
    const status = await page.evaluate(() => window.aiOffice.getDocumentMemoryStatus())
    expect(status.documents).toBe(1)
    const result = await page.evaluate(() =>
      window.aiOffice.documentMemorySearch('Moonstone guardian'),
    )
    expect(result.hits[0]?.text).toContain('0912345678')
    const read = await page.evaluate(
      (id) => window.aiOffice.documentMemoryRead(id),
      result.hits[0]!.chunkId,
    )
    expect(read.verified).toBe(true)
    expect(read.path).toBe(join(folder, 'nested', 'budget.txt'))
  } finally {
    await closeAndSaveVideo(launched)
    await rm(scratch, { recursive: true, force: true })
  }
})
