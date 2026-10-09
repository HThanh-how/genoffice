// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMessage, type ChatLabels } from '../src/renderer/src/home-chat/ChatMessage'
import { chatString } from '../src/renderer/src/home-chat/strings'
import type { HomeChatSource } from '../src/shared/fork/home-chat-types'

let container: HTMLDivElement
let root: Root

const labels = (lang: 'vi' | 'en'): ChatLabels => ({
  loading: '…', retry: 'retry', sources: 'sources', openSource: (name) => `open ${name}`,
  sourceMissing: chatString(lang, 'homeChatSourceMissing'), sourceStale: chatString(lang, 'homeChatSourceStale'),
  sourceMissingHint: chatString(lang, 'homeChatSourceMissingHint'), sourceStaleHint: chatString(lang, 'homeChatSourceStaleHint'),
  sourceSkeleton: chatString(lang, 'homeChatSourceSkeleton'), sourceSkeletonHint: chatString(lang, 'homeChatSourceSkeletonHint'),
  copy: 'copy', copied: 'copied',
})

async function show(sources: HomeChatSource[], lang: 'vi' | 'en' = 'vi', onOpenSource = vi.fn()) {
  await act(async () =>
    root.render(createElement(ChatMessage, { item: { id: 1, role: 'assistant', text: 'ok', sources }, canRetry: false, labels: labels(lang), onOpenSource, onRetry: () => {} })),
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
    const source: HomeChatSource = { documentId: 7, name: 'giao-an.docx', location: 'Trang 1', skeletonIndex: true }
    const open = await show([source])
    const chip = container.querySelector<HTMLButtonElement>('.hc-source')!
    expect(chip.querySelector('.hc-source-flag')?.textContent).toBe('Chỉ giữ khung')
    expect(chip.title).toContain('Chỉ giữ phần khung — mở để đọc đầy đủ')
    expect(chip.disabled).toBe(false)
    await act(async () => chip.click())
    expect(open).toHaveBeenCalledWith(source) // opening goes through the normal open / read-now path
  })

  it('shows no badge for ordinary sources, and stale/missing keep precedence', async () => {
    await show([
      { documentId: 1, name: 'a.docx', location: 'p1' },
      { documentId: 2, name: 'b.docx', location: 'p1', stale: true, skeletonIndex: true },
    ])
    const chips = [...container.querySelectorAll('.hc-source')]
    expect(chips[0]!.querySelector('.hc-source-flag')).toBeNull()
    expect(chips[1]!.querySelector('.hc-source-flag')?.textContent).toBe('Đã đổi')
  })

  it('has English text too', async () => {
    await show([{ documentId: 3, name: 'plan.docx', location: 'p1', skeletonIndex: true }], 'en')
    expect(container.querySelector('.hc-source-flag')?.textContent).toBe('Outline only')
  })
})
