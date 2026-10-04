import { describe, expect, it } from 'vitest'
import { buildTodo, fold, matchesQuery, type TodoInput } from '../src/renderer/src/fork/todo-model'
import { isIndexIssueSummary, readIndexRequest } from '../src/renderer/src/fork/index-request'

const base: TodoInput = {
  groups: [],
  pending: 0,
  ready: 1200,
  switchedOff: false,
  held: false,
  scanning: false,
  legacy: null,
}
const ids = (input: Partial<TodoInput>) => buildTodo({ ...base, ...input }).cards.map((c) => c.id)

describe('the "To do" tab', () => {
  it('has nothing to show but a healthy state when the index is up to date', () => {
    const todo = buildTodo(base)
    expect(todo.cards).toEqual([])
    expect(todo.healthy).toBe(true)
    expect(todo.tiles.find((t) => t.id === 'ready')!.value).toBe(1200)
  })

  it('offers to read scans and to retry failures, with the biggest worry first', () => {
    const todo = buildTodo({
      ...base,
      groups: [
        { reason: 'no-text', count: 40 },
        { reason: 'timeout', count: 3 },
        { reason: 'corrupt', count: 2 },
      ],
    })
    expect(todo.cards.map((c) => c.id)).toEqual(['errors', 'scans'])
    expect(todo.cards[0]).toMatchObject({
      tone: 'warn',
      count: 5,
      primary: 'retryAll',
      secondary: 'viewErrors',
    })
    expect(todo.cards[1]).toMatchObject({ count: 40, primary: 'readScans', secondary: 'viewScans' })
    expect(todo.healthy).toBe(false)
    expect(todo.tiles.find((t) => t.id === 'scans')).toMatchObject({
      value: 40,
      attention: true,
      opens: 'viewScans',
    })
  })

  it('does not offer a retry for failures that no retry can fix', () => {
    const [card] = buildTodo({ ...base, groups: [{ reason: 'unsupported', count: 4 }] }).cards
    expect(card).toMatchObject({ id: 'quiet', tone: 'quiet', count: 4 })
    const only = buildTodo({ ...base, groups: [{ reason: 'password', count: 1 }] })
    expect(only.healthy).toBe(true) // information, not a job
  })

  it('says when indexing is off, and what to press', () => {
    expect(buildTodo({ ...base, switchedOff: true, pending: 50 }).cards[0]).toMatchObject({
      id: 'off',
      tone: 'warn',
      primary: 'resume',
    })
  })

  it('explains a pause by the machine without offering a button for it', () => {
    const cards = buildTodo({ ...base, held: true, heldReason: 'low memory', pending: 30 }).cards
    expect(cards[0]).toMatchObject({ id: 'held', tone: 'info', why: 'low memory', count: 30 })
    expect(cards.some((c) => c.id === 'indexing')).toBe(false) // not shown twice
  })

  it('shows the conversion of old files with its progress, and a button only when it is idle', () => {
    const running = buildTodo({
      ...base,
      legacy: { running: true, pending: 30, converted: 70, failed: 0 },
    })
    expect(running.cards[0]).toMatchObject({ id: 'legacy', count: 30, progress: 70 })
    expect(running.cards[0]!.primary).toBeUndefined()
    const idle = buildTodo({
      ...base,
      legacy: { running: false, pending: 30, converted: 70, failed: 4 },
    })
    expect(idle.cards[0]).toMatchObject({ primary: 'convertNow', failed: 4 })
    expect(ids({ legacy: { running: false, pending: 0, converted: 5, failed: 0 } })).toEqual([])
  })

  it('counts what the indexer is reading, from whichever figure is larger', () => {
    expect(
      buildTodo({ ...base, pending: 9, groups: [{ reason: 'waiting', count: 20 }] }).cards[0],
    ).toMatchObject({
      id: 'indexing',
      count: 20,
      secondary: 'viewIndexing',
    })
    expect(ids({ pending: 7 })).toEqual(['indexing'])
    expect(buildTodo({ ...base, scanning: true }).cards.map((c) => c.id)).toEqual(['scanning'])
  })
})

describe('finding a file in the lists', () => {
  it('ignores case and accents, so Vietnamese can be typed without them', () => {
    expect(fold('Năm học 2025 – Đề cương')).toBe('nam hoc 2025 – de cuong')
    expect(
      matchesQuery(
        { name: 'Danh sách học sinh.xlsx', path: 'D:\\NAM HOC\\Danh sách học sinh.xlsx' },
        'danh sach',
      ),
    ).toBe(true)
    expect(matchesQuery({ name: 'Đề cương.docx', path: 'D:\\x\\Đề cương.docx' }, 'de cuong')).toBe(
      true,
    )
  })

  it('needs every word, in the name or the folder, in any order', () => {
    const file = { name: 'bao cao.pdf', path: 'D:\\Lop 2\\bao cao.pdf' }
    expect(matchesQuery(file, 'lop 2 bao')).toBe(true)
    expect(matchesQuery(file, 'bao cao 2026')).toBe(false)
    expect(matchesQuery(file, '   ')).toBe(true)
    expect(matchesQuery(file, '')).toBe(true)
  })
})

describe('index summary connection', () => {
  it('rejects an empty or malformed IPC result instead of treating it as loaded', () => {
    expect(isIndexIssueSummary(null)).toBe(false)
    expect(isIndexIssueSummary(undefined)).toBe(false)
    expect(isIndexIssueSummary({ total: 0, groups: null })).toBe(false)
  })

  it('accepts a valid empty index summary', () => {
    expect(isIndexIssueSummary({ total: 0, groups: [] })).toBe(true)
  })

  it('rejects a null IPC response so the caller can show the retry state', async () => {
    await expect(
      readIndexRequest(() => Promise.resolve(null), isIndexIssueSummary),
    ).rejects.toThrow('Invalid index response')
  })

  it('turns a preload call that never responds into a retryable failure', async () => {
    await expect(
      readIndexRequest(() => new Promise(() => undefined), isIndexIssueSummary, 5),
    ).rejects.toThrow('timed out')
  })
})
