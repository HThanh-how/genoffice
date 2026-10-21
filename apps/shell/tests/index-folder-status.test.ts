import { describe, expect, it } from 'vitest'
import { folderChips, folderDone } from '../src/renderer/src/fork/index-folder-status'

const folder = (over: Record<string, unknown> = {}) =>
  ({
    unavailable: false,
    state: 'complete',
    pendingFiles: 0,
    errorFiles: 0,
    readyFiles: 0,
    totalFiles: 0,
    ...over,
  }) as never

describe('folder row status', () => {
  it('says ready when nothing is waiting and nothing failed', () => {
    expect(folderChips(folder())).toEqual(['ready'])
  })
  it('says indexing while files wait, and adds a problems chip next to it', () => {
    expect(folderChips(folder({ pendingFiles: 4 }))).toEqual(['indexing'])
    expect(folderChips(folder({ pendingFiles: 4, errorFiles: 2 }))).toEqual(['indexing', 'errors'])
    expect(folderChips(folder({ errorFiles: 2 }))).toEqual(['errors'])
  })
  it('an unreachable folder shows only that', () => {
    expect(folderChips(folder({ unavailable: true, pendingFiles: 4, errorFiles: 1 }))).toEqual([
      'offline',
    ])
  })
  it('a running scan comes first', () => {
    expect(folderChips(folder({ state: 'running', pendingFiles: 3 }))).toEqual(['scanning'])
    expect(folderChips(folder({ state: 'stopped' }))).toEqual(['stopped'])
  })
  it('counts handled files out of the total without exceeding it', () => {
    expect(
      folderDone(folder({ readyFiles: 90, errorFiles: 5, releasedFiles: 3, totalFiles: 100 })),
    ).toEqual({ done: 98, total: 100 })
    expect(folderDone(folder({ readyFiles: 90, errorFiles: 20, totalFiles: 100 }))).toEqual({
      done: 100,
      total: 100,
    })
  })
})
