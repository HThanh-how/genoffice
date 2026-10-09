import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { FileIndexSearchClient, type SearchThread } from '../src/main/file-index/search-client'
import type { SearchResult } from '../src/main/file-index/store'

class FakeThread extends EventEmitter implements SearchThread {
  posted: Array<{ id: number; q: string }> = []
  terminated = false
  postMessage(message: unknown): void {
    this.posted.push(message as { id: number; q: string })
  }
  terminate(): void {
    this.terminated = true
  }
  answer(index: number, result: SearchResult): void {
    this.emit('message', { id: this.posted[index]!.id, result })
  }
}
const page = (path: string): SearchResult => ({
  hits: [{ path, name: path, ext: 'txt', mtimeMs: 1, sizeBytes: 1, snippet: null, needles: [] }],
  total: 1,
})

describe('FileIndexSearchClient', () => {
  it('runs one search at a time and answers the ones a newer keystroke overtook with an empty page', async () => {
    const thread = new FakeThread()
    const client = new FileIndexSearchClient(() => thread)
    const a = client.search('a')
    const ab = client.search('ab')
    const abc = client.search('abc')
    const abcd = client.search('abcd')
    // 'a' is running; 'ab' and 'abc' were overtaken by 'abcd' and are answered at once, empty
    expect(thread.posted.map((p) => p.q)).toEqual(['a'])
    expect((await ab).hits).toEqual([])
    expect((await abc).hits).toEqual([])
    thread.answer(0, page('/a'))
    expect((await a).hits[0]!.path).toBe('/a')
    await vi.waitFor(() => expect(thread.posted.map((p) => p.q)).toEqual(['a', 'abcd']))
    thread.answer(1, page('/abcd'))
    expect((await abcd).hits[0]!.path).toBe('/abcd')
    client.close()
  })

  it('never posts the heavy query itself: the caller only awaits a promise', () => {
    const thread = new FakeThread()
    const client = new FileIndexSearchClient(() => thread)
    const started = performance.now()
    void client.search('report')
    expect(performance.now() - started).toBeLessThan(50)
    expect(thread.posted).toHaveLength(1)
    client.close()
  })

  it('answers empty (and recovers on the next search) when the thread dies', async () => {
    const threads: FakeThread[] = []
    const client = new FileIndexSearchClient(() => {
      const t = new FakeThread()
      threads.push(t)
      return t
    })
    const first = client.search('x')
    threads[0]!.emit('exit')
    expect((await first).hits).toEqual([])
    const second = client.search('y')
    await vi.waitFor(() => expect(threads).toHaveLength(2))
    threads[1]!.answer(0, page('/y'))
    expect((await second).hits[0]!.path).toBe('/y')
    client.close()
  })

  it('answers empty after close', async () => {
    const client = new FileIndexSearchClient(() => new FakeThread())
    client.close()
    expect((await client.search('x')).hits).toEqual([])
  })
})
