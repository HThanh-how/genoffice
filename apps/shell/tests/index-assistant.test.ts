import { describe, expect, it, vi } from 'vitest'
import {
  extractIndexDirectives,
  langFor,
  mentionsIndex,
  parseIndexCommand,
  runIndexCommand,
} from '../src/renderer/src/fork/index-assistant'

describe('parseIndexCommand', () => {
  it.each([
    ['index tới đâu rồi?', { kind: 'status' }],
    ['Tiến độ chỉ mục thế nào', { kind: 'status' }],
    ['how far is indexing? progress', { kind: 'status' }],
    ['tạm dừng index', { kind: 'pause' }],
    ['pause indexing', { kind: 'pause' }],
    ['tiếp tục index', { kind: 'resume' }],
    ['quét lại', { kind: 'scan' }],
    ['quét lại thư mục Luật', { kind: 'scan', folder: 'luat' }],
    ['ưu tiên thư mục Hợp đồng', { kind: 'priority', folder: 'hop dong', on: true }],
    ['bỏ ưu tiên Luật', { kind: 'priority', folder: 'luat', on: false }],
    ['thử lại các lỗi', { kind: 'retry' }],
    ['chế độ nhẹ', { kind: 'mode', mode: 'light' }],
    ['chế độ nhanh', { kind: 'mode', mode: 'fast' }],
    ['dùng mô hình tìm kiếm chất lượng cao', { kind: 'model', profile: 'high' }],
    ['dừng quét', { kind: 'stop-scan' }],
    ['liệt kê 175 tệp gặp sự cố', { kind: 'problems' }],
    ['danh sách tệp lỗi', { kind: 'problems' }],
    ['list the files with errors', { kind: 'problems' }],
    ['help', { kind: 'help' }],
  ])('%s', (text, expected) => {
    const got = parseIndexCommand(text)
    expect(got).toMatchObject(expected as object)
  })

  it('leaves unrelated questions alone', () => {
    expect(parseIndexCommand('tìm hợp đồng thuê nhà')).toBeNull()
    expect(parseIndexCommand('')).toBeNull()
  })
})

describe('mentionsIndex', () => {
  it('only claims sentences about the index', () => {
    expect(mentionsIndex('index tới đâu rồi?')).toBe(true)
    expect(mentionsIndex('tiến độ chỉ mục')).toBe(true)
    expect(mentionsIndex('tìm file hợp đồng, xong chưa')).toBe(false)
  })
})

describe('runIndexCommand', () => {
  const folders = [
    { root: '/home/u/Luat', unavailable: false },
    { root: '/home/u/Hop dong', unavailable: false },
  ]
  const api = () => ({
    listIndexedFolders: vi.fn(async () => folders),
    setIndexedFolderPriority: vi.fn(async () => true),
    rescanIndexedFolder: vi.fn(async () => ({ ok: true })),
    setDocumentMemoryEnabled: vi.fn(async () => ({})),
  })

  it('prioritises the folder whose name matches, ignoring accents', async () => {
    const a = api()
    const text = await runIndexCommand(
      a as never,
      { kind: 'priority', folder: 'hop dong', on: true },
      'vi',
    )
    expect(a.setIndexedFolderPriority).toHaveBeenCalledWith('/home/u/Hop dong', true)
    expect(text).toMatch(/Hop dong/)
  })

  it('lists the folders when the name matches nothing', async () => {
    const a = api()
    const text = await runIndexCommand(
      a as never,
      { kind: 'priority', folder: 'xyz', on: true },
      'en',
    )
    expect(a.setIndexedFolderPriority).not.toHaveBeenCalled()
    expect(text).toMatch(/Luat, Hop dong/)
  })

  it('pauses and resumes', async () => {
    const a = api()
    await runIndexCommand(a as never, { kind: 'pause' }, 'vi')
    await runIndexCommand(a as never, { kind: 'resume' }, 'vi')
    expect(a.setDocumentMemoryEnabled.mock.calls).toEqual([[false], [true]])
  })

  it('reports a failure instead of throwing', async () => {
    const text = await runIndexCommand(
      { listIndexedFolders: async () => Promise.reject(new Error('boom')) } as never,
      { kind: 'scan' },
      'en',
    )
    expect(text).toMatch(/boom/)
  })
})

describe('langFor', () => {
  it('answers Vietnamese sentences in Vietnamese whatever the UI language', () => {
    expect(langFor('index tới đâu rồi?', 'en')).toBe('vi')
    expect(langFor('how far is it', 'en')).toBe('en')
  })
})

describe('extractIndexDirectives', () => {
  it('lifts safe commands out of a model reply and drops the lines', () => {
    const out = extractIndexDirectives(
      'Đã tạm dừng.\n[[index:pause]]\n[[index:priority:Luat]]\n[[index:mode:fast]]\n[[index:model:high]]',
    )
    expect(out.text).toBe('Đã tạm dừng.')
    expect(out.commands).toEqual([
      { kind: 'pause' },
      { kind: 'priority', folder: 'Luat', on: true },
      { kind: 'mode', mode: 'fast' },
    ])
  })

  it('never lets a reply switch the search model or clear data', () => {
    const out = extractIndexDirectives('[[index:model:high]] [[index:clear]]')
    expect(out.commands).toEqual([])
  })
})
