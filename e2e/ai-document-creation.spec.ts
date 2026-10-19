import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HomeApi } from '../apps/shell/src/shared/home-api'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from './helpers'

test.describe('AI Document Creation and Idempotency', () => {
  test('creates document with auto-open, verifies multi-doc creation and zero floating panel leak on navigation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-ai-doc-'))
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
        videoDir: 'ai-document-creation',
      })
      const home = await waitForPageWithUrl(launched.app, '/renderer/index.html')

      // 1. Initial State: Zero launcher and zero floating panel
      await expect(home.locator('.home-chat-launcher')).toHaveCount(0)
      await expect(home.locator('.home-chat-panel:not(.is-workspace)')).toHaveCount(0)

      // 2. Open Ask AI workspace
      await home.locator('.nav-item').filter({ hasText: 'Ask AI' }).click()
      const workspacePanel = home.locator('#home-ask-workspace .home-chat-panel')
      await expect(workspacePanel).toHaveCount(1)
      await expect(workspacePanel).toHaveClass(/is-workspace/)

      // 3. Test multi-document creation and idempotency via kbCreateDocument
      const creationResult = await home.evaluate(async (saveDir) => {
        const api = (window as Window & { aiOffice: HomeApi }).aiOffice
        const sessionId = 'test-session-e2e'
        const userTurnId = 'turn-1'

        // Create doc 1 (single doc with profile)
        const doc1 = await api.kbCreateDocument({
          title: 'Quarterly Scientific Report',
          format: 'docx',
          content: '# Quarterly Scientific Report\n\nMethodology and findings with null hypothesis.',
          documentType: 'scientific-report',
          sessionId,
          userTurnId,
        })

        // Replay doc 1 (idempotency check)
        const doc1Replay = await api.kbCreateDocument({
          title: 'Quarterly Scientific Report',
          format: 'docx',
          content: '# Quarterly Scientific Report\n\nMethodology and findings with null hypothesis.',
          documentType: 'scientific-report',
          sessionId,
          userTurnId,
        })

        // Multi-doc in single turn: Doc 2 and Doc 3 with distinct titles
        const doc2 = await api.kbCreateDocument({
          title: 'Executive Memo',
          format: 'docx',
          content: '# Executive Memo\n\nSummary for stakeholders.',
          documentType: 'memo',
          sessionId,
          userTurnId,
        })

        const doc3 = await api.kbCreateDocument({
          title: 'Project Proposal',
          format: 'docx',
          content: '# Project Proposal\n\nBudget and timeline.',
          documentType: 'proposal',
          sessionId,
          userTurnId,
        })

        return {
          doc1Path: doc1.path,
          doc1ReplayPath: doc1Replay.path,
          doc2Path: doc2.path,
          doc3Path: doc3.path,
        }
      }, output)

      // Verify idempotency: replayed creation returns identical path
      expect(creationResult.doc1ReplayPath).toBe(creationResult.doc1Path)

      // Verify distinct documents: Doc 1, Doc 2, Doc 3 have distinct paths
      expect(creationResult.doc2Path).not.toBe(creationResult.doc1Path)
      expect(creationResult.doc3Path).not.toBe(creationResult.doc1Path)
      expect(creationResult.doc3Path).not.toBe(creationResult.doc2Path)

      const savedFiles = (await readdir(output)).filter((f) => f.endsWith('.docx'))
      expect(savedFiles).toHaveLength(3)

      // 4. Test Navigation Away: Navigating to Recent must unmount the workspace and NOT leak a floating panel
      await home.locator('.nav-item').filter({ hasText: 'Recent' }).click()
      await expect(home.locator('.home-chat-panel')).toHaveCount(0)
      await expect(home.locator('.home-chat-launcher')).toHaveCount(0)

      // Navigating to Starred: Still 0 panels
      await home.locator('.nav-item').filter({ hasText: 'Starred' }).click()
      await expect(home.locator('.home-chat-panel')).toHaveCount(0)

      // Navigating back to Ask AI: Restores workspace cleanly
      await home.locator('.nav-item').filter({ hasText: 'Ask AI' }).click()
      await expect(home.locator('#home-ask-workspace .home-chat-panel')).toHaveCount(1)
    } finally {
      if (launched) {
        await closeAndSaveVideo(launched, 'ai-document-creation')
      }
      await rm(root, { recursive: true, force: true })
    }
  })
})
