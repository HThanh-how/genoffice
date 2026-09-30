import type { HomeApi } from '../apps/shell/src/shared/home-api'
import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeAndSaveVideo, launchShell, screenshotPath, waitForPageWithUrl } from './helpers'

test('home chat finds remembered content, opens its source and preserves the home layout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'genoffice-home-chat-'))
  const source = join(root, 'annual-budget.md')
  await writeFile(source, '# Moonstone\nClass 2/1 guardian phone 0912345678\n')
  const requests: Array<{
    messages: Array<{ role: string; content?: string }>
    tools?: unknown[]
  }> = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const bytes of req) body += bytes
    const payload = JSON.parse(body)
    requests.push(payload)
    const tools = payload.messages.filter((m: { role: string }) => m.role === 'tool')
    const sendCall = (name: string, input: object) => {
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }] })}\n\n`,
      )
      res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (tools.length === 0)
      sendCall('search_remembered_documents', { query: 'Moonstone class 2/1', limit: 4 })
    else if (tools.length === 1) {
      const hit = JSON.parse(tools[0].content).hits[0]
      sendCall('read_remembered_document', { chunk_id: hit.chunkId })
    } else {
      res.write(
        'data: {"choices":[{"delta":{"content":"The phone is 0912345678 in annual-budget.md."}}]}\n\n',
      )
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    }
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const launched = await launchShell({
    onboardingSeen: true,
    openFile: source,
    videoDir: 'home-chat',
  })
  const home = await waitForPageWithUrl(launched.app, '/renderer/index.html')
  try {
    await expect
      .poll(async () =>
        home.evaluate(async () => {
          const api = (window as Window & { aiOffice: HomeApi }).aiOffice
          const status = await api.getDocumentMemoryStatus()
          return status.chunks
        }),
      )
      .toBeGreaterThan(0)
    await home.evaluate(async (baseUrl) => {
      const api = (window as Window & { aiOffice: HomeApi }).aiOffice
      const settings = await api.getAiSettings()
      settings.provider = 'openai'
      settings.providers.openai = { apiKey: 'local-test-key', model: 'test-model', baseUrl }
      await api.setAiSettings(settings)
    }, `http://127.0.0.1:${address.port}/v1`)
    await home.locator('.tab-item.tab-home').click()
    await expect(home.locator('.home-hero')).toBeVisible()
    const before = await home.locator('.home-hero').boundingBox()
    await home.locator('.home-chat-launcher').click()
    await expect(home.locator('.home-chat-panel')).toBeVisible()
    expect(await home.locator('.home-hero').boundingBox()).toEqual(before)
    const input = home.locator('.home-chat-panel textarea')
    await input.fill('Find the phone in the Moonstone class 2/1 file')
    await input.press('Enter')
    await expect(home.locator('.home-chat-panel')).toContainText('The phone is 0912345678', {
      timeout: 30_000,
    })
    expect(requests).toHaveLength(3)
    expect(requests[0]!.tools).toHaveLength(3)
    const evidence = JSON.parse(
      requests[2]!.messages.filter((m) => m.role === 'tool').at(-1)!.content!,
    )
    expect(evidence.verified).toBe(true)
    await home.screenshot({ path: screenshotPath('home-chat-glass') })
    await home.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await home.screenshot({ path: screenshotPath('home-chat-glass-dark') })
    await home.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
    await home
      .locator('.home-chat-panel')
      .getByRole('button', { name: /annual-budget\.md/ })
      .click()
    await expect(home.locator('.tab-item').filter({ hasText: 'annual-budget.md' })).toHaveCount(1)
    await expect(home.locator('.home-hero')).not.toBeVisible()
  } finally {
    await closeAndSaveVideo(launched, 'home-chat')
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(root, { recursive: true, force: true })
  }
})
