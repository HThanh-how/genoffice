import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DiagnosticsLogger, realLogFs, type LogFs } from '../src/main/diagnostics/logger'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'diag-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const lines = (dir: string, file = 'genoffice.jsonl'): any[] =>
  readFileSync(join(dir, file), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))

describe('DiagnosticsLogger', () => {
  it('writes one JSON object per line with the fixed fields', async () => {
    const dir = tmp()
    const log = new DiagnosticsLogger({ dir, version: '1.2.3', commit: 'abc', pid: 42 })
    log.info('ai', 'request.start', { reqId: 'r1', provider: 'x' })
    log.warn('ipc', 'handler.slow', { channel: 'a', ms: 700 })
    await log.flush()
    const [a, b] = lines(dir)
    expect(a).toMatchObject({
      level: 'info',
      cat: 'ai',
      ev: 'request.start',
      pid: 42,
      ver: '1.2.3',
      commit: 'abc',
      reqId: 'r1',
      data: { provider: 'x' },
    })
    expect(new Date(a.ts).toISOString()).toBe(a.ts)
    expect(b.level).toBe('warn')
    expect(b.reqId).toBeUndefined()
  })

  it('never writes prompt text, keys or content', async () => {
    const dir = tmp()
    const log = new DiagnosticsLogger({ dir })
    log.info('ai', 'request.start', {
      prompt: 'tell me about my salary',
      note: 'used sk-abcdefghijklmnopqrstuvwxyz0123',
      content: 'file body',
    })
    await log.flush()
    const raw = readFileSync(join(dir, 'genoffice.jsonl'), 'utf8')
    expect(raw).not.toContain('salary')
    expect(raw).not.toContain('sk-abcdefghijklmnop')
    expect(raw).not.toContain('file body')
  })

  it('filters by level', async () => {
    const dir = tmp()
    const log = new DiagnosticsLogger({ dir, level: 'warn' })
    log.debug('a', 'd')
    log.info('a', 'i')
    log.error('a', 'e')
    await log.flush()
    expect(lines(dir).map((l) => l.ev)).toEqual(['e'])
  })

  it('span logs the duration, and the failure with its cause', async () => {
    const dir = tmp()
    const log = new DiagnosticsLogger({ dir })
    log.span('ipc', 'home:check').end({ ok: true })
    log.span('ipc', 'home:other').fail(new Error('boom'))
    await log.flush()
    const [ok, bad] = lines(dir)
    expect(ok).toMatchObject({ ev: 'home:check', data: { ok: true } })
    expect(typeof ok.data.ms).toBe('number')
    expect(bad).toMatchObject({ level: 'error', ev: 'home:other.failed' })
    expect(bad.data.err.message).toBe('boom')
  })

  it('batches: nothing is written until the interval or the line count is reached', async () => {
    const writes: string[] = []
    const fs: LogFs = {
      ...realLogFs,
      mkdir: async () => undefined,
      size: async () => 0,
      appendFile: async (_p, t) => void writes.push(t),
    }
    const log = new DiagnosticsLogger({ dir: '/d', fs, flushIntervalMs: 30, flushLines: 5 })
    log.info('a', '1')
    log.info('a', '2')
    expect(writes).toHaveLength(0)
    await new Promise((r) => setTimeout(r, 80))
    expect(writes).toHaveLength(1)
    expect(writes[0]!.trim().split('\n')).toHaveLength(2)
    for (let i = 0; i < 5; i++) log.info('a', `n${i}`)
    await new Promise((r) => setTimeout(r, 10))
    expect(writes).toHaveLength(2)
  })

  it('log calls do not touch the filesystem on the calling thread', () => {
    let touched = 0
    const fs: LogFs = {
      appendFile: async () => void touched++,
      mkdir: async () => void touched++,
      size: async () => 0,
      rename: async () => void touched++,
      unlink: async () => void touched++,
      appendFileSync: () => void touched++,
      mkdirSync: () => void touched++,
    }
    const log = new DiagnosticsLogger({ dir: '/d', fs, flushIntervalMs: 10_000 })
    for (let i = 0; i < 1000; i++) log.info('a', 'x', { i })
    expect(touched).toBe(0)
  })

  it('drops debug lines first when the queue is full and says how many', async () => {
    const dir = tmp()
    const log = new DiagnosticsLogger({
      dir,
      level: 'debug',
      maxQueue: 10,
      flushIntervalMs: 10_000,
      flushLines: 1000,
    })
    for (let i = 0; i < 10; i++) log.debug('a', `d${i}`)
    log.debug('a', 'overflow')
    log.error('a', 'keep-me')
    expect(log.droppedCount).toBe(2)
    await log.flush()
    const all = lines(dir)
    expect(all.some((l) => l.ev === 'keep-me')).toBe(true)
    expect(all.some((l) => l.ev === 'overflow')).toBe(false)
    expect(all.find((l) => l.ev === 'dropped')?.data.lines).toBe(2)
    expect(log.droppedCount).toBe(0)
  })

  it('rotates by size and keeps the configured number of files', async () => {
    const dir = tmp()
    const log = new DiagnosticsLogger({ dir, maxBytes: 600, files: 3, flushLines: 1 })
    for (let i = 0; i < 40; i++) {
      log.info('a', `event-${i}`, { pad: 'x'.repeat(60) })
      await log.flush()
    }
    const names = readdirSync(dir).sort()
    expect(names).toEqual(['genoffice.1.jsonl', 'genoffice.2.jsonl', 'genoffice.jsonl'])
    // newest events are in the live file, older ones moved down
    expect(lines(dir).at(-1).ev).toBe('event-39')
    const first1 = lines(dir, 'genoffice.1.jsonl')[0].ev
    const first2 = lines(dir, 'genoffice.2.jsonl')[0].ev
    expect(Number(first2.split('-')[1])).toBeLessThan(Number(first1.split('-')[1]))
  })

  it('does not swallow a failed rotation: reports it and keeps writing in a new file', async () => {
    const dir = tmp()
    const reports: string[] = []
    const fs: LogFs = {
      ...realLogFs,
      rename: async (from, to) => {
        if (to.endsWith('genoffice.1.jsonl'))
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
        return realLogFs.rename(from, to)
      },
    }
    const log = new DiagnosticsLogger({
      dir,
      fs,
      maxBytes: 300,
      flushLines: 1,
      onInternalError: (m) => void reports.push(m),
    })
    for (let i = 0; i < 10; i++) {
      log.info('a', `event-${i}`, { pad: 'y'.repeat(50) })
      await log.flush()
    }
    expect(reports.some((m) => m.includes('could not rotate'))).toBe(true)
    // every event is somewhere on disk
    const all = readdirSync(dir)
      .flatMap((f) => lines(dir, f))
      .map((l) => l.ev)
    for (let i = 0; i < 10; i++) expect(all).toContain(`event-${i}`)
    expect(log.path).not.toBe(join(dir, 'genoffice.jsonl'))
  })

  it('reports a write failure instead of going silent, and recovers on the next flush', async () => {
    const reports: string[] = []
    let fail = true
    const fs: LogFs = {
      ...realLogFs,
      mkdir: async () => undefined,
      size: async () => 0,
      appendFile: async () => {
        if (fail) throw new Error('disk full')
      },
    }
    const log = new DiagnosticsLogger({
      dir: '/d',
      fs,
      onInternalError: (m) => void reports.push(m),
    })
    log.info('a', 'lost')
    await log.flush()
    expect(reports[0]).toContain('could not write')
    fail = false
    log.info('a', 'ok')
    await expect(log.flush()).resolves.toBeUndefined()
  })

  it('picks up an existing file size so rotation counts what is already there', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'genoffice.jsonl'), 'x'.repeat(900) + '\n')
    const log = new DiagnosticsLogger({ dir, maxBytes: 1000, files: 2 })
    log.info('a', 'new', { pad: 'z'.repeat(200) })
    await log.flush()
    expect(readdirSync(dir).sort()).toEqual(['genoffice.1.jsonl', 'genoffice.jsonl'])
  })

  it('flushSync writes what is queued, once', () => {
    const dir = tmp()
    const log = new DiagnosticsLogger({ dir, flushIntervalMs: 10_000 })
    log.info('app', 'quit')
    log.flushSync()
    log.flushSync()
    expect(lines(dir)).toHaveLength(1)
  })

  it('costs little per call', () => {
    const log = new DiagnosticsLogger({
      dir: tmp(),
      flushIntervalMs: 10_000,
      maxQueue: 100_000,
      flushLines: 1_000_000,
    })
    const started = performance.now()
    for (let i = 0; i < 5000; i++) log.info('ipc', 'handler.slow', { channel: 'home:x', ms: i })
    const perCall = (performance.now() - started) / 5000
    expect(perCall).toBeLessThan(0.2)
  })
})
