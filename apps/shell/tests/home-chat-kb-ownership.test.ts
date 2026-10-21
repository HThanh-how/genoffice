// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { KnowledgeBaseDeps } from '@genoffice/agent-core'
import { HomeChat } from '../src/renderer/src/HomeChat'
import { requestChatPrefill } from '../src/renderer/src/chat-events'
import { FileRefTable } from '../src/renderer/src/home-chat/file-refs'
import type { HomeApi } from '../src/shared/home-api'
import type { I18n } from '../src/renderer/src/locale'

const captured = vi.hoisted(() => ({ kb: null as KnowledgeBaseDeps | null, runs: 0 }))
vi.mock('@genoffice/agent-core', async (original) => {
  const actual = await original<typeof import('@genoffice/agent-core')>()
  return {
    ...actual,
    createKnowledgeBaseSkill: (deps: KnowledgeBaseDeps) => {
      captured.kb = deps
      return actual.createKnowledgeBaseSkill(deps)
    },
    AgentLoop: class {
      reset() {}
      restore() {}
      run() {
        captured.runs++
        return new Promise(() => {})
      }
    },
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  captured.runs = 0
})

it.each(['search', 'read'] as const)(
  'does not publish a delayed KB %s from A into a new live conversation B',
  async (operation) => {
    let complete!: (value: any) => void
    const api = {
      getAiSettings: async () => ({ provider: 'openai', providers: {} }),
      homeChatList: async () => [],
      homeChatSave: async () => null,
      getSettings: async () => ({}),
      kbList: async () => [],
      kbSearch: () =>
        new Promise((resolve) => {
          complete = resolve
        }),
      kbRead: () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    } as unknown as HomeApi
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const additions = vi.spyOn(FileRefTable.prototype, 'addFile')
    try {
      await act(async () =>
        root.render(
          createElement(HomeChat, {
            api,
            i18n: { lang: 'en', t: (key: string) => key } as I18n,
          }),
        ),
      )
      await act(async () => {
        requestChatPrefill({ text: 'Draft A', intent: 'new', send: true })
      })
      expect(captured.runs).toBe(1)
      const pending =
        operation === 'search' ? captured.kb!.search('A', 8) : captured.kb!.read('/old.docx', 0)
      await act(async () => {
        requestChatPrefill({ text: 'Draft B', intent: 'new', send: true })
      })
      expect(captured.runs).toBe(2)
      additions.mockClear()
      await act(async () => {
        complete(
          operation === 'search'
            ? [{ path: '/old.docx', name: 'old.docx', folder: 'Old', ext: 'docx', snippet: 'A' }]
            : { text: 'A', offset: 0, totalChars: 1 },
        )
        await pending
      })
      // Under PR #24, Draft A continues in the background with its own isolated fileTable.
      // Its citations are added to Draft A's table and NEVER leak into Draft B's table.
      const tableA = additions.mock.instances[0] as FileRefTable | undefined
      expect(tableA).toBeDefined()
      expect(tableA?.list().some((f) => f.path === '/old.docx')).toBe(true)

      // A subsequent operation in Draft B publishes citations strictly to Draft B's table.
      const current =
        operation === 'search' ? captured.kb!.search('B', 8) : captured.kb!.read('/new.docx', 0)
      await act(async () => {
        complete(
          operation === 'search'
            ? [{ path: '/new.docx', name: 'new.docx', folder: 'New', ext: 'docx', snippet: 'B' }]
            : { text: 'B', offset: 0, totalChars: 1 },
        )
        await current
      })
      const tableB = additions.mock.instances.at(-1) as FileRefTable | undefined
      expect(tableB).toBeDefined()
      expect(tableB).not.toBe(tableA)
      expect(tableB?.list().some((f) => f.path === '/old.docx')).toBe(false)
      expect(tableB?.list().some((f) => f.path === '/new.docx')).toBe(true)
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  },
)
