import { describe, expect, it } from 'vitest'
import { topVectors } from '../src/main/document-memory/top-vectors'

describe('bounded vector candidates', () => {
  it('matches a full ranking while consuming a large lazy corpus once', () => {
    const count = 100_000
    let consumed = 0
    function* rows() {
      for (let id = 0; id < count; id++) {
        consumed++
        yield { id, score: Math.sin(id * 731) }
      }
    }
    const expected = Array.from({ length: count }, (_, id) => ({ id, score: Math.sin(id * 731) }))
      .sort((a, b) => b.score - a.score || a.id - b.id)
      .slice(0, 200)
    expect(topVectors(rows(), 200)).toEqual(expected)
    expect(consumed).toBe(count)
  })

  it('keeps deterministic ties and ignores invalid scores', () => {
    expect(
      topVectors(
        [
          { id: 4, score: 1 },
          { id: 2, score: 1 },
          { id: 0, score: NaN },
          { id: 1, score: 1 },
        ],
        2,
      ),
    ).toEqual([
      { id: 1, score: 1 },
      { id: 2, score: 1 },
    ])
  })
})
