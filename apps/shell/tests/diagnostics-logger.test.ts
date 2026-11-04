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
    expect(reports.some((m) => m.includes('could not rotate'))).toBe(true)
    // the cause is reported with the path, and the newest events are on disk
    const all = readdirSync(dir)
      .flatMap((f) => lines(dir, f))
      .map((l) => l.ev)
    expect(all).toContain('event-9')
    expect(log.stats().internalErrors).toBeGreaterThan(0)
  })

  it('deletes or empties the live file when it cannot be moved, so it is not found full again', async () => {
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
      onInternalError: () => undefined,
    })
    for (let i = 0; i < 12; i++) {
      log.info('a', `event-${i}`, { pad: 'y'.repeat(50) })
      await log.flush()
    }
    expect(log.path).toBe(join(dir, 'genoffice.jsonl'))
    expect(readdirSync(dir)).toEqual(['genoffice.jsonl'])
    expect(readFileSync(join(dir, 'genoffice.jsonl')).length).toBeLessThan(900)
  })

  it('falls back to a new file only when the live one can neither move nor be removed, and prunes old ones', async () => {
    const dir = tmp()
    for (const ts of ['1700000000001', '1700000000002', '1700000000003']) {
      writeFileSync(join(dir, `genoffice.${ts}.jsonl`), 'old\n')
    }
    writeFileSync(join(dir, 'genoffice.jsonl'), 'x'.repeat(400) + '\n')
    const locked = (p: string): boolean => p.endsWith('genoffice.jsonl')
    const fs: LogFs = {
      ...realLogFs,
      rename: async (from, to) => {
        if (locked(from)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
        return realLogFs.rename(from, to)
      },
      unlink: async (p) => {
        if (locked(p)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
        return realLogFs.unlink(p)
      },
      truncate: async () => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      },
    }
    const reports: string[] = []
    const log = new DiagnosticsLogger({
      dir,
      fs,
      maxBytes: 300,
      flushLines: 1,
      now: () => new Date(1700000000999),
      onInternalError: (m) => void reports.push(m),
    })
    log.info('a', 'one', { pad: 'z'.repeat(50) })
    await log.flush()
    const orphans = readdirSync(dir).filter((f) => /^genoffice\.\d{10,}\.jsonl$/.test(f))
    // the three old ones were pruned to the newest one (at start), then the new one was added
    expect(orphans.length).toBeLessThanOrEqual(3)
    expect(orphans).toContain('genoffice.1700000000999.jsonl')
    expect(orphans).not.toContain('genoffice.1700000000001.jsonl')
    expect(reports.some((m) => m.includes('continuing in'))).toBe(true)
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

describe('DiagnosticsLogger on a real, held file (Windows only)', () => {
  it.runIf(process.platform === 'win32')(
    'keeps every event when the live file cannot be moved',
    async () => {
      const dir = tmp()
      const log = new DiagnosticsLogger({
        dir,
        maxBytes: 400,
        flushLines: 1,
        onInternalError: () => undefined,
      })
      for (let i = 0; i < 20; i++) {
        log.info('a', `event-${i}`, { pad: 'w'.repeat(60) })
        await log.flush()
      }
      const all = readdirSync(dir)
        .flatMap((f) => lines(dir, f))
        .map((l) => l.ev)
      for (let i = 0; i < 20; i++) expect(all).toContain(`event-${i}`)
    },
  )
})
