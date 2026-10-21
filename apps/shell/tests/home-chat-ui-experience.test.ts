// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { deduplicateSources } from '../src/renderer/src/home-chat/ChatMessage'
import type { HomeChatSource } from '../src/shared/fork/home-chat-types'
import { isNearBottom } from '../src/renderer/src/home-chat/utils'

describe('home-chat UI experience & search presentation (Phase 3)', () => {
  it('deduplicates multiple citations of the exact same documentId into one card', () => {
    const rawSources: HomeChatSource[] = [
      { documentId: 101, name: 'report.docx', path: '/docs/report.docx' },
      { documentId: 101, name: 'report.docx', path: '/docs/report.docx' },
      { documentId: 102, name: 'summary.xlsx', path: '/docs/summary.xlsx' },
    ]

    const deduped = deduplicateSources(rawSources)
    expect(deduped).toHaveLength(2)
    expect(deduped[0]!.documentId).toBe(101)
    expect(deduped[1]!.documentId).toBe(102)
  })

  it('deduplicates multiple citations of the exact same path into one card', () => {
    const rawSources: HomeChatSource[] = [
      { documentId: 0, name: 'readme.md', path: '/workspace/README.md' },
      { documentId: 0, name: 'readme.md', path: '/workspace/README.md' },
    ]

    const deduped = deduplicateSources(rawSources)
    expect(deduped).toHaveLength(1)
  })

  it('preserves distinct case-sensitive file paths as separate cards', () => {
    const rawSources: HomeChatSource[] = [
      { documentId: 0, name: 'README.md', path: '/workspace/README.md' },
      { documentId: 0, name: 'readme.md', path: '/workspace/readme.md' },
    ]

    const deduped = deduplicateSources(rawSources)
    expect(deduped).toHaveLength(2)
  })

  it('preserves distinct files even when they share the exact same basename', () => {
    const rawSources: HomeChatSource[] = [
      { documentId: 201, name: 'notes.txt', path: '/project-a/notes.txt' },
      { documentId: 202, name: 'notes.txt', path: '/project-b/notes.txt' },
    ]

    const deduped = deduplicateSources(rawSources)
    expect(deduped).toHaveLength(2)
    expect(deduped[0]!.documentId).toBe(201)
    expect(deduped[1]!.documentId).toBe(202)
    expect(deduped[0]!.path).not.toBe(deduped[1]!.path)
  })

  it('preserves missing and stale flags on sources', () => {
    const sources: HomeChatSource[] = [
      { documentId: 301, name: 'missing.docx', path: '/docs/missing.docx', missing: true },
      { documentId: 302, name: 'stale.xlsx', path: '/docs/stale.xlsx', stale: true },
      { documentId: 303, name: 'normal.pptx', path: '/docs/normal.pptx' },
    ]

    const deduped = deduplicateSources(sources)
    expect(deduped[0]!.missing).toBe(true)
    expect(deduped[1]!.stale).toBe(true)
    expect(deduped[2]!.missing).toBeFalsy()
  })

  it('isNearBottom correctly discriminates reading position vs bottom follow', () => {
    // Scrolled to bottom: scrollTop + clientHeight == scrollHeight
    const atBottom = { scrollTop: 600, clientHeight: 400, scrollHeight: 1000 } as HTMLElement
    expect(isNearBottom(atBottom)).toBe(true)

    // Scrolled up to read older messages: distance from bottom > 64px
    const scrolledUp = { scrollTop: 200, clientHeight: 400, scrollHeight: 1000 } as HTMLElement
    expect(isNearBottom(scrolledUp)).toBe(false)
  })
})
