import { describe, expect, it } from 'vitest'
import { fitMessages } from '../src/host/fit'
import type { LocalMessage } from '../src/protocol'

// one "token" per character keeps the arithmetic obvious
const count = (messages: LocalMessage[]): number =>
  messages.reduce(
    (n, m) =>
      n +
      (m.role === 'user'
        ? m.text.length
        : m.role === 'assistant'
          ? m.text.length
          : m.results.reduce((k, r) => k + r.output.length, 0)),
    0,
  )
const user = (text: string): LocalMessage => ({ role: 'user', text })
const assistant = (text: string): LocalMessage => ({ role: 'assistant', text })
const tool = (output: string): LocalMessage => ({
  role: 'tool',
  results: [{ id: 'c', name: 't', output }],
})

describe('fitMessages', () => {
  it('leaves a conversation that fits alone', () => {
    const messages = [user('a'), assistant('b')]
    expect(fitMessages(messages, count, 100)).toEqual({
      messages,
      droppedMessages: 0,
      truncatedResults: 0,
    })
  })

  it('drops the oldest turns, only at a user message', () => {
    const messages = [
      user('x'.repeat(50)),
      assistant('y'.repeat(50)),
      user('q'.repeat(10)),
      assistant('r'),
    ]
    const fitted = fitMessages(messages, count, 30)!
    expect(fitted.droppedMessages).toBe(2)
    expect(fitted.messages[0]).toEqual(user('q'.repeat(10)))
  })

  it('never separates a tool call from its result', () => {
    const messages = [
      user('q'),
      assistant('call'),
      tool('z'.repeat(40)),
      assistant('done'),
      user('next'),
    ]
    const fitted = fitMessages(messages, count, 20)!
    expect(fitted.messages[0]!.role).toBe('user')
  })

  it('cuts oversized tool results of the newest turn when dropping is not enough', () => {
    const messages = [user('q'), assistant('call'), tool('z'.repeat(20000)), assistant('more')]
    const fitted = fitMessages(messages, (m) => count(m) / 4, 2000)!
    expect(fitted.truncatedResults).toBe(1)
    const result = (fitted.messages[2] as Extract<LocalMessage, { role: 'tool' }>).results[0]!
    expect(result.output.length).toBeLessThan(20000)
    expect(result.output).toContain('cut to fit')
  })

  it('gives up when the newest message alone does not fit', () => {
    expect(fitMessages([user('x'.repeat(500))], count, 100)).toBeNull()
  })
})
