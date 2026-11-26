import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { AiStreamChunk } from '@genoffice/ai-provider'

vi.mock('@genoffice/electron-utils/local-chat', () => ({ followLocalModel: () => undefined }))
const { followLocalNotice, stopLocalNotice } = await import('../src/main/local-notice')

type Line = { text: string; end?: 'ready' | 'failed' }
/** a manager that reports `first` at once, like LocalModelManager.watch */
function manager(first: Line) {
  let listener: ((line: Line) => void) | undefined
  const stop = vi.fn(() => {
    listener = undefined
  })
  return {
    stop,
    tell: (line: Line) => listener?.(line),
    follow: (l: (line: Line) => void) => {
      listener = l
      l(first)
      return stop
    },
  }
}
const setup = (id: string, first: Line) => {
  const sender = new EventEmitter()
  const sent: AiStreamChunk[] = []
  const model = manager(first)
  followLocalNotice(sender, id, (chunk) => sent.push(chunk), model.follow)
  const kinds = () =>
    sent.map((c) => `${c.type}${c.text ? `:${c.text}` : ''}${c.error ? `:${c.error}` : ''}`)
  return { sender, model, kinds }
}

describe('followLocalNotice', () => {
  it('updates the one line in place until the model is ready, then lets go of the window', () => {
    const { sender, model, kinds } = setup('a', { text: '80%' })
    expect(sender.listenerCount('destroyed')).toBe(1)
    model.tell({ text: '90%' })
    model.tell({ text: 'ready', end: 'ready' })
    expect(kinds()).toEqual(['status:80%', 'status:90%', 'status:ready', 'done'])
    expect(sender.listenerCount('destroyed')).toBe(0)
    expect(stopLocalNotice('a')).toBe(false)
  })

  it('turns into the original error when preparing the model fails', () => {
    const { sender, model, kinds } = setup('b', { text: '80%' })
    model.tell({ text: 'Local model failed SHA-256 verification', end: 'failed' })
    expect(kinds()).toEqual(['status:80%', 'error:Local model failed SHA-256 verification'])
    expect(sender.listenerCount('destroyed')).toBe(0)
  })

  it('keeps nothing when the model was ready before following began', () => {
    const { sender, kinds } = setup('c', { text: 'ready', end: 'ready' })
    expect(kinds()).toEqual(['status:ready', 'done'])
    expect(sender.listenerCount('destroyed')).toBe(0)
    expect(stopLocalNotice('c')).toBe(false)
  })

  it('a cancel stops only the followed line, and says it was one', () => {
    const { sender, model } = setup('d', { text: '80%' })
    expect(stopLocalNotice('d')).toBe(true)
    expect(model.stop).toHaveBeenCalledOnce()
    expect(sender.listenerCount('destroyed')).toBe(0)
    // a request that is not a followed line goes through the normal cancel (and its web search)
    expect(stopLocalNotice('d')).toBe(false)
    expect(stopLocalNotice('never-followed')).toBe(false)
  })

  it('stops when the window goes away', () => {
    const { sender, model } = setup('e', { text: '80%' })
    sender.emit('destroyed')
    expect(model.stop).toHaveBeenCalledOnce()
    expect(stopLocalNotice('e')).toBe(false)
  })

  it('asking many times leaves no listener behind', () => {
    const sender = new EventEmitter()
    for (let i = 0; i < 20; i++) {
      const model = manager({ text: `${i}%` })
      followLocalNotice(sender, `r${i}`, () => {}, model.follow)
      expect(stopLocalNotice(`r${i}`)).toBe(true)
    }
    expect(sender.listenerCount('destroyed')).toBe(0)
  })

  it('does nothing where no manager follows the model (a standalone editor)', () => {
    const sender = new EventEmitter()
    const send = vi.fn()
    followLocalNotice(sender, 'f', send, () => undefined)
    expect(send).not.toHaveBeenCalled()
    expect(sender.listenerCount('destroyed')).toBe(0)
  })
})
