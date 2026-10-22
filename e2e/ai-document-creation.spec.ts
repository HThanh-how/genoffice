import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HomeApi } from '../apps/shell/src/shared/home-api'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from './helpers'
import { validateGeneratedDocx } from '../packages/cli/src/formats/docx-validation'

test.describe('AI Document Creation, Idempotency, and Tab Management', () => {
  test('AgentLoop creates DOCX via create_document tool and automatically opens exactly one editor tab', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-ai-doc-e2e-'))
    const profile = join(root, 'profile')
    const output = join(root, 'saveDir')
    await mkdir(profile)
    await mkdir(output)

    const requests: Array<{
      messages: Array<{ role: string; content?: string }>
      tools?: Array<{ type: string; function: { name: string } }>
    }> = []

    const server = createServer(async (req, res) => {
      let body = ''
      for await (const bytes of req) body += bytes
      const payload = JSON.parse(body)
      requests.push(payload)
      const tools = payload.messages.filter((m: { role: string }) => m.role === 'tool')

      res.writeHead(200, { 'content-type': 'text/event-stream' })

      if (tools.length === 0) {
        // First turn: LLM emits create_document tool call
        const callArgs = {
          title: 'Quarterly Scientific Report',
          format: 'docx',
          content:
            '# Quarterly Scientific Report\n\nMethodology and findings with null hypothesis.\n\n## Section 1\n\nDetailed results.',
          documentType: 'scientific-report',
        }
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-scientific-1',
                      type: 'function',
                      function: {
                        name: 'create_document',
                        arguments: JSON.stringify(callArgs),
                      },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        )
        res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
      } else {
        // Tool completed: LLM emits confirmation message with cite link
        const toolMsg = tools[0]
        const toolContent = toolMsg.content || ''
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  content: `I have saved your document. Path: ${toolContent.includes('Quarterly Scientific Report.docx') ? 'Quarterly Scientific Report.docx' : 'saved'}`,
                },
              },
            ],
          })}\n\n`,
        )
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
      }
      res.end('data: [DONE]\n\n')
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }

    let launched: Awaited<ReturnType<typeof launchShell>> | undefined
    try {
      launched = await launchShell({
        onboardingSeen: true,
        userDataDir: profile,
        settings: { defaultSaveDir: output },
        videoDir: 'ai-document-creation',
      })
      const home = await waitForPageWithUrl(launched.app, '/renderer/index.html')

      // Configure local deterministic AI endpoint
      await home.evaluate(async (baseUrl) => {
        const api = (window as Window & { aiOffice: HomeApi }).aiOffice
        const settings = await api.getAiSettings()
        settings.provider = 'openai'
        settings.providers.openai = { apiKey: 'local-test-key', model: 'test-model', baseUrl }
        await api.setAiSettings(settings)
      }, `http://127.0.0.1:${address.port}/v1`)

      // 1. Initial State: Zero launcher and zero floating panel
      await expect(home.locator('.home-chat-launcher')).toHaveCount(0)
      await expect(home.locator('.home-chat-panel')).toHaveCount(0)

      // The Home input hands the prompt to the Ask AI page.
      const input = home.locator('#home-assistant-slot input')
      await input.fill('Create a quarterly scientific report document')
      await input.press('Enter')
      const workspacePanel = home.locator('#home-ask-workspace .home-chat-panel')
      await expect(workspacePanel).toHaveCount(1)
      await expect(workspacePanel).toBeVisible()
      await expect(workspacePanel.locator('.hc-msg.user')).toHaveText(
        'Create a quarterly scientific report document',
      )

      // 4. Assert AgentLoop dispatched create_document and assistant answered
      await expect(workspacePanel.locator('.hc-msg.assistant')).toContainText(
        'Quarterly Scientific Report.docx',
        { timeout: 30_000 },
      )

      // 5. Assert physical DOCX file exists on disk in output saveDir
      const savedFiles = (await readdir(output)).filter((f) => f.endsWith('.docx'))
      expect(savedFiles).toHaveLength(1)
      expect(savedFiles[0]).toBe('Quarterly Scientific Report.docx')

      // 6. Assert exactly one editor tab opened for the created document
      const docTab = home.locator('.tab-item').filter({ hasText: 'Quarterly Scientific Report' })
      await expect(docTab).toHaveCount(1)

      // 7. Validate generated DOCX contents and typography profile
      const bytes = await readFile(join(output, savedFiles[0]!))
      const validation = await validateGeneratedDocx(bytes, {
        requireHeading: true,
        minParagraphs: 2,
        expectedText: 'Quarterly Scientific Report',
        checkPlaceholders: true,
      })
      expect(validation.ok, `Validation errors: ${validation.errors.join(', ')}`).toBe(true)

      // 8. Test Navigation Away: Navigating to Recent must unmount workspace and not leak floating panel
      await home.locator('.tab-item.tab-home').click()
      await home.locator('.nav-item').filter({ hasText: 'Recent' }).click()
      await expect(home.locator('.home-chat-panel')).toHaveCount(0)
      await expect(home.locator('.home-chat-launcher')).toHaveCount(0)

      // Navigating back to Ask AI restores workspace cleanly
      await home.locator('.nav-item').filter({ hasText: 'Ask AI' }).click()
      await expect(home.locator('#home-ask-workspace .home-chat-panel')).toHaveCount(1)
    } finally {
      if (launched) {
        await closeAndSaveVideo(launched, 'ai-document-creation')
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Direct IPC multi-document creation and idempotency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-ipc-doc-'))
    const profile = join(root, 'profile')
    const output = join(root, 'saveDir')
    await mkdir(profile)
    await mkdir(output)

    let launched: Awaited<ReturnType<typeof launchShell>> | undefined
    try {
      launched = await launchShell({
        onboardingSeen: true,
        userDataDir: profile,
        settings: { defaultSaveDir: output },
        videoDir: 'ai-document-creation-ipc',
      })
      const home = await waitForPageWithUrl(launched.app, '/renderer/index.html')

      const creationResult = await home.evaluate(async () => {
        const api = (window as Window & { aiOffice: HomeApi }).aiOffice
        const sessionId = 'test-session-e2e'
        const userTurnId = 'turn-1'

        // Create doc 1 (single doc with profile)
        const doc1 = await api.kbCreateDocument({
          title: 'Quarterly Scientific Report',
          format: 'docx',
          content:
            '# Quarterly Scientific Report\n\nMethodology and findings with null hypothesis.',
          documentType: 'scientific-report',
          sessionId,
          userTurnId,
          callId: 'call-1',
        })

        // Replay doc 1 (idempotency check with same callId)
        const doc1Replay = await api.kbCreateDocument({
          title: 'Quarterly Scientific Report',
          format: 'docx',
          content:
            '# Quarterly Scientific Report\n\nMethodology and findings with null hypothesis.',
          documentType: 'scientific-report',
          sessionId,
          userTurnId,
          callId: 'call-1',
        })

        // Distinct docs in same turn with different callId
        const doc2 = await api.kbCreateDocument({
          title: 'Executive Memo',
          format: 'docx',
          content: '# Executive Memo\n\nSummary for stakeholders.',
          documentType: 'memo',
          sessionId,
          userTurnId,
          callId: 'call-2',
        })

        const doc3 = await api.kbCreateDocument({
          title: 'Project Proposal',
          format: 'docx',
          content: '# Project Proposal\n\nBudget and timeline.',
          documentType: 'proposal',
          sessionId,
          userTurnId,
          callId: 'call-3',
        })

        return {
          doc1Path: doc1.path,
          doc1ReplayPath: doc1Replay.path,
          doc2Path: doc2.path,
          doc3Path: doc3.path,
        }
      })

      // Verify idempotency: replayed creation returns identical path
      expect(creationResult.doc1ReplayPath).toBe(creationResult.doc1Path)

      // Verify distinct documents: Doc 1, Doc 2, Doc 3 have distinct paths
      expect(creationResult.doc2Path).not.toBe(creationResult.doc1Path)
      expect(creationResult.doc3Path).not.toBe(creationResult.doc1Path)
      expect(creationResult.doc3Path).not.toBe(creationResult.doc2Path)

      const savedFiles = (await readdir(output)).filter((f) => f.endsWith('.docx'))
      expect(savedFiles).toHaveLength(3)
    } finally {
      if (launched) {
        await closeAndSaveVideo(launched, 'ai-document-creation-ipc')
      }
      await rm(root, { recursive: true, force: true })
    }
  })
})
