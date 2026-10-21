// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, createElement } from 'react'
import { Home } from '../src/renderer/src/Home'
import type { HomeApi } from '../src/shared/home-api'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function createMockHomeApi() {
  return {
    homeChatList: vi.fn().mockResolvedValue([]),
    homeChatGet: vi.fn().mockResolvedValue(null),
    homeChatSave: vi.fn().mockResolvedValue(null),
    homeChatDelete: vi.fn().mockResolvedValue(true),
    homeChatClear: vi.fn().mockResolvedValue(1),
    homeChatRename: vi.fn().mockResolvedValue(null),
    getAiSettings: vi.fn().mockResolvedValue({
      provider: 'openai',
      providers: { openai: { apiKey: 'key', model: 'model', baseUrl: 'http://localhost' } },
    }),
    onAiSettingsChanged: vi.fn().mockReturnValue(() => {}),
    setAiSettings: vi.fn().mockResolvedValue(true),
    aiStream: vi.fn().mockResolvedValue(undefined),
    aiStreamCancel: vi.fn().mockResolvedValue(undefined),
    onAiStream: vi.fn().mockReturnValue(() => {}),
    getDocumentMemoryStatus: vi.fn().mockResolvedValue({ chunks: 10, files: 2 }),
    onDocumentMemoryStatusChanged: vi.fn().mockReturnValue(() => {}),
    recents: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    starred: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    starredGroups: vi.fn().mockResolvedValue([]),
    onFolderChanged: vi.fn().mockReturnValue(() => {}),
    folderRoots: vi.fn().mockResolvedValue([]),
    listFolder: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    searchIndexedFiles: vi.fn().mockResolvedValue([]),
    statPaths: vi.fn().mockResolvedValue([]),
    openPath: vi.fn().mockResolvedValue(true),
    testIgnorePath: vi.fn().mockResolvedValue({ ignored: false }),
    readScannedPdfWithAgy: vi.fn().mockResolvedValue({ ok: true, pages: 1 }),
    retryDocumentIndex: vi.fn().mockResolvedValue({ ok: true }),
    pathForFile: vi.fn().mockReturnValue(''),
  } as unknown as HomeApi
}

describe('Home UI Restoration Regression Suite (H01 - H10)', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const originalAiOffice = window.aiOffice
  const originalAiOfficeTabs = window.aiOfficeTabs

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const mockApi = createMockHomeApi()
    window.aiOffice = mockApi
    window.aiOfficeTabs = {
      list: vi.fn().mockResolvedValue([{ kind: 'home', active: true }]),
      onChanged: vi.fn().mockReturnValue(() => {}),
    } as any
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    window.aiOffice = originalAiOffice
    window.aiOfficeTabs = originalAiOfficeTabs
  })

  it('H01 & H02 & H03 & H04: Cold startup renders inline composer under hero, quick cards visible, no floating launcher', async () => {
    await act(async () => {
      root.render(createElement(Home))
    })

    // H03: Hero greeting and quick-start cards are visible
    expect(host.querySelector('.home-hero')).not.toBeNull()
    expect(host.querySelector('.quick-cards')).not.toBeNull()

    // H04: Floating bottom-right launcher is absent
    expect(host.querySelector('.home-chat-launcher')).toBeNull()

    // H01: Inline ask dock is rendered inside #home-assistant-slot
    const slot = host.querySelector('#home-assistant-slot')
    expect(slot).not.toBeNull()
    const inlineDock = slot?.querySelector('.ask-dock.is-inline')
    expect(inlineDock).not.toBeNull()

    // H02: Input is enabled and accepts text
    const input = inlineDock?.querySelector<HTMLInputElement>('input')
    expect(input).not.toBeNull()
    expect(input?.disabled).toBe(false)
  })

  it('H05 & H06: Sidebar Ask AI toggles full workspace and returning restores inline dock', async () => {
    await act(async () => {
      root.render(createElement(Home))
    })

    // Click Ask AI in sidebar
    const askAiNav = Array.from(host.querySelectorAll('.sidebar button, .nav-item')).find(
      (btn) => btn.textContent?.includes('Ask AI') || btn.getAttribute('aria-label')?.includes('Ask AI'),
    ) as HTMLButtonElement | undefined

    expect(askAiNav).toBeDefined()

    await act(async () => {
      askAiNav?.click()
    })

    // H05: #home-ask-workspace is present and panel is mounted there
    expect(host.querySelector('#home-ask-workspace')).not.toBeNull()
    expect(host.querySelector('.home-chat-panel.is-workspace')).not.toBeNull()

    // Return to Recents / Home view
    const recentNav = host.querySelector<HTMLButtonElement>('.nav-item')!
    await act(async () => {
      recentNav.click()
      await new Promise((r) => setTimeout(r, 50))
    })

    // H06: Inline dock is restored in #home-assistant-slot
    const slotAfter = host.querySelector('#home-assistant-slot')
    expect(slotAfter).not.toBeNull()
    expect(slotAfter?.querySelector('.ask-dock.is-inline')).not.toBeNull()
  })
})
