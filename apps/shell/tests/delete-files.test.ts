import { describe, expect, it, vi } from 'vitest'
import { trashUserFiles } from '../src/main/delete-files'

describe('trashUserFiles', () => {
  it('reports successful and failed paths and only cleans up files actually trashed', async () => {
    const trash = vi.fn(async (path: string) => {
      if (path.endsWith('denied.docx')) throw new Error('trash unavailable')
    })
    const afterTrashed = vi.fn()

    const result = await trashUserFiles(
      ['/root/ok.docx', '/root/denied.docx', '/outside/secret.docx', '/root/missing.docx'],
      {
        isAllowed: (path) => path.startsWith('/root/'),
        isFile: (path) => !path.endsWith('missing.docx'),
        trash,
        afterTrashed,
      },
    )

    expect(result).toEqual({ trashed: 1, failed: 3 })
    expect(trash).toHaveBeenCalledTimes(2)
    expect(afterTrashed).toHaveBeenCalledWith(['/root/ok.docx'])
  })

  it('attempts each unique path once', async () => {
    const trash = vi.fn(async () => {})
    const afterTrashed = vi.fn()

    const result = await trashUserFiles(['/root/a.docx', '/root/a.docx'], {
      isAllowed: () => true,
      isFile: () => true,
      trash,
      afterTrashed,
    })

    expect(result).toEqual({ trashed: 1, failed: 0 })
    expect(trash).toHaveBeenCalledTimes(1)
  })
})
