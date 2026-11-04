import { spawn, type ChildProcess } from 'node:child_process'
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
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

const lines = (dir: string, file = 'genoffice.jsonl'): any[] =>
  readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '') // a fresh line after a torn write leaves a blank one
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
      truncate: async () => void touched++,
      list: async () => [],
      appendFileSync: () => void touched++,
      mkdirSync: () => void touched++,
    }
    const log = new DiagnosticsLogger({ dir: '/d', fs, flushIntervalMs: 10_000 })
    for (let i = 0; i < 1000; i++) log.info('a', 'x', { i })
    expect(touched).toBe(0)
  })

  it('drops debug first, then info, and never an error, when the queue is full', async () => {
    const dir = tmp()
    const log = new DiagnosticsLogger({
      dir,
      level: 'debug',
      maxQueue: 10,
      flushIntervalMs: 10_000,
      flushLines: 1000,
    })
    for (let i = 0; i < 5; i++) log.error('a', `err${i}`)
    for (let i = 0; i < 5; i++) log.info('a', `info${i}`)
    log.debug('a', 'debug-overflow') // dropped: debug is the first to go
    log.info('a', 'info-overflow') // evicts the oldest info
    log.error('a', 'late-error') // evicts the next oldest info
    expect(log.droppedCount).toBe(3)
    await log.flush()
    const events = lines(dir).map((l) => l.ev)
    for (let i = 0; i < 5; i++) expect(events).toContain(`err${i}`)
    expect(events).toContain('late-error')
    expect(events).not.toContain('debug-overflow')
    expect(events).not.toContain('info0')
    expect(lines(dir).find((l) => l.ev === 'dropped')?.data.lines).toBe(3)
    expect(log.droppedCount).toBe(0)
    expect(log.stats().droppedTotal).toBe(3)
  })

  it('keeps warnings and errors beyond the cap (up to 4x) while a flood of info is dropped', async () => {
    const dir = tmp()
    const log = new DiagnosticsLogger({
      dir,
      maxQueue: 10,
      flushIntervalMs: 10_000,
      flushLines: 1000,
    })
    for (let i = 0; i < 30; i++) log.error('a', `e${i}`)
    for (let i = 0; i < 30; i++) log.info('a', `i${i}`)
    await log.flush()
    const events = lines(dir).map((l) => l.ev)
    for (let i = 0; i < 30; i++) expect(events).toContain(`e${i}`)
    expect(events.filter((e) => e.startsWith('i')).length).toBe(0)
  })

  it('keeps the original time of a line written before the logger existed', async () => {
    const dir = tmp()
    const log = new DiagnosticsLogger({ dir })
    log.write('info', 'app', 'early', undefined, new Date('2026-01-02T03:04:05.000Z'))
    await log.flush()
    expect(lines(dir)[0].ts).toBe('2026-01-02T03:04:05.000Z')
  })

  it('writes a flood in slices that stay near the size limit, with turns of the loop between', async () => {
    const dir = tmp()
    let yields = 0
    const log = new DiagnosticsLogger({
      dir,
      maxBytes: 20_000,
      files: 3,
      chunkBytes: 5_000,
      flushIntervalMs: 10_000,
      flushLines: 1_000_000,
      maxQueue: 10_000,
      yieldTick: async () => void yields++,
    })
    for (let i = 0; i < 500; i++) log.info('a', `n${i}`, { pad: 'x'.repeat(40) })
    await log.flush()
    expect(yields).toBeGreaterThan(5)
    for (const f of readdirSync(dir)) {
      expect(readFileSync(join(dir, f)).length).toBeLessThanOrEqual(20_000 + 5_000)
    }
    const all = readdirSync(dir).flatMap((f) => lines(dir, f))
    expect(all.at(-1).ev === 'n499' || lines(dir).at(-1).ev === 'n499').toBe(true)
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

  it('does not swallow a failed rotation: reports it and keeps writing', async () => {
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
    expect(reports.some((m) => /could not (move|put)/.test(m))).toBe(true)
    // the cause is reported with the path, and the newest events are on disk
    const all = readdirSync(dir)
      .flatMap((f) => lines(dir, f))
      .map((l) => l.ev)
    expect(all).toContain('event-9')
    expect(log.stats().internalErrors).toBeGreaterThan(0)
  })

  it('moves the live file aside when the numbered slot is stuck, instead of deleting it', async () => {
    const dir = tmp()
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
      sleep: async () => undefined,
      onInternalError: () => undefined,
    })
    for (let i = 0; i < 12; i++) {
      log.info('a', `event-${i}`, { pad: 'y'.repeat(50) })
      await log.flush()
    }
    const all = readdirSync(dir)
      .flatMap((f) => lines(dir, f))
      .map((l) => l.ev)
    // the live file was moved aside, not deleted (at most the two newest set-aside files are kept)
    expect(all).toContain('event-11')
    expect(all.length).toBeGreaterThanOrEqual(3)
    expect(
      readdirSync(dir).filter((f) => /^genoffice\.\d{10,}\.jsonl$/.test(f)).length,
    ).toBeLessThanOrEqual(4)
  })

  it('retries the rename after a short pause before giving up (a scanner may hold the file a moment)', async () => {
    const dir = tmp()
    let failures = 2
    const pauses: number[] = []
    const fs: LogFs = {
      ...realLogFs,
      rename: async (from, to) => {
        if (from.endsWith('genoffice.jsonl') && failures-- > 0) {
          throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
        }
        return realLogFs.rename(from, to)
      },
    }
    const log = new DiagnosticsLogger({
      dir,
      fs,
      maxBytes: 300,
      flushLines: 1,
      files: 10,
      sleep: async (ms) => void pauses.push(ms),
      onInternalError: () => undefined,
    })
    for (let i = 0; i < 6; i++) {
      log.info('a', `event-${i}`, { pad: 'y'.repeat(50) })
      await log.flush()
    }
    expect(pauses.slice(0, 2)).toEqual([50, 200])
    const all = readdirSync(dir)
      .flatMap((f) => lines(dir, f))
      .map((l) => l.ev)
    for (let i = 0; i < 6; i++) expect(all).toContain(`event-${i}`)
    expect(readdirSync(dir)).toContain('genoffice.1.jsonl')
  })

  it('never deletes or empties a live file that cannot be moved; it continues in a new file and prunes old ones', async () => {
    const dir = tmp()
    for (const ts of [
      '1700000000001',
      '1700000000002',
      '1700000000003',
      '1700000000004',
      '1700000000005',
    ]) {
      writeFileSync(join(dir, `genoffice.${ts}.jsonl`), 'old\n')
    }
    writeFileSync(join(dir, 'genoffice.jsonl'), 'x'.repeat(400) + '\n')
    const unlinked: string[] = []
    const fs: LogFs = {
      ...realLogFs,
      rename: async (from, to) => {
        if (from.endsWith('genoffice.jsonl'))
          throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
        return realLogFs.rename(from, to)
      },
      unlink: async (p) => {
        unlinked.push(p)
        return realLogFs.unlink(p)
      },
    }
    const reports: string[] = []
    const log = new DiagnosticsLogger({
      dir,
      fs,
      maxBytes: 300,
      flushLines: 1,
      sleep: async () => undefined,
      now: () => new Date(1700000000999),
      onInternalError: (m) => void reports.push(m),
    })
    log.info('a', 'one', { pad: 'z'.repeat(50) })
    await log.flush()
    await log.settled()
    expect(unlinked.some((p) => p.endsWith('genoffice.jsonl'))).toBe(false)
    expect(readFileSync(join(dir, 'genoffice.jsonl'), 'utf8')).toBe('x'.repeat(400) + '\n')
    const orphans = readdirSync(dir).filter((f) => /^genoffice\.\d{10,}\.jsonl$/.test(f))
    expect(orphans).toContain('genoffice.1700000001000.jsonl') // 999 was the failed move aside
    expect(orphans).not.toContain('genoffice.1700000000001.jsonl')
    expect(reports.some((m) => m.includes('continuing in'))).toBe(true)
  })

  it('does not say the same thing every attempt: one report per message per 10 s', async () => {
    const reports: string[] = []
    const fs: LogFs = {
      ...realLogFs,
      mkdir: async () => undefined,
      size: async () => 0,
      list: async () => [],
      appendFile: async () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      },
    }
    const log = new DiagnosticsLogger({
      dir: '/d',
      fs,
      sleep: async () => undefined,
      retryBackoffMs: 0,
      switchAfterFailures: 99,
      onInternalError: (m) => void reports.push(m),
    })
    for (let i = 0; i < 5; i++) {
      log.error('a', 'x')
      await log.flush()
    }
    expect(reports.filter((m) => m.startsWith('could not write'))).toHaveLength(1)
    expect(log.stats().internalErrors).toBeGreaterThanOrEqual(5)
  })

  it('retries a write that fails for a moment and loses nothing', async () => {
    const dir = tmp()
    let failures = 2
    const fs: LogFs = {
      ...realLogFs,
      appendFile: async (p, t) => {
        if (failures-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        return realLogFs.appendFile(p, t)
      },
    }
    const reports: string[] = []
    const log = new DiagnosticsLogger({
      dir,
      fs,
      sleep: async () => undefined,
      onInternalError: (m) => void reports.push(m),
    })
    log.error('a', 'important')
    await log.flush()
    expect(lines(dir).map((l) => l.ev)).toEqual(['important'])
    expect(reports).toEqual([])
  })

  it('puts a batch back in the queue when every retry fails, and writes it later', async () => {
    const dir = tmp()
    const reports: string[] = []
    let broken = true
    const fs: LogFs = {
      ...realLogFs,
      appendFile: async (p, t) => {
        if (broken) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
        return realLogFs.appendFile(p, t)
      },
    }
    const log = new DiagnosticsLogger({
      dir,
      fs,
      sleep: async () => undefined,
      onInternalError: (m) => void reports.push(m),
    })
    log.error('a', 'first')
    await log.flush()
    expect(reports[0]).toContain('could not write')
    expect(reports[0]).toContain('kept for the next flush')
    log.error('a', 'second')
    broken = false
    await log.flush()
    // order is kept: the held batch comes before the newer line
    expect(lines(dir).map((l) => l.ev)).toEqual(['first', 'second'])
  })

  it('flushSync writes an unfinished batch again, in order, behind a marker, then the queue', async () => {
    const dir = tmp()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const fs: LogFs = {
      ...realLogFs,
      appendFile: async () => {
        await gate // the asynchronous write never finishes before the process ends
      },
    }
    const log = new DiagnosticsLogger({ dir, fs, flushIntervalMs: 10_000 })
    log.info('a', 'in-flight-1')
    log.info('a', 'in-flight-2')
    const pending = log.flush()
    await new Promise((r) => setTimeout(r, 20))
    log.error('a', 'newer')
    log.flushSync()
    const events = lines(dir).map((l) => l.ev)
    expect(events).toEqual(['flush.resent', 'in-flight-1', 'in-flight-2', 'newer'])
    release()
    await pending
    // the asynchronous write was abandoned: nothing is written twice
    expect(lines(dir).map((l) => l.ev)).toEqual(events)
  })

  it('keeps logging after a flushSync (a quit can be cancelled)', async () => {
    const dir = tmp()
    const log = new DiagnosticsLogger({ dir, flushIntervalMs: 5 })
    log.info('app', 'before-quit')
    log.flushSync()
    log.info('app', 'after-cancelled-quit')
    await log.flush()
    expect(lines(dir).map((l) => l.ev)).toEqual(['before-quit', 'after-cancelled-quit'])
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
    expect(perCall).toBeLessThan(1)
  })
})

describe('DiagnosticsLogger queue limits', () => {
  const noFs = (): LogFs => ({
    ...realLogFs,
    mkdir: async () => undefined,
    size: async () => 0,
    appendFile: () => new Promise<void>(() => undefined), // a drive that never answers
  })

  it('making room stays O(1) when the queue sits at its cap (20,000 lines past the cap)', () => {
    const log = new DiagnosticsLogger({
      dir: '/d',
      fs: noFs(),
      maxQueue: 10_000,
      flushIntervalMs: 1e9,
      flushLines: 1e9,
    })
    for (let i = 0; i < 10_000; i++) log.info('a', 'fill')
    expect(log.queued).toBe(10_000)
    const started = performance.now()
    for (let i = 0; i < 20_000; i++) log.info('a', 'over')
    const perLine = (performance.now() - started) / 20_000
    // each line still costs its formatting (~0.03 ms); a scan of 10,000 entries per line would be ~0.1 ms more
    expect(perLine).toBeLessThan(0.15)
    expect(log.queued).toBe(10_000)
    expect(log.droppedCount).toBe(20_000)
  })

  it('drops a lesser line without formatting it when the queue holds only urgent lines', () => {
    const log = new DiagnosticsLogger({
      dir: '/d',
      fs: noFs(),
      maxQueue: 1_000,
      flushIntervalMs: 1e9,
      flushLines: 1e9,
    })
    for (let i = 0; i < 1_000; i++) log.error('a', 'fill')
    const started = performance.now()
    for (let i = 0; i < 20_000; i++) log.info('a', 'over', { x: 'y'.repeat(100) })
    expect(performance.now() - started).toBeLessThan(50)
    expect(log.queued).toBe(1_000)
  })

  it('lets warnings and errors grow to 4x the cap, then drops the oldest of them', () => {
    const log = new DiagnosticsLogger({
      dir: '/d',
      fs: noFs(),
      maxQueue: 10,
      flushIntervalMs: 1e9,
      flushLines: 1e9,
    })
    for (let i = 0; i < 100; i++) log.error('a', `e${i}`)
    expect(log.queued).toBe(40)
    expect(log.droppedCount).toBe(60)
  })

  it('keeps the order of lines of different levels when they are written', async () => {
    const dir = tmp()
    const log = new DiagnosticsLogger({
      dir,
      level: 'debug',
      flushIntervalMs: 1e9,
      flushLines: 1e9,
    })
    log.info('a', '1')
    log.error('a', '2')
    log.debug('a', '3')
    log.warn('a', '4')
    log.info('a', '5')
    await log.flush()
    expect(lines(dir).map((l) => l.ev)).toEqual(['1', '2', '3', '4', '5'])
  })

  it('a requeued batch is bounded too, and the lines it loses are counted', async () => {
    const dir = tmp()
    let broken = true
    const fs: LogFs = {
      ...realLogFs,
      appendFile: async (p, t) => {
        if (broken) throw new Error('EPERM')
        return realLogFs.appendFile(p, t)
      },
    }
    const log = new DiagnosticsLogger({
      dir,
      fs,
      maxQueue: 20,
      sleep: async () => undefined,
      retryBackoffMs: 0,
      flushIntervalMs: 1e9,
      flushLines: 1e9,
      onInternalError: () => undefined,
    })
    for (let i = 0; i < 20; i++) log.info('a', `old${i}`)
    await log.flush() // fails: the 20 lines go back
    for (let i = 0; i < 20; i++) log.info('a', `new${i}`) // evicts the old ones, one per new line
    broken = false
    await log.flush()
    const events = lines(dir).map((l) => l.ev)
    expect(events.filter((e) => e.startsWith('new'))).toHaveLength(20)
    expect(events).toContain('dropped')
    expect(log.stats().droppedTotal).toBe(20)
  })

  it('log calls stay fast while the drive does not answer at all', async () => {
    const log = new DiagnosticsLogger({
      dir: '/d',
      fs: noFs(),
      flushIntervalMs: 1,
      flushLines: 1,
    })
    const started = performance.now()
    for (let i = 0; i < 2_000; i++) log.info('a', 'x', { i })
    await new Promise((r) => setTimeout(r, 20))
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('replaces a line that is far too long by a short note', async () => {
    const dir = tmp()
    const log = new DiagnosticsLogger({ dir, maxLineChars: 600 })
    const big: Record<string, string> = {}
    for (let i = 0; i < 30; i++) big[`k${i}`] = 'v'.repeat(100)
    log.info('a', 'big', big)
    await log.flush()
    expect(lines(dir)[0].data).toMatchObject({ truncated: true })
  })
})

describe('DiagnosticsLogger when the live file refuses every write', () => {
  it('moves to a new file after a few failed batches in a row, and the lines get there', async () => {
    const dir = tmp()
    const live = join(dir, 'genoffice.jsonl')
    writeFileSync(live, 'seed\n')
    const fs: LogFs = {
      ...realLogFs,
      appendFile: async (p, t) => {
        if (p === live) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }) // held open without write sharing
        return realLogFs.appendFile(p, t)
      },
    }
    const log = new DiagnosticsLogger({
      dir,
      fs,
      retryDelaysMs: [],
      retryBackoffMs: 0,
      switchAfterFailures: 3,
      now: () => new Date(1700000000000),
      onInternalError: () => undefined,
    })
    for (let i = 0; i < 5; i++) {
      log.error('a', `event-${i}`)
      await log.flush()
    }
    expect(log.path).not.toBe(live)
    expect(log.path).toMatch(/genoffice\.\d{10,}\.jsonl$/)
    const events = readFileSync(log.path, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l).ev)
    for (let i = 0; i < 5; i++) expect(events).toContain(`event-${i}`)
    expect(readFileSync(live, 'utf8')).toBe('seed\n')
  })

  it('does not wear down the numbered files when the live file cannot be moved', async () => {
    const dir = tmp()
    for (let i = 1; i <= 4; i++) writeFileSync(join(dir, `genoffice.${i}.jsonl`), `old-${i}\n`)
    writeFileSync(join(dir, 'genoffice.jsonl'), 'x'.repeat(400) + '\n')
    const fs: LogFs = {
      ...realLogFs,
      rename: async (from, to) => {
        if (from.endsWith('genoffice.jsonl'))
          throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
        return realLogFs.rename(from, to)
      },
    }
    const log = new DiagnosticsLogger({
      dir,
      fs,
      maxBytes: 300,
      files: 5,
      sleep: async () => undefined,
      onInternalError: () => undefined,
    })
    log.info('a', 'one')
    await log.flush()
    for (let i = 1; i <= 4; i++) {
      expect(readFileSync(join(dir, `genoffice.${i}.jsonl`), 'utf8')).toBe(`old-${i}\n`)
    }
  })
})

describe('DiagnosticsLogger on a drive that does not answer', () => {
  it('gives up an attempt after the timeout and keeps the lines for later', async () => {
    const fs: LogFs = {
      ...realLogFs,
      mkdir: async () => undefined,
      size: async () => 0,
      list: async () => [],
      appendFile: () => new Promise<void>(() => undefined),
    }
    const reports: string[] = []
    const log = new DiagnosticsLogger({
      dir: '/d',
      fs,
      writeTimeoutMs: 20,
      retryDelaysMs: [],
      retryBackoffMs: 1e9,
      switchAfterFailures: 99,
      onInternalError: (m) => void reports.push(m),
    })
    log.error('a', 'x')
    await log.flush()
    expect(reports[0]).toContain('could not write')
    expect(log.queued).toBe(1)
  })

  it('does not stack up a write behind a write that is still running', async () => {
    let appends = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const fs: LogFs = {
      ...realLogFs,
      mkdir: async () => undefined,
      size: async () => 0,
      list: async () => [],
      appendFile: async () => {
        appends++
        await gate
      },
    }
    const log = new DiagnosticsLogger({ dir: '/d', fs, flushIntervalMs: 1, flushLines: 1 })
    log.info('a', 'one')
    await new Promise((r) => setTimeout(r, 20))
    for (let i = 0; i < 200; i++) {
      log.info('a', 'more')
      await new Promise((r) => setImmediate(r))
    }
    expect(appends).toBe(1)
    release()
    await log.flush()
    // everything that arrived meanwhile went out in one more pass, not in 200
    expect(appends).toBeLessThanOrEqual(3)
    expect(log.queued).toBe(0)
  })

  it('bounds the queue by size too', () => {
    const log = new DiagnosticsLogger({
      dir: '/d',
      fs: { ...realLogFs, appendFile: () => new Promise<void>(() => undefined) },
      maxQueue: 1_000_000,
      maxQueueBytes: 5_000,
      maxLineChars: 1e9,
      flushIntervalMs: 1e9,
      flushLines: 1e9,
    })
    for (let i = 0; i < 500; i++) log.info('a', 'x', { pad: 'p'.repeat(100) })
    // about 200 characters a line: 5,000 characters hold about 24 of them
    expect(log.queued).toBeGreaterThan(10)
    expect(log.queued).toBeLessThanOrEqual(26)
    for (let i = 0; i < 500; i++) log.error('a', 'x', { pad: 'p'.repeat(100) })
    expect(log.queued).toBeLessThanOrEqual(26)
  })
})

describe('DiagnosticsLogger on a drive that hangs and comes back', () => {
  const hangingList = (): LogFs => ({
    ...realLogFs,
    list: () => new Promise<string[]>(() => undefined), // never answers
  })

  it('keeps writing when listing the folder never answers (switch to a new file, prune in the background)', async () => {
    const dir = tmp()
    const live = join(dir, 'genoffice.jsonl')
    writeFileSync(live, 'seed\n')
    let broken = true
    const fs: LogFs = {
      ...hangingList(),
      appendFile: async (p, t) => {
        if (broken && p === live) throw new Error('EBUSY')
        return realLogFs.appendFile(p, t)
      },
    }
    const log = new DiagnosticsLogger({
      dir,
      fs,
      retryDelaysMs: [],
      retryBackoffMs: 0,
      switchAfterFailures: 2,
      writeTimeoutMs: 50,
      onInternalError: () => undefined,
    })
    for (let i = 0; i < 4; i++) {
      log.error('a', `event-${i}`)
      await log.flush()
    }
    // the folder listing hangs, yet the writer is not stuck behind it
    broken = false
    log.error('a', 'after')
    await log.flush()
    expect(log.queued).toBe(0)
    const written = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl') && f !== 'genoffice.jsonl')
      .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n'))
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l).ev)
    expect(written).toContain('after')
    for (let i = 0; i < 4; i++) expect(written).toContain(`event-${i}`)
  })

  it('close() returns even if tidying the folder hangs', async () => {
    const dir = tmp()
    const log = new DiagnosticsLogger({ dir, fs: hangingList(), writeTimeoutMs: 50 })
    log.info('a', 'x')
    await expect(log.close()).resolves.toBeUndefined()
    expect(lines(dir).map((l) => l.ev)).toEqual(['x'])
  })

  it('does not write a batch twice when the append that timed out finishes later', async () => {
    const dir = tmp()
    let calls = 0
    const fs: LogFs = {
      ...realLogFs,
      appendFile: async (p, t) => {
        calls++
        if (calls === 1) {
          await new Promise((r) => setTimeout(r, 300)) // the drive answers too late...
          return // ...and, in this model, the first write is lost
        }
        return realLogFs.appendFile(p, t)
      },
    }
    const log = new DiagnosticsLogger({
      dir,
      fs,
      writeTimeoutMs: 60,
      retryDelaysMs: [],
      retryBackoffMs: 0,
      onInternalError: () => undefined,
    })
    log.error('a', 'first')
    log.error('a', 'second')
    await log.flush() // times out: lines go back
    await log.flush() // second attempt succeeds
    await new Promise((r) => setTimeout(r, 400)) // the late first attempt ends now
    const rows = lines(dir)
    expect(rows.filter((r) => r.ev === 'first')).toHaveLength(1)
    expect(rows.filter((r) => r.ev === 'second')).toHaveLength(1)
    // the lines could have reached the file: a marker says so
    expect(rows.map((r) => r.ev)).toContain('flush.maybeDuplicate')
  })

  it('a hung attempt that is only preparing never appends afterwards', async () => {
    const dir = tmp()
    let releaseSize: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (releaseSize = resolve))
    let first = true
    const fs: LogFs = {
      ...realLogFs,
      size: async (p) => {
        if (first) {
          first = false
          await gate
        }
        return realLogFs.size(p)
      },
    }
    const log = new DiagnosticsLogger({
      dir,
      fs,
      writeTimeoutMs: 40,
      retryDelaysMs: [],
      retryBackoffMs: 0,
      onInternalError: () => undefined,
    })
    log.error('a', 'one')
    await log.flush() // times out while preparing
    await log.flush() // goes through
    releaseSize() // the first attempt wakes up
    await new Promise((r) => setTimeout(r, 50))
    expect(lines(dir).filter((r) => r.ev === 'one')).toHaveLength(1)
    expect(lines(dir).map((r) => r.ev)).not.toContain('flush.maybeDuplicate')
  })

  it('starts no new file operation while two earlier ones are still stuck', async () => {
    let started = 0
    const fs: LogFs = {
      ...realLogFs,
      mkdir: async () => undefined,
      size: async () => 0,
      list: async () => [],
      appendFile: () => {
        started++
        return new Promise<void>(() => undefined)
      },
    }
    const log = new DiagnosticsLogger({
      dir: '/d',
      fs,
      writeTimeoutMs: 20,
      retryDelaysMs: [],
      retryBackoffMs: 0,
      switchAfterFailures: 1000,
      onInternalError: () => undefined,
    })
    for (let i = 0; i < 6; i++) {
      log.error('a', 'x')
      await log.flush()
    }
    expect(started).toBe(2)
  })
})

describe('DiagnosticsLogger pause after a failed write, with lines arriving during the retries', () => {
  it('does not start a new attempt inside the pause', async () => {
    const starts: number[] = []
    const fs: LogFs = {
      ...realLogFs,
      mkdir: async () => undefined,
      size: async () => 0,
      list: async () => [],
      appendFile: async () => {
        starts.push(Date.now())
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      },
    }
    const log = new DiagnosticsLogger({
      dir: '/d',
      fs,
      retryDelaysMs: [20, 50], // a write takes ~70 ms to give up: lines arrive meanwhile
      retryBackoffMs: 600,
      switchAfterFailures: 1000,
      flushIntervalMs: 5,
      flushLines: 1,
      onInternalError: () => undefined,
    })
    const until = Date.now() + 1_000
    while (Date.now() < until) {
      log.error('a', 'more')
      await new Promise((r) => setTimeout(r, 5))
    }
    // each failed cycle has 3 tries (0, 20, 70 ms); the next cycle only after the 600 ms pause
    const cycles = starts.filter((t, i) => i === 0 || t - starts[i - 1]! > 300).length
    expect(cycles).toBeLessThanOrEqual(2)
    expect(starts.length).toBeLessThanOrEqual(6)
  })
})

describe('DiagnosticsLogger when the file system hangs: bounds and recovery', () => {
  const quiet = (): ((m: string) => void) => () => undefined

  it('opens at most one folder listing while one is stuck, however many files are given up', async () => {
    let lists = 0
    const fs: LogFs = {
      ...realLogFs,
      mkdir: async () => undefined,
      size: async () => 0,
      list: () => {
        lists++
        return new Promise<string[]>(() => undefined)
      },
      appendFile: async () => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      },
    }
    const log = new DiagnosticsLogger({
      dir: '/d',
      fs,
      retryDelaysMs: [],
      retryBackoffMs: 0,
      switchAfterFailures: 1,
      writeTimeoutMs: 20,
      onInternalError: quiet(),
    })
    for (let i = 0; i < 10; i++) {
      log.error('a', 'x')
      await log.flush()
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(lists).toBe(1)
  })

  it('does not switch files because the drive does not answer: only real write errors count', async () => {
    const fs: LogFs = {
      ...realLogFs,
      mkdir: async () => undefined,
      size: async () => 0,
      list: async () => [],
      appendFile: () => new Promise<void>(() => undefined),
    }
    const log = new DiagnosticsLogger({
      dir: '/d',
      fs,
      retryDelaysMs: [],
      retryBackoffMs: 0,
      switchAfterFailures: 2,
      writeTimeoutMs: 10,
      onInternalError: quiet(),
    })
    const paths = new Set<string>()
    for (let i = 0; i < 10; i++) {
      log.error('a', 'x')
      await log.flush()
      paths.add(log.path)
    }
    // the two timeouts count; the refusals that follow while the operations are stuck do not
    expect(paths.size).toBeLessThanOrEqual(2)
  })

  it('never has more than two operations stuck at once, however long the drive stays silent', async () => {
    let started = 0
    const fs: LogFs = {
      ...realLogFs,
      mkdir: async () => undefined,
      size: async () => 0,
      list: async () => [],
      appendFile: () => {
        started++
        return new Promise<void>(() => undefined) // never answers, and never finishes
      },
    }
    const log = new DiagnosticsLogger({
      dir: '/d',
      fs,
      retryDelaysMs: [],
      retryBackoffMs: 0,
      switchAfterFailures: 1000,
      writeTimeoutMs: 5,
      degradedAfterMs: 1e9,
      onInternalError: quiet(),
    })
    for (let round = 0; round < 40; round++) {
      log.error('a', 'x')
      await log.flush()
      await new Promise((r) => setTimeout(r, 6))
    }
    expect(started).toBe(2)
  })

  it('writes again when the stuck operations finish (they leave the count by themselves)', async () => {
    const dir = tmp()
    const stuck: Array<() => void> = []
    let calls = 0
    const fs: LogFs = {
      ...realLogFs,
      appendFile: (p, t) => {
        if (calls++ < 2) return new Promise<void>((resolve) => stuck.push(resolve))
        return realLogFs.appendFile(p, t)
      },
    }
    const log = new DiagnosticsLogger({
      dir,
      fs,
      retryDelaysMs: [],
      retryBackoffMs: 0,
      switchAfterFailures: 1000,
      writeTimeoutMs: 15,
      degradedAfterMs: 1e9,
      onInternalError: quiet(),
    })
    log.error('a', 'kept')
    await log.flush() // stuck 1
    await log.flush() // stuck 2 (the lines went back each time)
    await log.flush() // refused: two operations are stuck
    expect(calls).toBe(2)
    expect(log.queued).toBe(1)
    for (const release of stuck) release() // the drive answers at last
    await new Promise((r) => setTimeout(r, 10))
    await log.flush()
    expect(lines(dir).map((l) => l.ev)).toContain('kept')
    expect(log.queued).toBe(0)
  })

  it('moves to the second folder when the drive stays silent, without opening more operations on it', async () => {
    const altDir = tmp()
    let primaryStarted = 0
    const fs: LogFs = {
      ...realLogFs,
      appendFile: (p, t) => {
        if (p.startsWith('/dead')) {
          primaryStarted++
          return new Promise<void>(() => undefined)
        }
        return realLogFs.appendFile(p, t)
      },
      mkdir: async (d) => {
        if (d.startsWith('/dead')) return
        return realLogFs.mkdir(d)
      },
      size: async (p) => (p.startsWith('/dead') ? 0 : realLogFs.size(p)),
      list: async (d) => (d.startsWith('/dead') ? [] : realLogFs.list(d)),
    }
    const log = new DiagnosticsLogger({
      dir: '/dead/logs',
      altDir,
      fs,
      retryDelaysMs: [],
      retryBackoffMs: 0,
      switchAfterFailures: 1000,
      writeTimeoutMs: 5,
      degradedAfterMs: 30,
      onInternalError: quiet(),
    })
    log.error('a', 'important')
    for (let round = 0; round < 20; round++) {
      await log.flush()
      await new Promise((r) => setTimeout(r, 8))
    }
    expect(primaryStarted).toBeLessThanOrEqual(2)
    expect(log.path.startsWith(altDir)).toBe(true)
    expect(readFileSync(join(altDir, 'genoffice.jsonl'), 'utf8')).toContain('important')
  })

  it('keeps the duplicate marker until an append has really gone through', async () => {
    const dir = tmp()
    let call = 0
    const fs: LogFs = {
      ...realLogFs,
      appendFile: async (p, t) => {
        call++
        if (call === 1) return new Promise<void>(() => undefined) // times out after being handed over
        if (call === 2) throw new Error('EPERM') // then fails outright
        return realLogFs.appendFile(p, t)
      },
    }
    const log = new DiagnosticsLogger({
      dir,
      fs,
      retryDelaysMs: [],
      retryBackoffMs: 0,
      switchAfterFailures: 1000,
      writeTimeoutMs: 15,
      onInternalError: quiet(),
    })
    log.error('a', 'once')
    await log.flush()
    await new Promise((r) => setTimeout(r, 5))
    await log.flush()
    await new Promise((r) => setTimeout(r, 5))
    await log.flush()
    expect(lines(dir).map((l) => l.ev)).toEqual(['flush.maybeDuplicate', 'once'])
  })

  it('a late append that really lands writes the batch twice, behind a marker (the documented cost)', async () => {
    const dir = tmp()
    let call = 0
    const fs: LogFs = {
      ...realLogFs,
      appendFile: async (p, t) => {
        call++
        if (call === 1) {
          await new Promise((r) => setTimeout(r, 120)) // too slow for the timeout, but it does write
          return realLogFs.appendFile(p, t)
        }
        return realLogFs.appendFile(p, t)
      },
    }
    const log = new DiagnosticsLogger({
      dir,
      fs,
      writeTimeoutMs: 40,
      retryDelaysMs: [],
      retryBackoffMs: 0,
      onInternalError: quiet(),
    })
    log.error('a', 'dup')
    await log.flush() // times out
    await log.flush() // goes through, behind a marker
    await new Promise((r) => setTimeout(r, 200)) // the first one lands too
    const events = lines(dir).map((l) => l.ev)
    expect(events.filter((e) => e === 'dup')).toHaveLength(2)
    expect(events).toContain('flush.maybeDuplicate')
    // the marker comes before the copy that was written second
    expect(events.indexOf('flush.maybeDuplicate')).toBeLessThan(events.lastIndexOf('dup'))
  })

  it('flushSync does not touch a drive that is not answering, and keeps the lines', async () => {
    let syncWrites = 0
    const fs: LogFs = {
      ...realLogFs,
      mkdir: async () => undefined,
      size: async () => 0,
      list: async () => [],
      appendFile: () => new Promise<void>(() => undefined),
      appendFileSync: () => void syncWrites++,
    }
    const log = new DiagnosticsLogger({
      dir: '/d',
      fs,
      retryDelaysMs: [],
      retryBackoffMs: 1e9,
      writeTimeoutMs: 10,
      onInternalError: quiet(),
    })
    log.error('a', 'x')
    await log.flush() // times out: one operation is stuck
    log.flushSync()
    expect(syncWrites).toBe(0)
    expect(log.queued).toBe(1)
  })

  it('a debug line never pushes an info line out of a full queue', () => {
    const log = new DiagnosticsLogger({
      dir: '/d',
      level: 'debug',
      fs: { ...realLogFs, appendFile: () => new Promise<void>(() => undefined) },
      maxQueueBytes: 2_000,
      flushIntervalMs: 1e9,
      flushLines: 1e9,
    })
    for (let i = 0; i < 40; i++) log.info('a', 'info', { pad: 'p'.repeat(40) })
    const before = log.queued
    for (let i = 0; i < 40; i++) log.debug('a', 'debug', { pad: 'p'.repeat(40) })
    expect(log.queued).toBe(before)
  })

  it('close() also writes lines that arrive while the last write is running', async () => {
    const dir = tmp()
    const fs: LogFs = {
      ...realLogFs,
      appendFile: async (p, t) => {
        await new Promise((r) => setTimeout(r, 30))
        return realLogFs.appendFile(p, t)
      },
    }
    const log = new DiagnosticsLogger({ dir, fs, flushIntervalMs: 1e9 })
    log.info('a', 'first')
    const closing = log.close()
    await new Promise((r) => setTimeout(r, 10))
    log.info('a', 'during')
    await closing
    expect(lines(dir).map((l) => l.ev)).toEqual(['first', 'during'])
  })

  it('keeps the errors when a batch is put back under the size cap, and writes them later', async () => {
    const dir = tmp()
    let hang = true
    const fs: LogFs = {
      ...realLogFs,
      appendFile: (p, t) => {
        if (hang) return new Promise<void>(() => undefined)
        return realLogFs.appendFile(p, t)
      },
    }
    const log = new DiagnosticsLogger({
      dir,
      fs,
      maxQueueBytes: 5_000,
      maxLineChars: 1e9,
      writeTimeoutMs: 15,
      retryDelaysMs: [],
      retryBackoffMs: 0,
      switchAfterFailures: 1000,
      flushIntervalMs: 1e9,
      flushLines: 1e9,
      onInternalError: quiet(),
    })
    for (let i = 0; i < 20; i++) log.info('a', 'x', { pad: 'p'.repeat(100) })
    log.error('a', 'keep-me', { pad: 'p'.repeat(100) })
    await log.flush()
    for (let i = 0; i < 100; i++) log.info('a', 'y', { pad: 'p'.repeat(100) })
    log.error('a', 'also-me', { pad: 'p'.repeat(100) })
    hang = false
    await new Promise((r) => setTimeout(r, 5))
    await log.flush()
    const events = lines(dir).map((l) => l.ev)
    expect(events).toContain('keep-me')
    expect(events).toContain('also-me')
  })
})

describe('DiagnosticsLogger rotation with a stuck slot', () => {
  it('stops shifting at the first slot that cannot be replaced, so no file is lost', async () => {
    const dir = tmp()
    for (let i = 1; i <= 4; i++) writeFileSync(join(dir, `genoffice.${i}.jsonl`), `old-${i}\n`)
    writeFileSync(join(dir, 'genoffice.jsonl'), 'x'.repeat(400) + '\n')
    const fs: LogFs = {
      ...realLogFs,
      rename: async (from, to) => {
        // the last slot is held by another program
        if (to.endsWith('genoffice.4.jsonl'))
          throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
        return realLogFs.rename(from, to)
      },
    }
    const log = new DiagnosticsLogger({
      dir,
      fs,
      maxBytes: 300,
      files: 5,
      sleep: async () => undefined,
      onInternalError: () => undefined,
    })
    log.info('a', 'one')
    await log.flush()
    // .3 was not unlinked or overwritten, and nothing below it moved
    for (let i = 1; i <= 4; i++) {
      expect(readFileSync(join(dir, `genoffice.${i}.jsonl`), 'utf8')).toBe(`old-${i}\n`)
    }
    // the file that was live is kept as a set-aside file, not dropped
    const aside = readdirSync(dir).filter((f) => /^genoffice\.\d{10,}\.jsonl$/.test(f))
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(dir, aside[0]!), 'utf8')).toBe('x'.repeat(400) + '\n')
  })
})

describe('DiagnosticsLogger rotation in a chain with held files', () => {
  it('does not lose a file when a slot in the middle is held, over several rotations', async () => {
    const dir = tmp()
    for (let i = 1; i <= 4; i++) writeFileSync(join(dir, `genoffice.${i}.jsonl`), `old-${i}\n`)
    const held = (p: string): boolean => p.endsWith('genoffice.2.jsonl')
    const fs: LogFs = {
      ...realLogFs,
      rename: async (from, to) => {
        // slot 2 is held by another program: it cannot be moved or replaced
        if (held(from) || held(to)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
        return realLogFs.rename(from, to)
      },
    }
    const log = new DiagnosticsLogger({
      dir,
      fs,
      maxBytes: 200,
      files: 5,
      flushLines: 1,
      sleep: async () => undefined,
      onInternalError: () => undefined,
    })
    for (let i = 0; i < 30; i++) {
      log.info('a', `event-${i}`, { pad: 'p'.repeat(60) })
      await log.flush()
      await log.settled()
    }
    // the shift stops at the held slot: it and everything below it stay as they were
    expect(readFileSync(join(dir, 'genoffice.1.jsonl'), 'utf8')).toBe('old-1\n')
    expect(readFileSync(join(dir, 'genoffice.2.jsonl'), 'utf8')).toBe('old-2\n')
    // above it, .3 moved up once (the old .4 was the one to drop) and nothing was lost after that
    expect(readFileSync(join(dir, 'genoffice.4.jsonl'), 'utf8')).toBe('old-3\n')
    const names = readdirSync(dir).filter((f) => /^genoffice\.\d{10,}\.jsonl$/.test(f))
    expect(names.length).toBeLessThanOrEqual(4)
    const newest = readdirSync(dir)
      .filter((f) => f === 'genoffice.jsonl' || /^genoffice\.\d{10,}\.jsonl$/.test(f))
      .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n'))
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l).ev)
    expect(newest).toContain('event-29')
  })

  it('shifts a healthy chain in order over many rotations', async () => {
    const dir = tmp()
    const log = new DiagnosticsLogger({ dir, maxBytes: 300, files: 4, flushLines: 1 })
    for (let i = 0; i < 40; i++) {
      log.info('a', `event-${String(i).padStart(2, '0')}`, { pad: 'p'.repeat(60) })
      await log.flush()
    }
    await log.settled()
    const first = (file: string): number => Number((lines(dir, file)[0].ev as string).split('-')[1])
    // oldest content is in the highest slot, newest in the live file
    expect(first('genoffice.3.jsonl')).toBeLessThan(first('genoffice.2.jsonl'))
    expect(first('genoffice.2.jsonl')).toBeLessThan(first('genoffice.1.jsonl'))
    expect(first('genoffice.1.jsonl')).toBeLessThan(first('genoffice.jsonl'))
    expect(lines(dir).at(-1).ev).toBe('event-39')
  })
})

describe('DiagnosticsLogger history kept when the last slot is held', () => {
  const run = async (hold: boolean): Promise<number> => {
    const dir = tmp()
    const fs: LogFs = {
      ...realLogFs,
      rename: async (from, to) => {
        if (hold && (to.endsWith('genoffice.4.jsonl') || from.endsWith('genoffice.4.jsonl')))
          throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
        return realLogFs.rename(from, to)
      },
    }
    const log = new DiagnosticsLogger({
      dir,
      fs,
      maxBytes: 400,
      files: 5,
      flushLines: 1,
      sleep: async () => undefined,
      onInternalError: () => undefined,
    })
    for (let i = 0; i < 60; i++) {
      log.info('a', `event-${i}`, { pad: 'p'.repeat(60) })
      await log.flush()
      await log.settled()
    }
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n'))
      .filter((l) => l.startsWith('{')).length
  }

  it('keeps about as much recent history as a chain that turns normally', async () => {
    const normal = await run(false)
    const held = await run(true)
    // set-aside files take the place of the blocked slots, so the history is not squeezed
    expect(held).toBeGreaterThanOrEqual(normal - 2)
  })
})

describe('DiagnosticsLogger queue size after a failed batch', () => {
  it('keeps the size cap when a batch is put back, and never drops an error for it', async () => {
    const fs: LogFs = {
      ...realLogFs,
      mkdir: async () => undefined,
      size: async () => 0,
      list: async () => [],
      appendFile: () => new Promise<void>(() => undefined),
    }
    const log = new DiagnosticsLogger({
      dir: '/d',
      fs,
      maxQueueBytes: 5_000,
      maxQueue: 1_000_000,
      maxLineChars: 1e9,
      writeTimeoutMs: 20,
      retryDelaysMs: [],
      retryBackoffMs: 0,
      switchAfterFailures: 1000,
      flushIntervalMs: 1e9,
      flushLines: 1e9,
      onInternalError: () => undefined,
    })
    for (let i = 0; i < 20; i++) log.info('a', 'x', { pad: 'p'.repeat(100) })
    log.error('a', 'keep-me', { pad: 'p'.repeat(100) })
    await log.flush() // the batch is taken out, the write times out, the batch goes back
    for (let i = 0; i < 100; i++) log.info('a', 'y', { pad: 'p'.repeat(100) })
    await log.flush()
    log.error('a', 'also-me', { pad: 'p'.repeat(100) })
    // lines are about 200 characters: a 5,000 character cap holds about 25 of them
    expect(log.queued).toBeLessThanOrEqual(26)
    expect(log.stats().droppedTotal + log.droppedCount).toBeGreaterThan(0)
  })
})

describe('DiagnosticsLogger backoff under a permanent write failure', () => {
  it('tries to write only a few times in a second while lines keep arriving (timer-driven)', async () => {
    let attempts = 0
    const fs: LogFs = {
      ...realLogFs,
      mkdir: async () => undefined,
      size: async () => 0,
      list: async () => [],
      appendFile: async () => {
        attempts++
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      },
    }
    const log = new DiagnosticsLogger({
      dir: '/d',
      fs,
      retryDelaysMs: [],
      retryBackoffMs: 500,
      switchAfterFailures: 1000,
      flushIntervalMs: 5,
      flushLines: 1,
      onInternalError: () => undefined,
    })
    const until = Date.now() + 1_200
    while (Date.now() < until) {
      log.error('a', 'more')
      await new Promise((r) => setTimeout(r, 5))
    }
    // one try at the start, then at most one per 500 ms
    expect(attempts).toBeLessThanOrEqual(4)
  })
})

describe('DiagnosticsLogger retry and exit races', () => {
  it('waits the backoff after a failed batch: new lines do not start a retry before it', async () => {
    const dir = tmp()
    const attempts: number[] = []
    let broken = true
    const fs: LogFs = {
      ...realLogFs,
      appendFile: async (p, t) => {
        attempts.push(Date.now())
        if (broken) throw new Error('EPERM')
        return realLogFs.appendFile(p, t)
      },
    }
    const log = new DiagnosticsLogger({
      dir,
      fs,
      retryDelaysMs: [],
      retryBackoffMs: 300,
      flushIntervalMs: 5,
      flushLines: 1,
      onInternalError: () => undefined,
    })
    log.error('a', 'first')
    await log.flush()
    expect(attempts).toHaveLength(1)
    // lines keep arriving, as they do in a live app
    const until = Date.now() + 200
    while (Date.now() < until) {
      log.info('a', 'more')
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(attempts).toHaveLength(1)
    broken = false
    await new Promise((r) => setTimeout(r, 200))
    expect(attempts.length).toBeGreaterThan(1)
    expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(280)
    await log.flush()
    expect(lines(dir).map((l) => l.ev)).toContain('first')
  })

  it('a successful retry does not write the batch twice', async () => {
    const dir = tmp()
    let failures = 2
    const fs: LogFs = {
      ...realLogFs,
      appendFile: async (p, t) => {
        if (failures-- > 0) throw new Error('EBUSY')
        return realLogFs.appendFile(p, t)
      },
    }
    const log = new DiagnosticsLogger({ dir, fs, sleep: async () => undefined })
    log.error('a', 'once')
    await log.flush()
    expect(lines(dir).map((l) => l.ev)).toEqual(['once'])
  })

  it('starts the next chunk on a fresh line after a write that failed half way', async () => {
    const dir = tmp()
    let first = true
    const fs: LogFs = {
      ...realLogFs,
      appendFile: async (p, t) => {
        if (first) {
          first = false
          await realLogFs.appendFile(p, t.slice(0, 20)) // a torn write, then the error
          throw new Error('ENOSPC')
        }
        return realLogFs.appendFile(p, t)
      },
    }
    const log = new DiagnosticsLogger({ dir, fs, sleep: async () => undefined })
    log.error('a', 'whole')
    await log.flush()
    const rows = readFileSync(join(dir, 'genoffice.jsonl'), 'utf8').split('\n').filter(Boolean)
    expect(rows.filter((r) => r.startsWith('{"ts"') && r.endsWith('}'))).toHaveLength(1)
    expect(JSON.parse(rows.at(-1)!).ev).toBe('whole')
  })

  it('flushSync during the awaits before the append: the old writer gives the batch up, nothing doubles', async () => {
    const dir = tmp()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const fs: LogFs = {
      ...realLogFs,
      size: async (p) => {
        await gate // the writer is still preparing: nothing has been appended yet
        return realLogFs.size(p)
      },
    }
    const log = new DiagnosticsLogger({ dir, fs, flushIntervalMs: 1e9 })
    log.error('a', 'one')
    log.error('a', 'two')
    const pending = log.flush()
    await new Promise((r) => setTimeout(r, 20))
    log.flushSync()
    release()
    await pending
    const events = lines(dir).map((l) => l.ev)
    expect(events.filter((e) => e === 'one')).toHaveLength(1)
    expect(events.filter((e) => e === 'two')).toHaveLength(1)
  })

  it('flushSync while an append is truly in flight: the batch is written again behind a marker (known, documented)', async () => {
    const dir = tmp()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const fs: LogFs = {
      ...realLogFs,
      appendFile: async (p, t) => {
        await gate // the operating system finishes the write after the process has moved on
        return realLogFs.appendFile(p, t)
      },
    }
    const log = new DiagnosticsLogger({ dir, fs, flushIntervalMs: 1e9 })
    log.error('a', 'in-flight')
    const pending = log.flush()
    await new Promise((r) => setTimeout(r, 20))
    log.error('a', 'newer')
    log.flushSync()
    expect(lines(dir).map((l) => l.ev)).toEqual(['flush.resent', 'in-flight', 'newer'])
    release()
    await pending
    const events = lines(dir).map((l) => l.ev)
    // the late write lands once more: a repeat of 'in-flight' behind the marker is the known cost
    expect(events.filter((e) => e === 'newer')).toHaveLength(1)
    expect(events[0]).toBe('flush.resent')
  })

  it('flushSync that cannot write puts the lines back, and they are written on the next flush', async () => {
    const dir = tmp()
    let broken = true
    const fs: LogFs = {
      ...realLogFs,
      appendFileSync: (p, t) => {
        if (broken) throw new Error('EBUSY')
        realLogFs.appendFileSync(p, t)
      },
    }
    const log = new DiagnosticsLogger({
      dir,
      fs,
      flushIntervalMs: 1e9,
      onInternalError: () => undefined,
    })
    log.error('a', 'at-exit')
    log.flushSync()
    broken = false
    await log.flush()
    expect(lines(dir).map((l) => l.ev)).toEqual(['at-exit'])
  })
})

describe('DiagnosticsLogger with a real lock held by another process (Windows only)', () => {
  const holder = (file: string, share: 'ReadWrite' | 'Read'): ChildProcess =>
    spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$f=[System.IO.File]::Open('${file}','Open','ReadWrite','${share}'); Write-Output 'locked'; [Console]::In.ReadLine() | Out-Null; $f.Close()`,
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    )

  const waitLocked = (child: ChildProcess): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('lock holder did not start')), 15_000)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.stdout!.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('locked')) {
          clearTimeout(timer)
          resolve()
        }
      })
    })

  /** Lets go of the file and waits until the holder has really exited, so the folder can be removed. */
  const release = (child: ChildProcess): Promise<void> =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve()
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 5_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.stdin!.end('\n')
    })

  it.runIf(process.platform === 'win32')(
    'moves to a new file when another process holds the live file without the right to write',
    async () => {
      const dir = tmp()
      const live = join(dir, 'genoffice.jsonl')
      writeFileSync(live, 'seed\n')
      const child = holder(live, 'Read')
      try {
        await waitLocked(child)
        const log = new DiagnosticsLogger({
          dir,
          retryDelaysMs: [],
          retryBackoffMs: 0,
          onInternalError: () => undefined,
        })
        for (let i = 0; i < 6; i++) {
          log.error('a', `event-${i}`)
          await log.flush()
        }
        const files = readdirSync(dir).filter((f) => /^genoffice\.\d{10,}\.jsonl$/.test(f))
        expect(files.length).toBeGreaterThan(0)
        expect(files.length).toBeLessThanOrEqual(3)
        const all = files.flatMap((f) =>
          readFileSync(join(dir, f), 'utf8')
            .split('\n')
            .filter((l) => l.startsWith('{'))
            .map((l) => JSON.parse(l).ev as string),
        )
        for (let i = 0; i < 6; i++) expect(all).toContain(`event-${i}`)
      } finally {
        await release(child)
      }
    },
    60_000,
  )

  it.runIf(process.platform === 'win32')(
    'keeps writing and loses no line while another process holds the live file without the right to rename it',
    async () => {
      const dir = tmp()
      const live = join(dir, 'genoffice.jsonl')
      writeFileSync(live, 'x'.repeat(2000) + '\n')
      const child = holder(live, 'ReadWrite')
      try {
        await waitLocked(child)
        const log = new DiagnosticsLogger({
          dir,
          maxBytes: 1500,
          files: 50,
          flushLines: 1,
          sleep: async () => undefined,
          onInternalError: () => undefined,
        })
        for (let i = 0; i < 60; i++) {
          log.info('a', `event-${i}`, { pad: 'w'.repeat(60) })
          await log.flush()
        }
        const all = readdirSync(dir)
          .filter((f) => f.endsWith('.jsonl'))
          .flatMap((f) =>
            readFileSync(join(dir, f), 'utf8')
              .split('\n')
              .filter((l) => l.startsWith('{"ts"'))
              .map((l) => JSON.parse(l).ev as string),
          )
        for (let i = 0; i < 60; i++) expect(all).toContain(`event-${i}`)
        // the held file itself was not emptied
        expect(readFileSync(live, 'utf8').startsWith('xxxx')).toBe(true)
      } finally {
        await release(child)
      }
    },
    60_000,
  )
})
