import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import {
  applyIgnorePolicySnapshotDetailed,
  clearGenOfficeIgnoreCache,
  evaluateIgnore,
  getIgnorePolicySnapshot,
  globToRegex,
  mayContainExplicitAllow,
  readGenOfficeIgnoreDetailed,
  refreshGenOfficeIgnoreForRoot,
  setActiveIgnoreRules,
  setIgnoreStoragePath,
  setIndexingPolicyMode,
  setKnownRootsResolver,
  DEFAULT_IGNORE_RULES,
} from '../src/main/document-memory/ignore-policy'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: vi.fn(actual.existsSync) }
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-ignore-hot-'))
  setIgnoreStoragePath(join(dir, 'policy.json'))
  setActiveIgnoreRules([...DEFAULT_IGNORE_RULES])
  setIndexingPolicyMode('standard')
  setKnownRootsResolver(() => [dir])
  clearGenOfficeIgnoreCache()
})
afterEach(() => {
  clearGenOfficeIgnoreCache()
  rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('ignore evaluation during a large scan', () => {
  it('keeps component matching while avoiding repeated unanchored searches on long paths', () => {
    const regex = globToRegex('*.tmp')
    expect(regex.source.startsWith('^')).toBe(true)
    expect(regex.test('/docs/cache.tmp/report.docx')).toBe(true)
    expect(regex.test('/docs/cache.tmpx/report.docx')).toBe(false)
    expect(regex.test('report.tmp')).toBe(true)

    const path = `${'/long-directory-name'.repeat(100)}/report.docx`
    const start = performance.now()
    for (let i = 0; i < 100; i++) expect(regex.test(path)).toBe(false)
    expect(performance.now() - start).toBeLessThan(100)
  })

  it('checks a shared root once per event-loop turn rather than once per cold path', async () => {
    vi.mocked(existsSync).mockClear()
    for (let i = 0; i < 1000; i++) {
      expect(evaluateIgnore(join(dir, `report-${i}.docx`), dir).ignored).toBe(false)
    }
    const ignoreFile = join(dir, '.genofficeignore')
    const checks = () => vi.mocked(existsSync).mock.calls.filter(([p]) => p === ignoreFile).length
    expect(checks()).toBe(1)

    await nextTurn()
    evaluateIgnore(join(dir, 'next-turn.docx'), dir)
    expect(checks()).toBe(2)
  })

  it('applies watcher refreshes to warm evaluation results immediately', () => {
    const path = join(dir, 'report.docx')
    expect(evaluateIgnore(path, dir).ignored).toBe(false)
    writeFileSync(join(dir, '.genofficeignore'), '*.docx\n')
    expect(refreshGenOfficeIgnoreForRoot(dir)).toBe(true)
    expect(evaluateIgnore(path, dir).ignored).toBe(true)
  })

  it('invalidates warm results when a worker replica reads a changed root policy', () => {
    const snapshot = getIgnorePolicySnapshot([dir])
    expect(
      applyIgnorePolicySnapshotDetailed({ ...snapshot, version: snapshot.version + 1 }).applied,
    ).toBe(true)
    const path = join(dir, 'report.docx')
    expect(evaluateIgnore(path, dir).ignored).toBe(false)
    writeFileSync(join(dir, '.genofficeignore'), '*.docx\n')
    readGenOfficeIgnoreDetailed(dir)
    expect(evaluateIgnore(path, dir).ignored).toBe(true)
  })

  it('keeps globstar allow rescues inside the selected root and literal path boundaries', () => {
    const inner = join(dir, 'inner')
    mkdirSync(inner)
    writeFileSync(join(inner, '.genofficeignore'), '!**/2026/reports/**\n')
    const allowed = join(inner, 'work/2026/reports')
    expect(mayContainExplicitAllow(allowed, inner)).toBe(true)
    expect(mayContainExplicitAllow(allowed, dir)).toBe(false)
    expect(mayContainExplicitAllow(join(inner, 'work/2026/.cache'), inner)).toBe(false)
    expect(mayContainExplicitAllow(join(inner, 'work/2026/reports-old'), inner)).toBe(false)

    setActiveIgnoreRules([
      ...DEFAULT_IGNORE_RULES,
      { id: 'nested', pattern: '**/2026/reports/**', enabled: true, scope: inner, action: 'allow' },
    ])
    expect(mayContainExplicitAllow(allowed, inner)).toBe(true)
    expect(mayContainExplicitAllow(join(dir, 'work/2026/reports'), dir)).toBe(false)
  })
})
