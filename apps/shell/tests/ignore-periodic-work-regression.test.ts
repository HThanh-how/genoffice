import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearGenOfficeIgnoreCache,
  evaluateIgnore,
  getIgnorePolicyGeneration,
  invalidateKnownRootsCache,
  isPathIgnored,
  resolveIndexedRoot,
  setActiveIgnoreRules,
  setIgnoreStoragePath,
  setIndexingPolicyMode,
  setKnownRootsResolver,
  DEFAULT_IGNORE_RULES,
} from '../src/main/document-memory/ignore-policy'

// The main thread sat ~30 % busy with an idle user because every ignore evaluation (even a cache hit)
// re-resolved the known-root list through the folder registry, the evaluation cache was smaller than the
// corpus (so every periodic pass was all misses) and the per-root `.genofficeignore` cache was smaller
// than the root count (so a re-read counted as a policy change and cleared every cache again).

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-ignore-periodic-'))
  setIgnoreStoragePath(join(dir, 'policy.json'))
  setActiveIgnoreRules([...DEFAULT_IGNORE_RULES])
  setIndexingPolicyMode('standard')
  clearGenOfficeIgnoreCache()
})
afterEach(() => {
  vi.restoreAllMocks()
  setKnownRootsResolver(() => [])
  clearGenOfficeIgnoreCache()
  rmSync(dir, { recursive: true, force: true })
})

describe('periodic ignore evaluation converges', () => {
  it('resolves the known roots once for a whole pass, not once per path', () => {
    const roots = Array.from({ length: 300 }, (_, i) => join(dir, `root${i}`))
    const resolver = vi.fn(() => roots)
    setKnownRootsResolver(resolver)
    for (let i = 0; i < 5000; i++) isPathIgnored(join(roots[i % 300]!, 'a', `f${i}.docx`))
    expect(resolver.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('serves a corpus-sized second pass from the cache without re-running rule matching', () => {
    const root = join(dir, 'corpus')
    setKnownRootsResolver(() => [root])
    const paths = Array.from({ length: 30_000 }, (_, i) => join(root, `d${i % 50}`, `f${i}.docx`))
    for (const p of paths) isPathIgnored(p)
    const test = vi.spyOn(RegExp.prototype, 'test')
    for (const p of paths) isPathIgnored(p)
    expect(test).not.toHaveBeenCalled()
  })

  it('keeps one .genofficeignore entry per root past 150 roots without bumping the policy generation', () => {
    const roots: string[] = []
    for (let i = 0; i < 200; i++) {
      const r = join(dir, `r${i}`)
      mkdirSync(r)
      writeFileSync(join(r, '.genofficeignore'), '*.tmp\n')
      roots.push(r)
    }
    setKnownRootsResolver(() => roots)
    for (const r of roots) evaluateIgnore(join(r, 'x.docx'), r)
    const generation = getIgnorePolicyGeneration()
    for (let pass = 0; pass < 3; pass++)
      for (const r of roots) expect(evaluateIgnore(join(r, 'x.tmp'), r).ignored).toBe(true)
    expect(getIgnorePolicyGeneration()).toBe(generation)
  })

  it('picks up a changed root list after invalidation and keeps longest-root matching', () => {
    const outer = join(dir, 'outer')
    const inner = join(dir, 'outer', 'inner')
    let roots = [outer]
    setKnownRootsResolver(() => roots)
    expect(resolveIndexedRoot(join(inner, 'a.docx'))).toBe(outer)
    roots = [outer, inner]
    invalidateKnownRootsCache()
    expect(resolveIndexedRoot(join(inner, 'a.docx'))).toBe(inner)
    expect(resolveIndexedRoot(join(dir, 'outer2', 'a.docx'))).toBeUndefined()
  })

  it('normalizes backslash and doubled-slash paths like before', () => {
    setKnownRootsResolver(() => ['C:\\Data\\Docs'])
    expect(resolveIndexedRoot('c:\\data\\docs\\sub\\a.docx')).toBe('C:\\Data\\Docs')
    expect(resolveIndexedRoot('C:/Data//Docs/a.docx')).toBe('C:\\Data\\Docs')
    expect(resolveIndexedRoot('C:\\Data\\Docs2\\a.docx')).toBeUndefined()
  })
})
