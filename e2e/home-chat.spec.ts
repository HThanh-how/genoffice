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
    tools?: Array<{ type: string; function: { name: string } }>
  }> = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const bytes of req) body += bytes
    const payload = JSON.parse(body)
    requests.push(payload)
    const lastUserMsg = payload.messages
      .filter((m: { role: string }) => m.role === 'user')
      .at(-1)?.content
    const tools = payload.messages.filter((m: { role: string }) => m.role === 'tool')
    const sendCall = (name: string, input: object) => {
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }] })}\n\n`,
      )
      res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (typeof lastUserMsg === 'string' && lastUserMsg.startsWith('Check knowledge base')) {
      res.write(
        'data: {"choices":[{"delta":{"content":"Knowledge base contains starred files."}}]}\n\n',
      )
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    } else if (tools.length === 0)
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
    await expect(home.locator('.home-chat-launcher')).toHaveCount(0)

    const askBtn = home.locator('.sidebar').getByRole('button', { name: 'Ask AI', exact: true })
    await askBtn.click()
    await expect(home.locator('#home-ask-workspace .home-chat-panel')).toBeVisible()
    await expect(home.locator('.home-chat-launcher')).toHaveCount(0)

    const input = home.locator('.home-chat-panel textarea')
    await input.fill('draft should remain after collapsing')

    const homeTab = home.locator('.tab-item.tab-home')
    await homeTab.evaluate((node) =>
      node.addEventListener('click', () => node.setAttribute('data-test-click-received', 'true'), {
        once: true,
      }),
    )
    await homeTab.click()
    await expect(home.locator('#home-ask-workspace .home-chat-panel')).toBeHidden()
    await expect(homeTab).toHaveAttribute('data-test-click-received', 'true')
    await expect(home.locator('.home-hero')).toBeVisible()
    await expect(home.locator('.home-chat-launcher')).toHaveCount(0)

    await askBtn.click()
    await expect(home.locator('#home-ask-workspace .home-chat-panel')).toBeVisible()
    await expect(home.locator('.home-chat-launcher')).toHaveCount(0)
    await expect(input).toHaveValue('draft should remain after collapsing')

    await input.fill('Find the phone in the Moonstone class 2/1 file')
    await input.press('Enter')
    await expect(home.locator('.home-chat-panel')).toContainText('The phone is 0912345678', {
      timeout: 30_000,
    })
    expect(requests).toHaveLength(3)
    // Empty knowledge base: remembered documents and incremental document creation.
    expect(requests[0]!.tools?.map((t) => t.function.name)).toEqual(
      expect.arrayContaining([
        'search_remembered_documents',
        'read_remembered_document',
        'open_remembered_document',
        'create_document',
        'append_to_document',
      ]),
    )
    const evidence = JSON.parse(
      requests[2]!.messages.filter((m) => m.role === 'tool').at(-1)!.content!,
    )
    expect(evidence.verified).toBe(true)

    // Starred files add the two knowledge-base tools.
    await home.evaluate(async (p) => {
      const api = (window as Window & { aiOffice: HomeApi }).aiOffice
      await api.toggleStar(p)
    }, source)
    await input.fill('Check knowledge base')
    await input.press('Enter')
    await expect(home.locator('.home-chat-panel')).toContainText(
      'Knowledge base contains starred files.',
      { timeout: 30_000 },
    )
    const starredRequest = requests[3]!
    expect(starredRequest.tools?.map((t) => t.function.name)).toEqual(
      expect.arrayContaining([
        'search_remembered_documents',
        'read_remembered_document',
        'open_remembered_document',
        'read_knowledge_file',
        'search_knowledge_base',
        'create_document',
        'append_to_document',
      ]),
    )
    await home.screenshot({ path: screenshotPath('home-chat-glass') })
    await home.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await home.screenshot({ path: screenshotPath('home-chat-glass-dark') })
    await home.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
    await home
      .locator('.home-chat-panel .hc-answer .hc-file-open')
      .filter({ hasText: 'annual-budget.md' })
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
