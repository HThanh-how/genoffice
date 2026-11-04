import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FALLBACK_FILE, FallbackReporter } from '../src/main/diagnostics/fallback-report'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'diag-fb-'))
  dirs.push(d)
  return d
}

describe('the fallback channel for logger problems', () => {
  it('writes the cause (code and message) to a plain file next to the logs', () => {
    const dir = tmp()
    const r = new FallbackReporter({ dir, echo: false })
    r.report(
      'could not rotate C:\\logs\\a.jsonl',
      Object.assign(new Error('busy'), { code: 'EBUSY' }),
    )
    const text = readFileSync(join(dir, FALLBACK_FILE), 'utf8')
    expect(text).toContain('could not rotate')
    expect(text).toContain('code=EBUSY')
    expect(text).toContain('busy')
  })

  it('writes at most one line per interval and counts what it skipped', () => {
    const dir = tmp()
    let now = 1_000_000
    const r = new FallbackReporter({ dir, echo: false, now: () => now })
    for (let i = 0; i < 50; i++) r.report(`problem ${i}`)
    now += 11_000
    r.report('later')
    const lines = readFileSync(join(dir, FALLBACK_FILE), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('(+49 skipped)')
    expect(r.stats()).toMatchObject({ total: 51, written: 2, suppressed: 49 })
  })

  it('stops growing at the size cap', () => {
    const dir = tmp()
    let now = 0
    const r = new FallbackReporter({ dir, echo: false, now: () => now, maxBytes: 200 })
    for (let i = 0; i < 20; i++) {
      now += 20_000
      r.report(`a fairly long problem description number ${i}`)
    }
    expect(readFileSync(join(dir, FALLBACK_FILE)).length).toBeLessThan(400)
  })

  it('never throws, even when the folder cannot be written', () => {
    const r = new FallbackReporter({
      dir: '/x',
      echo: false,
      fs: {
        size: () => 0,
        mkdirSync: () => {
          throw new Error('read-only')
        },
        appendFileSync: () => undefined,
      },
    })
    expect(() => r.report('problem')).not.toThrow()
  })

  it('does not write secrets that ended up in an error message', () => {
    const dir = tmp()
    const r = new FallbackReporter({ dir, echo: false })
    r.report('failed', new Error('Bearer abcdefghijklmnop1234'))
    expect(readFileSync(join(dir, FALLBACK_FILE), 'utf8')).not.toContain('abcdefghijklmnop1234')
  })
})
