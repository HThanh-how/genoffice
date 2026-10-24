import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { FolderPauseRegistry } from '../src/main/document-memory/folder-pause'
import { nextInOrder } from '../src/main/document-memory/queue-order'

describe('folder pause intent', () => {
  it('holds nested queued paths without treating a similarly named sibling as paused', () => {
    const pauses = new FolderPauseRegistry()
    const root = resolve('seed/work')
    const held = resolve('seed/work/sub/document.pdf')
    const other = resolve('seed/workshop/document.pdf')
    pauses.replace([root])
    expect(pauses.paused(held)).toBe(true)
    expect(pauses.paused(other)).toBe(false)
    const queue = [held, other]
    const info = {
      urgent: new Set<string>(),
      deferred: new Set<string>(),
      bytes: new Map<string, number>(),
    }
    expect(nextInOrder(queue, info, (path) => pauses.paused(path))).toBe(other)
    expect(nextInOrder([held], info, (path) => pauses.paused(path))).toBeUndefined()
    expect(queue).toEqual([held, other])
    pauses.replace([])
    expect(nextInOrder(queue, info, (path) => pauses.paused(path))).toBe(held)
  })
  it('invalidates cached decisions and wakes subscribers only when user intent changes', () => {
    const pauses = new FolderPauseRegistry()
    let calls = 0
    const stop = pauses.subscribe(() => calls++)
    const file = resolve('seed/work/file.md')
    expect(pauses.paused(file)).toBe(false)
    pauses.replace([resolve('seed/work')])
    expect(pauses.paused(file)).toBe(true)
    pauses.replace([resolve('seed/work')])
    expect(calls).toBe(1)
    pauses.replace([])
    expect(pauses.paused(file)).toBe(false)
    expect(calls).toBe(2)
    stop()
    pauses.replace([resolve('seed/work')])
    expect(calls).toBe(2)
  })
})
