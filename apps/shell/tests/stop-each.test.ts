import { describe, expect, it } from 'vitest'
import { stopEach } from '../src/main/document-memory/runtime/stop-each'

describe('stopEach', () => {
  it('stops every part in order', () => {
    const order: string[] = []
    stopEach([
      ['a', () => void order.push('a')],
      ['b', () => void order.push('b')],
    ])
    expect(order).toEqual(['a', 'b'])
  })

  it('names a part that throws and still stops the ones after it', () => {
    const order: string[] = []
    const failed: string[] = []
    stopEach(
      [
        ['first', () => void order.push('first')],
        [
          'broken',
          () => {
            throw new Error('x')
          },
        ],
        ['last', () => void order.push('last')],
      ],
      (name) => void failed.push(name),
    )
    expect(order).toEqual(['first', 'last'])
    expect(failed).toEqual(['broken'])
  })
})
