import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectStore } from '../src/store.js'
import {
  HANDOFF_MAX_CHARS,
  buildChatHandoff,
  handoffTitle,
  isHandoffTarget,
  seedDocChatHandoff,
  shouldSeedHandoff,
  splitHandoff,
  type HandoffTurn,
} from '../src/handoff.js'
import type { ProjectApi } from '../src/ipc.js'

const user = (text: string): HandoffTurn => ({ role: 'user', text })
const ai = (text: string): HandoffTurn => ({ role: 'assistant', text })

describe('buildChatHandoff', () => {
  const path = 'C:\\Docs\\Giao an lop 6.docx'

  it('carries the original request, recent user turns and the file', () => {
    const out = buildChatHandoff({
      chatTitle: 'Giao an',
      turns: [user('Soạn giáo án lớp 6, 3 tiết'), ai('Đã soạn xong'), user('Dùng Times New Roman')],
      filePath: path,
      kind: 'created',
    })
    expect(out).toContain('"Giao an"')
    expect(out).toContain('Original request: Soạn giáo án lớp 6, 3 tiết')
    expect(out).toContain('- Dùng Times New Roman')
    expect(out).toContain('Document created in that chat: Giao an lop 6.docx')
    expect(out).toContain(path)
    expect(out).not.toContain('Đã soạn xong')
  })

  it('says "opened" for a document merely opened from the chat', () => {
    const out = buildChatHandoff({
      turns: [user('hi')],
      filePath: path,
      kind: 'opened',
    })
    expect(out).toContain('Document opened from that chat')
    expect(out).not.toContain('Later requests')
  })

  it('is deterministic and falls back to the first message as the title', () => {
    const input = { turns: [user('Viết thư xin việc')], filePath: path, kind: 'created' as const }
    expect(buildChatHandoff(input)).toBe(buildChatHandoff(input))
    expect(handoffTitle(input)).toBe('Viết thư xin việc')
  })

  it('keeps only the last 6 user turns and drops the oldest when over the cap', () => {
    const turns: HandoffTurn[] = []
    for (let i = 0; i < 20; i++) turns.push(user(`turn-${i} ${'x'.repeat(300)}`))
    const out = buildChatHandoff({ turns, filePath: path, kind: 'created' })
    expect(out.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS)
    expect(out).toContain('Original request: turn-0')
    expect(out).toContain('turn-19')
    expect(out).not.toContain('turn-10 ')
    expect(out).toContain('Giao an lop 6.docx')
  })

  it('stays under the cap with a pathological path and returns "" without user turns', () => {
    const long = `C:\\${'a'.repeat(2000)}\\f.docx`
    const out = buildChatHandoff({
      turns: [user('y'.repeat(2000))],
      filePath: long,
      kind: 'created',
    })
    expect(out.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS)
    expect(buildChatHandoff({ turns: [ai('hello')], filePath: path, kind: 'created' })).toBe('')
  })
})

describe('seeding rule', () => {
  it('seeds only an empty chat', () => {
    expect(shouldSeedHandoff([])).toBe(true)
    expect(shouldSeedHandoff([{ seq: 0 }])).toBe(false)
  })

  it('targets Word files only', () => {
    expect(isHandoffTarget('a/b.DOCX')).toBe(true)
    expect(isHandoffTarget('a/b.xlsx')).toBe(false)
    expect(isHandoffTarget('a/b.md')).toBe(false)
  })
})

describe('seedDocChatHandoff with a real store', () => {
  let dir: string
  let store: ProjectStore
  let api: Pick<ProjectApi, 'resolveChat' | 'loadChat' | 'appendChat'>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'handoff-test-'))
    store = new ProjectStore(dir)
    store.ensureDefaultProject()
    api = {
      resolveChat: async ({ filePath }) => store.resolveChatForFile(filePath!),
      loadChat: async ({ projectId, chatId, limit }) => store.loadChat(projectId, chatId, limit),
      appendChat: async ({ projectId, chatId, ...msg }) =>
        store.appendChatMessage(projectId, chatId, msg),
    }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const input = (filePath: string) => ({
    chatTitle: 'Lesson',
    turns: [user('Lop 6, 3 tiet'), user('Times New Roman')],
    filePath,
    kind: 'created' as const,
  })

  it('writes one tagged handoff into the document chat and never re-seeds', async () => {
    const file = join(dir, 'a.docx')
    expect(await seedDocChatHandoff(api, input(file))).toBe(true)
    expect(await seedDocChatHandoff(api, input(file))).toBe(false)
    const ids = store.resolveChatForFile(file)
    const msgs = store.loadChat(ids.projectId, ids.chatId)
    expect(msgs).toHaveLength(1)
    const split = splitHandoff(msgs)
    expect(split.handoff?.title).toBe('Lesson')
    expect(split.handoff?.text).toContain('Times New Roman')
    expect(split.rest).toHaveLength(0)
  })

  it('does not seed a chat that already has messages, nor an unrelated doc', async () => {
    const used = join(dir, 'used.docx')
    const ids = store.resolveChatForFile(used)
    store.appendChatMessage(ids.projectId, ids.chatId, { role: 'assistant', text: 'earlier' })
    expect(await seedDocChatHandoff(api, input(used))).toBe(false)
    expect(store.loadChat(ids.projectId, ids.chatId)).toHaveLength(1)

    const other = store.resolveChatForFile(join(dir, 'other.docx'))
    expect(store.loadChat(other.projectId, other.chatId)).toHaveLength(0)
    expect(await seedDocChatHandoff(api, input(join(dir, 'sheet.xlsx')))).toBe(false)
  })

  it('splitHandoff leaves an ordinary chat untouched', () => {
    const msgs = [{ text: 'a' }, { text: 'b' }]
    expect(splitHandoff(msgs)).toEqual({ handoff: null, rest: msgs })
  })
})
