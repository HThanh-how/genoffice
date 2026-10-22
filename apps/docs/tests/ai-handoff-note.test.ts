// A document chat seeded with a Home-chat handoff shows one quiet, dismissible note.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { AiPanel } from '../src/renderer/ai/AiPanel'
import { t } from '../src/renderer/i18n/locale'
import { AI_PROVIDERS, type AiSettings } from '../src/shared/ipc'

const settings: AiSettings = {
  provider: 'anthropic',
  providers: Object.fromEntries(
    AI_PROVIDERS.map((p) => [p.id, { apiKey: '', model: p.defaultModel }]),
  ) as AiSettings['providers'],
}

function createEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          attrs: { docxIndex: 0 },
          content: [{ type: 'text', text: 'EVs market research' }],
        },
      ],
    },
  })
}

function mount(element: React.ReactElement): {
  container: HTMLElement
  cleanup: () => void
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => root.render(element))
  return {
    container,
    cleanup: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

function panelProps(editor: Editor) {
  return {
    editor,
    blocks: [],
    settings,
    open: true,
  }
}

const HANDOFF_TEXT = 'Context carried over from the Home chat "Lesson". Original request: lop 6'

function mockProjectApi(chatId: string) {
  const win = window as unknown as { projectApi?: unknown }
  const previous = win.projectApi
  win.projectApi = {
    resolveChat: vi.fn(async () => ({ projectId: 'p', chatId })),
    loadChat: vi.fn(async () => [
      { seq: 0, ts: '', role: 'assistant', text: HANDOFF_TEXT, handoff: { title: 'Lesson' } },
    ]),
  }
  return () => {
    win.projectApi = previous
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeAll(() => {
  Element.prototype.scrollTo ??= () => {}
})

describe('AiPanel handoff note', () => {
  it('shows the note, expands to the carried text, and dismisses for good', async () => {
    const restoreApi = mockProjectApi('handoff-chat-1')
    try {
      const editor = createEditor()
      const { container, cleanup } = mount(createElement(AiPanel, panelProps(editor)))
      try {
        await flush()
        await flush()
        expect(container.querySelector('.ai-handoff-label')?.textContent).toBe(
          t('aiHandoffNote', { title: 'Lesson' }),
        )
        // the handoff is context, not a chat message
        expect(container.querySelectorAll('.ai-msg-historic').length).toBe(0)
        expect(container.querySelector('.ai-handoff-body')).toBeNull()
        act(() => container.querySelector<HTMLButtonElement>('.ai-handoff-toggle')!.click())
        expect(container.querySelector('.ai-handoff-body')?.textContent).toBe(HANDOFF_TEXT)

        act(() => container.querySelector<HTMLButtonElement>('.ai-handoff-dismiss')!.click())
        expect(container.querySelector('.ai-handoff')).toBeNull()
      } finally {
        cleanup()
      }

      // reopening the same document chat does not bring it back
      const again = mount(createElement(AiPanel, panelProps(editor)))
      try {
        await flush()
        await flush()
        expect(again.container.querySelector('.ai-handoff')).toBeNull()
      } finally {
        again.cleanup()
        editor.destroy()
      }
    } finally {
      restoreApi()
    }
  })
})
