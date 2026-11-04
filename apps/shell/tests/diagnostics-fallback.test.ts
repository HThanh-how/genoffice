import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FALLBACK_FILE,
  FallbackReporter,
  type FallbackFs,
} from '../src/main/diagnostics/fallback-report'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'diag-fb-'))
  dirs.push(d)
  return d
}
const text = (dir: string): string => readFileSync(join(dir, FALLBACK_FILE), 'utf8')

describe('the fallback channel for logger problems', () => {
  it('writes the cause (code and message) to a plain file next to the logs', async () => {
    const dir = tmp()
    const r = new FallbackReporter({ dir, echo: false })
    r.report(
      'could not rotate C:\\logs\\a.jsonl',
      Object.assign(new Error('busy'), { code: 'EBUSY' }),
    )
    await r.idle()
    expect(text(dir)).toContain('could not rotate')
    expect(text(dir)).toContain('code=EBUSY')
    expect(text(dir)).toContain('busy')
  })

  it('writes at most one line per interval and counts what it skipped', async () => {
    const dir = tmp()
    let now = 1_000_000
    const r = new FallbackReporter({ dir, echo: false, now: () => now })
    for (let i = 0; i < 50; i++) r.report(`problem ${i}`)
    now += 11_000
    r.report('later')
    await r.idle()
    const lines = text(dir).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('(+49 skipped)')
    expect(r.stats()).toMatchObject({ total: 51, written: 2, suppressed: 49 })
  })

  it('keeps the rate limit when the fallback file itself cannot be written', async () => {
    let attempts = 0
    const fs: FallbackFs = {
      size: async () => 0,
      mkdir: async () => undefined,
      append: async () => {
        attempts++
        throw new Error('drive is gone')
      },
      move: async () => undefined,
    }
    let now = 0
    const r = new FallbackReporter({ dir: '/x', echo: false, fs, now: () => now })
    for (let i = 0; i < 100; i++) r.report(`problem ${i}`)
    await r.idle()
    expect(attempts).toBe(1)
    expect(r.stats().failed).toBe(1)
    now += 10_001
    r.report('later')
    await r.idle()
    expect(attempts).toBe(2)
  })

  it('does not block: report returns before any file work is done', () => {
    let touched = 0
    const fs: FallbackFs = {
      size: async () => {
        touched++
        return 0
      },
      mkdir: async () => void touched++,
      append: async () => void touched++,
      move: async () => void touched++,
    }
    const r = new FallbackReporter({ dir: '/x', echo: false, fs })
    r.report('problem')
    expect(touched).toBe(0)
  })

  it('stops growing at the size cap', async () => {
    const dir = tmp()
    let now = 0
    const r = new FallbackReporter({ dir, echo: false, now: () => now, maxBytes: 200 })
    for (let i = 0; i < 20; i++) {
      now += 20_000
      r.report(`a fairly long problem description number ${i}`)
      await r.idle()
    }
    expect(readFileSync(join(dir, FALLBACK_FILE)).length).toBeLessThan(400)
  })

  it('moves a file that is already full at the start of the run to .old, so it can speak again', async () => {
    const dir = tmp()
    writeFileSync(join(dir, FALLBACK_FILE), 'x'.repeat(300))
    const r = new FallbackReporter({ dir, echo: false, maxBytes: 200 })
    r.report('new run problem')
    await r.idle()
    expect(text(dir)).toContain('new run problem')
    expect(existsSync(join(dir, `${FALLBACK_FILE}.old`))).toBe(true)
  })

  it('never throws, even when the console and the folder are unusable', () => {
    const r = new FallbackReporter({
      dir: '/x',
      fs: {
        size: async () => {
          throw new Error('x')
        },
        mkdir: async () => undefined,
        append: async () => undefined,
        move: async () => undefined,
      },
    })
    const original = console.error
    console.error = () => {
      throw new Error('no console')
    }
    try {
      expect(() => r.report('problem')).not.toThrow()
    } finally {
      console.error = original
    }
  })

  it('does not write secrets that ended up in an error message', async () => {
    const dir = tmp()
    const r = new FallbackReporter({ dir, echo: false })
    r.report('failed', new Error('Bearer abcdefghijklmnop1234'))
    await r.idle()
    expect(text(dir)).not.toContain('abcdefghijklmnop1234')
  })

  it('falls back to the other folder when the first cannot be written, and stays there', async () => {
    const written: string[] = []
    const fs: FallbackFs = {
      size: async () => 0,
      mkdir: async (dir) => {
        if (dir === '/primary') throw new Error('read-only')
      },
      append: async (path) => void written.push(path),
      move: async () => undefined,
    }
    let now = 0
    const r = new FallbackReporter({
      dir: '/primary',
      altDir: '/alt',
      echo: false,
      fs,
      now: () => now,
    })
    r.report('one')
    await r.idle()
    now += 20_000
    r.report('two')
    await r.idle()
    expect(written).toHaveLength(2)
    expect(written.every((p) => p.replace(/\\/g, '/').startsWith('/alt/'))).toBe(true)
    expect(r.path.replace(/\\/g, '/')).toContain('/alt/')
  })

  it('gives up a hanging drive after the timeout instead of holding the next lines for ever', async () => {
    const fs: FallbackFs = {
      size: () => new Promise<number>(() => undefined),
      mkdir: async () => undefined,
      append: async () => undefined,
      move: async () => undefined,
    }
    let now = 0
    const r = new FallbackReporter({ dir: '/x', echo: false, fs, fsTimeoutMs: 30, now: () => now })
    r.report('one')
    await r.idle()
    expect(r.stats().failed).toBe(1)
    now += 20_000
    r.report('two')
    await r.idle() // the chain is not stuck behind the first
    expect(r.stats().failed).toBe(2)
  })
})
