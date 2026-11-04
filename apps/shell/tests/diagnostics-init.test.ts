import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultFallbackDir,
  getFallbackReporter,
  getLogger,
  initDiagnostics,
  levelFromEnv,
  log,
  resetDiagnosticsForTests,
} from '../src/main/diagnostics'
import { DiagnosticsLogger } from '../src/main/diagnostics/logger'

const dirs: string[] = []
afterEach(() => {
  resetDiagnosticsForTests()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'diag-init-'))
  dirs.push(d)
  return d
}
const read = (dir: string): any[] =>
  readFileSync(join(dir, 'logs', 'genoffice.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))

describe('initDiagnostics', () => {
  it('replays what was logged before init, with the original times, in order', async () => {
    const dir = tmp()
    log.info('app', 'early-1')
    await new Promise((r) => setTimeout(r, 15))
    log.warn('app', 'early-2')
    const logger = initDiagnostics({ userDataDir: dir, version: '9.9.9', env: {} })!
    log.info('app', 'late')
    await logger.flush()
    const rows = read(dir)
    expect(rows.map((r) => r.ev)).toEqual(['early-1', 'early-2', 'late'])
    expect(rows[0].ver).toBe('9.9.9')
    expect(Date.parse(rows[1].ts) - Date.parse(rows[0].ts)).toBeGreaterThanOrEqual(10)
  })

  it('returns the same logger when called twice', () => {
    const dir = tmp()
    const a = initDiagnostics({ userDataDir: dir, version: '1', env: {} })
    expect(initDiagnostics({ userDataDir: dir, version: '2', env: {} })).toBe(a)
    expect(getLogger()).toBe(a)
  })

  it('GENOFFICE_NO_DIAG_LOG=1 writes nothing and drops the held lines', () => {
    const dir = tmp()
    log.info('app', 'early')
    expect(
      initDiagnostics({ userDataDir: dir, version: '1', env: { GENOFFICE_NO_DIAG_LOG: '1' } }),
    ).toBeUndefined()
    log.info('app', 'late')
    expect(readdirSync(dir)).toEqual([])
    expect(getLogger()).toBeUndefined()
  })

  it('takes the commit from GENOFFICE_COMMIT and the level from GENOFFICE_LOG_LEVEL', async () => {
    const dir = tmp()
    const logger = initDiagnostics({
      userDataDir: dir,
      version: '1',
      env: { GENOFFICE_COMMIT: 'abc123', GENOFFICE_LOG_LEVEL: 'warn' },
    })!
    log.info('app', 'hidden')
    log.error('app', 'shown')
    await logger.flush()
    const rows = read(dir)
    expect(rows.map((r) => r.ev)).toEqual(['shown'])
    expect(rows[0].commit).toBe('abc123')
  })

  it('verbose mode is off by default and turns on with GENOFFICE_LOG_VERBOSE=1', () => {
    expect(initDiagnostics({ userDataDir: tmp(), version: '1', env: {} })!.verbose).toBe(false)
    resetDiagnosticsForTests()
    expect(
      initDiagnostics({ userDataDir: tmp(), version: '1', env: { GENOFFICE_LOG_VERBOSE: '1' } })!
        .verbose,
    ).toBe(true)
  })

  it('puts the fallback file outside userData, in the local application data folder', () => {
    expect(defaultFallbackDir({ LOCALAPPDATA: 'C:\\Users\\An\\AppData\\Local' })).toMatch(
      /Users.An.AppData.Local.GenOffice.logs$/,
    )
    expect(defaultFallbackDir({})).toContain('GenOffice')
    const dir = tmp()
    const fallback = join(dir, 'elsewhere')
    initDiagnostics({ userDataDir: join(dir, 'ud'), version: '1', fallbackDir: fallback, env: {} })
    expect(getFallbackReporter()?.path).toBe(join(fallback, 'genoffice-logger-errors.txt'))
  })

  it('log.span before init does nothing and does not throw', () => {
    expect(() => log.span('ipc', 'x').end()).not.toThrow()
  })

  it('parses levels', () => {
    expect(levelFromEnv('WARN')).toBe('warn')
    expect(levelFromEnv('nonsense')).toBeUndefined()
  })
})

describe('a steady flood on a real disk', () => {
  it('loses nothing at 50 lines per turn of the loop with the default settings', async () => {
    const dir = tmp()
    const logger = new DiagnosticsLogger({ dir: join(dir, 'logs') })
    for (let tick = 0; tick < 400; tick++) {
      for (let i = 0; i < 50; i++) logger.info('load', 'line', { tick, i })
      await new Promise((r) => setImmediate(r))
    }
    await logger.flush()
    const files = readdirSync(join(dir, 'logs')).filter((f) => f.endsWith('.jsonl'))
    let total = 0
    for (const f of files) {
      total += readFileSync(join(dir, 'logs', f), 'utf8')
        .trim()
        .split('\n')
        .filter((l) => !l.includes('"ev":"dropped"')).length
    }
    expect(logger.stats().droppedTotal).toBe(0)
    expect(total).toBe(20_000)
  })
})
