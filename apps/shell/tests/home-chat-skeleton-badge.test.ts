// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMessage } from '../src/renderer/src/home-chat/ChatMessage'
import { chatLabels } from './helpers/chat-labels'
import type { HomeChatSource } from '../src/shared/fork/home-chat-types'

let container: HTMLDivElement
let root: Root

async function show(sources: HomeChatSource[], lang: 'vi' | 'en' = 'vi', onOpenSource = vi.fn()) {
  await act(async () =>
    root.render(
      createElement(ChatMessage, {
        item: { id: 1, role: 'assistant', text: 'ok', sources },
        canRetry: false,
        labels: chatLabels(lang),
        onOpenSource,
        onRevealSource: vi.fn(),
        onRetry: () => {},
      }),
    ),
  )
  return onOpenSource
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('skeleton badge on a source chip', () => {
  it('shows a small badge and the Vietnamese tooltip, and the chip still opens the document', async () => {
    const source: HomeChatSource = {
      documentId: 7,
      name: 'giao-an.docx',
      location: 'Trang 1',
      skeletonIndex: true,
    }
    const open = await show([source])
    const card = container.querySelector<HTMLElement>('.hc-card')!
    expect(card.querySelector('.hc-source-flag')?.textContent).toBe('Chỉ giữ khung')
    expect(card.title).toContain('Chỉ giữ phần khung — mở để đọc đầy đủ')
    const button = card.querySelector<HTMLButtonElement>('.hc-card-open')!
    expect(button.disabled).toBe(false)
    await act(async () => button.click())
    expect(open).toHaveBeenCalledWith(source) // opening goes through the normal open / read-now path
  })

  it('shows no badge for ordinary sources, and stale/missing keep precedence', async () => {
    await show([
      { documentId: 1, name: 'a.docx', location: 'p1' },
      { documentId: 2, name: 'b.docx', location: 'p1', stale: true, skeletonIndex: true },
    ])
    const chips = [...container.querySelectorAll('.hc-card')]
    expect(chips[0]!.querySelector('.hc-source-flag')).toBeNull()
    expect(chips[1]!.querySelector('.hc-source-flag')?.textContent).toBe('Đã đổi')
  })

  it('has English text too', async () => {
    await show([{ documentId: 3, name: 'plan.docx', location: 'p1', skeletonIndex: true }], 'en')
    expect(container.querySelector('.hc-source-flag')?.textContent).toBe('Outline only')
  })
})
