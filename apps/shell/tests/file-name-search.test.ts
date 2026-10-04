import { describe, expect, it, vi } from 'vitest'
import { findFilesByName } from '../src/renderer/src/fork/file-name-search'
import { sanitizeChatMessages } from '../src/main/fork/home-chat-store'

const entry = (name: string) => ({
  path: `C:\\docs\\${name}`,
  name,
  ext: 'docx',
  mtimeMs: 1,
  sizeBytes: 1,
  starred: false,
})

describe('findFilesByName', () => {
  it('finds a recent file by its name, accents and spacing ignored, plus folder-index hits once', async () => {
    const api = {
      recents: vi.fn(async () => ({
        entries: [entry('Mỹ Lệ.docx'), entry('Báo cáo.docx'), entry('MyLe-2.docx')],
        total: 3,
        totalAll: 3,
      })),
      searchFiles: vi.fn(async () => ({
        hits: [entry('Mỹ Lệ.docx'), entry('Ghi chú Mỹ Lệ.docx')],
        total: 2,
        index: { indexed: 0, pending: 0, scanning: false },
      })),
    }
    const found = await findFilesByName(api as never, 'mỹ lệ')
    expect(found.map((f) => f.name)).toEqual(['Mỹ Lệ.docx', 'MyLe-2.docx', 'Ghi chú Mỹ Lệ.docx'])
  })

  it('ranks exact basenames and prefixes ahead of weaker recent matches', async () => {
    const api = {
      recents: vi.fn(async () => ({
        entries: [
          entry('Lịch Mỹ Lệ.docx'),
          entry('Bản cũ Mỹ Lệ.docx'),
          entry('Mỹ Lệ - phụ lục.docx'),
        ],
        total: 3,
        totalAll: 3,
      })),
      searchFiles: vi.fn(async () => ({
        hits: [entry('Mỹ Lệ.xlsx'), entry('Mỹ Lệ.docx')],
        total: 2,
        index: { indexed: 0, pending: 0, scanning: false },
      })),
    }

    const found = await findFilesByName(api as never, 'mỹ lệ', 3)

    expect(found.map((file) => file.name)).toEqual([
      'Mỹ Lệ.xlsx',
      'Mỹ Lệ.docx',
      'Mỹ Lệ - phụ lục.docx',
    ])
  })

  it('matches name words across parent folders and puts a near-typo behind exact paths', async () => {
    const located = (path: string, name: string) => ({ ...entry(name), path })
    const api = {
      recents: vi.fn(async () => ({
        entries: [
          located('D:\\giay ra vien Pham Huu Cong.pdf', 'giay ra vien Pham Huu Cong.pdf'),
          located('D:\\pham huu cong\\giay ra vien.pdf', 'giay ra vien.pdf'),
          located('D:\\giay ra vien\\pham huux công.pdf', 'pham huux công.pdf'),
          ...Array.from({ length: 8 }, (_, i) =>
            located(`D:\\old-${i}\\pham huu\\giay ra vien.pdf`, 'giay ra vien.pdf'),
          ),
        ],
        total: 11,
        totalAll: 11,
      })),
      searchFiles: vi.fn(async () => ({
        hits: [],
        total: 0,
        index: { indexed: 0, pending: 0, scanning: false },
      })),
    }

    const found = await findFilesByName(api as never, 'giấy ra viện Phạm Hữu Công', 6)

    expect(found.map((file) => file.path)).toEqual([
      'D:\\giay ra vien Pham Huu Cong.pdf',
      'D:\\pham huu cong\\giay ra vien.pdf',
      'D:\\giay ra vien\\pham huux công.pdf',
      'D:\\old-0\\pham huu\\giay ra vien.pdf',
      'D:\\old-1\\pham huu\\giay ra vien.pdf',
      'D:\\old-2\\pham huu\\giay ra vien.pdf',
    ])
  })

  it('does nothing for a question made of filler words', async () => {
    const api = { recents: vi.fn(), searchFiles: vi.fn() }
    expect(await findFilesByName(api as never, 'có cái nào không?')).toEqual([])
    expect(api.recents).not.toHaveBeenCalled()
  })
})

describe('chat sources found by name', () => {
  it('keep their path and survive saving', () => {
    const [message] = sanitizeChatMessages([
      {
        role: 'assistant',
        text: 'x',
        sources: [
          { documentId: 0, path: 'C:\\a\\Mỹ Lệ.docx', name: 'Mỹ Lệ.docx', location: 'C:\\a' },
          { documentId: 0, name: 'no path', location: '' },
          { documentId: 5, name: 'in index', location: 'p1' },
        ],
      },
    ])
    expect(message?.sources?.map((s) => [s.documentId, s.path ?? null])).toEqual([
      [0, 'C:\\a\\Mỹ Lệ.docx'],
      [5, null],
    ])
  })
})

describe('nameWords', () => {
  it('keeps name words that look like English filler once the accents are gone', async () => {
    const { nameWords } = await import('../src/main/document-memory/normalization')
    expect(nameWords('mỹ lệ')).toEqual(['my', 'le'])
    expect(nameWords('mẹ tôi')).toEqual(['me'])
    expect(nameWords('có cái nào là giấy ra viện không?')).toEqual(['giay', 'ra', 'vien', 'xuat'])
    expect(nameWords('tìm tài liệu về Lê Hữu Tài')).toEqual(['le', 'huu', 'tai'])
    expect(nameWords('co cai nao khong')).toEqual([])
  })
})
