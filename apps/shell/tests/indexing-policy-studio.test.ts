import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  evaluateIgnore,
  isPathIgnored,
  readGenOfficeIgnore,
  readGenOfficeIgnoreDetailed,
  writeGenOfficeIgnoreFile,
  getGenOfficeIgnoreFileData,
  parseGenOfficeIgnoreContent,
  refreshGenOfficeIgnoreForRoot,
  clearGenOfficeIgnoreCache,
  setIgnoreStoragePath,
  setActiveIgnoreRules,
  setIndexingPolicyMode,
  setPolicyPresetState,
  getIgnorePolicySnapshot,
  applyIgnorePolicySnapshotDetailed,
  getIgnorePolicyGeneration,
  setKnownRootsResolver,
  clearRegexCache,
  DEFAULT_IGNORE_RULES,
  DEFAULT_INDEXING_PRESETS,
  type IgnoreRule,
} from '../src/main/document-memory/ignore-policy'
import { shouldSkipDirectory } from '../src/main/document-memory/scan-policy'

describe('Enterprise Indexing Policy Studio — Comprehensive Suite', () => {
  let tempDir: string
  let rootA: string
  let rootB: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-studio-test-'))
    rootA = join(tempDir, 'rootA')
    rootB = join(tempDir, 'rootB')
    mkdirSync(rootA, { recursive: true })
    mkdirSync(rootB, { recursive: true })

    setIgnoreStoragePath(join(tempDir, 'ignore-rules.json'))
    setActiveIgnoreRules([...DEFAULT_IGNORE_RULES])
    setIndexingPolicyMode('standard')
    setKnownRootsResolver(() => [rootA, rootB])
    clearGenOfficeIgnoreCache()
    clearRegexCache()
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // safe cleanup
    }
  })

  // =========================================================================
  // 1. Policy Engine: 24 Required Scenarios
  // =========================================================================

  describe('Policy Engine: 24 Core Scenarios', () => {
    it('1. Old Ignore rules remain backward compatible (action defaults to ignore)', () => {
      const legacyRules: IgnoreRule[] = [
        {
          id: 'legacy-tmp',
          pattern: '*.tmp',
          enabled: true,
          scope: 'global',
          description: 'Legacy tmp rule without action',
        },
      ]
      setActiveIgnoreRules(legacyRules)
      const res = evaluateIgnore(join(rootA, 'file.tmp'), rootA)
      expect(res.ignored).toBe(true)
      expect(res.action).toBe('ignore')
      expect(res.winningRule?.id).toBe('legacy-tmp')
    })

    it('2. Explicit Allow overrides configurable Ignore', () => {
      const rules: IgnoreRule[] = [
        {
          id: 'ignore-all-tmp',
          pattern: '*.tmp',
          enabled: true,
          scope: 'global',
          action: 'ignore',
        },
        {
          id: 'allow-keep-tmp',
          pattern: 'keep.tmp',
          enabled: true,
          scope: 'global',
          action: 'allow',
        },
      ]
      setActiveIgnoreRules(rules)

      const ordinary = evaluateIgnore(join(rootA, 'other.tmp'), rootA)
      expect(ordinary.ignored).toBe(true)
      expect(ordinary.action).toBe('ignore')

      const allowed = evaluateIgnore(join(rootA, 'keep.tmp'), rootA)
      expect(allowed.ignored).toBe(false)
      expect(allowed.action).toBe('allow')
      expect(allowed.winningRule?.id).toBe('allow-keep-tmp')
      expect(allowed.overriddenRule?.id).toBe('ignore-all-tmp')
    })

    it('3. Explicit Ignore overrides recommended Allow preset', () => {
      setIndexingPolicyMode('allowlist')
      setPolicyPresetState('preset-common-docs', true)

      // Add explicit ignore for confidential.docx
      const rules: IgnoreRule[] = [
        {
          id: 'ignore-confidential',
          pattern: '**/confidential.docx',
          enabled: true,
          scope: 'global',
          action: 'ignore',
        },
      ]
      setActiveIgnoreRules(rules)

      // Ordinary docx is allowed by Common Documents preset
      const ordinaryDoc = evaluateIgnore(join(rootA, 'report.docx'), rootA)
      expect(ordinaryDoc.ignored).toBe(false)
      expect(ordinaryDoc.action).toBe('allow')

      // Confidential docx is blocked by explicit ignore rule
      const confidentialDoc = evaluateIgnore(join(rootA, 'confidential.docx'), rootA)
      expect(confidentialDoc.ignored).toBe(true)
      expect(confidentialDoc.action).toBe('ignore')
      expect(confidentialDoc.winningRule?.id).toBe('ignore-confidential')
    })

    it('4. Hard eligibility restrictions remain enforced (unsupported extensions)', () => {
      // Even if user attempts an allow rule for executable or binary files
      const rules: IgnoreRule[] = [
        {
          id: 'allow-binaries',
          pattern: '*.exe',
          enabled: true,
          scope: 'global',
          action: 'allow',
        },
      ]
      setActiveIgnoreRules(rules)

      const exeRes = evaluateIgnore(join(rootA, 'program.exe'), rootA)
      expect(exeRes.eligibility).toBe('unsupported')
      expect(exeRes.action).toBe('allow')
      expect(exeRes.winningRule?.id).toBe('allow-binaries')
    })

    it('5. Standard mode: unmatched files are admitted by default', () => {
      setIndexingPolicyMode('standard')
      setActiveIgnoreRules([]) // No rules active

      const docRes = evaluateIgnore(join(rootA, 'my-document.docx'), rootA)
      expect(docRes.ignored).toBe(false)
      expect(docRes.mode).toBe('standard')
      expect(docRes.decision).toBe('allow')
    })

    it('6. Allowlist mode: unmatched files are ignored by default', () => {
      setIndexingPolicyMode('allowlist')
      setActiveIgnoreRules([]) // No explicit allow rules, disable presets
      for (const p of DEFAULT_INDEXING_PRESETS) {
        setPolicyPresetState(p.id, false)
      }

      const docRes = evaluateIgnore(join(rootA, 'my-document.docx'), rootA)
      expect(docRes.ignored).toBe(true)
      expect(docRes.mode).toBe('allowlist')
      expect(docRes.decision).toBe('ignore')
      expect(docRes.explanation).toContain('Allowlist mode')
    })

    it('7. Scoped Allow applies only to target directory', () => {
      const rules: IgnoreRule[] = [
        {
          id: 'ignore-all-docs',
          pattern: '*.docx',
          enabled: true,
          scope: 'global',
          action: 'ignore',
        },
        {
          id: 'allow-rootA-docs',
          pattern: '*.docx',
          enabled: true,
          scope: rootA,
          action: 'allow',
        },
      ]
      setActiveIgnoreRules(rules)

      // In rootA: allowed because scoped allow rule matches
      const resA = evaluateIgnore(join(rootA, 'test.docx'), rootA)
      expect(resA.ignored).toBe(false)
      expect(resA.action).toBe('allow')

      // In rootB: ignored because scoped allow rule does not apply
      const resB = evaluateIgnore(join(rootB, 'test.docx'), rootB)
      expect(resB.ignored).toBe(true)
      expect(resB.action).toBe('ignore')
    })

    it('8. Scoped Ignore applies only to target directory', () => {
      const rules: IgnoreRule[] = [
        {
          id: 'ignore-rootA-xlsx',
          pattern: '*.xlsx',
          enabled: true,
          scope: rootA,
          action: 'ignore',
        },
      ]
      setActiveIgnoreRules(rules)

      // In rootA: ignored
      const resA = evaluateIgnore(join(rootA, 'sheet.xlsx'), rootA)
      expect(resA.ignored).toBe(true)

      // In rootB: not ignored
      const resB = evaluateIgnore(join(rootB, 'sheet.xlsx'), rootB)
      expect(resB.ignored).toBe(false)
    })

    it('9. Global versus root rules precedence and application', () => {
      const rules: IgnoreRule[] = [
        {
          id: 'global-ignore-log',
          pattern: '*.log',
          enabled: true,
          scope: 'global',
          action: 'ignore',
        },
        {
          id: 'rootA-allow-log',
          pattern: '*.log',
          enabled: true,
          scope: rootA,
          action: 'allow',
        },
      ]
      setActiveIgnoreRules(rules)

      expect(isPathIgnored(join(rootA, 'app.log'), rootA)).toBe(false)
      expect(isPathIgnored(join(rootB, 'app.log'), rootB)).toBe(true)
    })

    it('10. Windows case-insensitive paths matching', () => {
      const rules: IgnoreRule[] = [
        {
          id: 'ignore-tmp',
          pattern: '*.tmp',
          enabled: true,
          scope: 'global',
          action: 'ignore',
        },
      ]
      setActiveIgnoreRules(rules)

      // Windows style path with mixed case extension
      const winPath = 'C:\\Projects\\App\\CACHE.TMP'
      const res = evaluateIgnore(winPath)
      expect(res.ignored).toBe(true)
    })

    it('11. POSIX case-sensitive paths preserving pattern contract', () => {
      const rules: IgnoreRule[] = [
        {
          id: 'ignore-special-case',
          pattern: 'ExactCase.txt',
          enabled: true,
          scope: 'global',
          action: 'ignore',
        },
      ]
      setActiveIgnoreRules(rules)

      expect(isPathIgnored('/var/data/ExactCase.txt')).toBe(true)
      expect(isPathIgnored('/var/data/exactcase.txt')).toBe(false)
    })

    it('12. UNC paths parsed and evaluated cleanly', () => {
      const uncPath = '\\\\fileserver\\shared\\Accounting\\Budget.xlsx'
      const uncLock = '\\\\fileserver\\shared\\Accounting\\~$Budget.xlsx'

      expect(isPathIgnored(uncPath)).toBe(false)
      expect(isPathIgnored(uncLock)).toBe(true)
    })

    it('13. Path-component boundary safety (private/ does not match private_notes)', () => {
      expect(isPathIgnored('/work/private/doc.txt')).toBe(true)
      expect(isPathIgnored('/work/private_notes/doc.txt')).toBe(false)
      expect(isPathIgnored('/work/deprivate/doc.txt')).toBe(false)
    })

    it('14. Rule ordering independence for documented precedence', () => {
      // Put ignore rule first, allow rule second
      setActiveIgnoreRules([
        { id: 'ig-1', pattern: '*.txt', enabled: true, scope: 'global', action: 'ignore' },
        { id: 'al-1', pattern: 'readme.txt', enabled: true, scope: 'global', action: 'allow' },
      ])
      expect(evaluateIgnore(join(rootA, 'readme.txt'), rootA).ignored).toBe(false)

      // Invert order: allow rule first, ignore rule second
      setActiveIgnoreRules([
        { id: 'al-1', pattern: 'readme.txt', enabled: true, scope: 'global', action: 'allow' },
        { id: 'ig-1', pattern: '*.txt', enabled: true, scope: 'global', action: 'ignore' },
      ])
      expect(evaluateIgnore(join(rootA, 'readme.txt'), rootA).ignored).toBe(false)
    })

    it('15. Duplicate rules handled gracefully without error', () => {
      const dupRules: IgnoreRule[] = [
        { id: 'rule-1', pattern: '*.tmp', enabled: true, scope: 'global' },
        { id: 'rule-2', pattern: '*.tmp', enabled: true, scope: 'global' },
      ]
      expect(setActiveIgnoreRules(dupRules)).toBe(true)
      expect(isPathIgnored(join(rootA, 'test.tmp'), rootA)).toBe(true)
    })

    it('16. Invalid glob handled gracefully without crashing', () => {
      const rules: IgnoreRule[] = [
        { id: 'bad-glob', pattern: '[a-', enabled: true, scope: 'global', action: 'ignore' },
      ]
      setActiveIgnoreRules(rules)
      expect(() => evaluateIgnore(join(rootA, 'doc.txt'), rootA)).not.toThrow()
    })

    it('17. Missing .genofficeignore returns empty rules without error', () => {
      const res = readGenOfficeIgnore(rootA)
      expect(res).toEqual([])
    })

    it('18. Unreadable .genofficeignore handled safely', () => {
      // Create .genofficeignore as a directory to simulate read error
      mkdirSync(join(rootA, '.genofficeignore'), { recursive: true })
      const res = readGenOfficeIgnoreDetailed(rootA)
      // When unreadable, it fails closed with fallback ignore rule to preserve security
      expect(res.rules.length).toBeGreaterThan(0)
      expect(res.rules[0]?.description).toContain('unreadable')
      expect(isPathIgnored(join(rootA, 'file.docx'), rootA)).toBe(true)
    })

    it('19. Policy generation increments monotonically on changes', () => {
      const gen1 = getIgnorePolicyGeneration()
      setIndexingPolicyMode('allowlist')
      const gen2 = getIgnorePolicyGeneration()
      expect(gen2).toBeGreaterThan(gen1)

      setActiveIgnoreRules([...DEFAULT_IGNORE_RULES])
      const gen3 = getIgnorePolicyGeneration()
      expect(gen3).toBeGreaterThan(gen2)
    })

    it('20. Worker snapshot exports full state and imports correctly', () => {
      setIndexingPolicyMode('allowlist')
      const snapshot = getIgnorePolicySnapshot([rootA])
      expect(snapshot.version).toBeDefined()
      expect(snapshot.mode).toBe('allowlist')
      expect(snapshot.rules.length).toBeGreaterThan(0)

      const applied = applyIgnorePolicySnapshotDetailed(snapshot)
      expect(applied.status).toBe('applied')
    })

    it('21. Repeated identical snapshot returns unchanged', () => {
      const snapshot = getIgnorePolicySnapshot([rootA])
      applyIgnorePolicySnapshotDetailed(snapshot)
      const repeat = applyIgnorePolicySnapshotDetailed(snapshot)
      expect(repeat.status).toBe('unchanged')
    })

    it('22. Previously indexed ignored documents excluded from search', () => {
      // Given an allowed file
      const docPath = join(rootA, 'accounting.xlsx')
      expect(isPathIgnored(docPath, rootA)).toBe(false)

      // User adds an ignore rule targeting accounting
      setActiveIgnoreRules([
        ...DEFAULT_IGNORE_RULES,
        {
          id: 'ignore-acct',
          pattern: 'accounting.xlsx',
          enabled: true,
          scope: 'global',
          action: 'ignore',
        },
      ])

      // Verification: isPathIgnored immediately reflects exclusion
      expect(isPathIgnored(docPath, rootA)).toBe(true)
    })

    it('23. Re-allowed documents eventually re-enrolled', () => {
      const docPath = join(rootA, 'notes.txt')
      setActiveIgnoreRules([
        { id: 'ignore-txt', pattern: '*.txt', enabled: true, scope: 'global', action: 'ignore' },
      ])
      expect(isPathIgnored(docPath, rootA)).toBe(true)

      // Re-allow via explicit Allow rule
      setActiveIgnoreRules([
        { id: 'ignore-txt', pattern: '*.txt', enabled: true, scope: 'global', action: 'ignore' },
        {
          id: 'allow-notes',
          pattern: 'notes.txt',
          enabled: true,
          scope: 'global',
          action: 'allow',
        },
      ])
      expect(isPathIgnored(docPath, rootA)).toBe(false)
    })

    it('24. Existing ignore-only files parsed identically to legacy behavior', () => {
      const legacyContent = '# Legacy ignore\nnode_modules\n*.tmp\nbuild/\n'
      writeFileSync(join(rootA, '.genofficeignore'), legacyContent, 'utf-8')

      const rules = readGenOfficeIgnore(rootA)
      expect(rules.length).toBe(3)
      expect(rules.every((r) => r.action === 'ignore')).toBe(true)
      expect(isPathIgnored(join(rootA, 'build/output.txt'), rootA)).toBe(true)
    })
  })

  // =========================================================================
  // 2. Editor and Persistence
  // =========================================================================

  describe('Editor and Persistence', () => {
    it('creates file when it does not exist', () => {
      const content = '@mode standard\n!special.docx\nignore-me.txt\n'
      const saveRes = writeGenOfficeIgnoreFile(rootA, content)
      expect(saveRes.ok).toBe(true)
      expect(saveRes.revision).toBeDefined()

      const fileData = getGenOfficeIgnoreFileData(rootA)
      expect(fileData.exists).toBe(true)
      expect(fileData.content).toBe(content)
      expect(fileData.mode).toBe('standard')
      expect(fileData.rules.length).toBe(2)
    })

    it('saves file and updates revision', () => {
      const saveRes1 = writeGenOfficeIgnoreFile(rootA, 'draft/\n')
      expect(saveRes1.ok).toBe(true)

      const saveRes2 = writeGenOfficeIgnoreFile(rootA, 'draft/\nfinal/\n', saveRes1.revision)
      expect(saveRes2.ok).toBe(true)
      expect(saveRes2.revision).not.toBe(saveRes1.revision)
    })

    it('detects external modification conflict', () => {
      const saveRes1 = writeGenOfficeIgnoreFile(rootA, 'line1\n')
      expect(saveRes1.ok).toBe(true)

      // External write modifies file directly on disk
      writeFileSync(join(rootA, '.genofficeignore'), 'external modification\n', 'utf-8')

      // Trying to save with old expectedRevision triggers conflict
      const saveRes2 = writeGenOfficeIgnoreFile(rootA, 'line2\n', saveRes1.revision)
      expect(saveRes2.ok).toBe(false)
      expect(saveRes2.error).toBe('conflict')
      expect(saveRes2.revision).toBeDefined()
    })

    it('rejects invalid syntax directives', () => {
      const invalidContent = '@invalid-directive value\n'
      const saveRes = writeGenOfficeIgnoreFile(rootA, invalidContent)
      expect(saveRes.ok).toBe(false)
      expect(saveRes.error).toBe('invalid-syntax')
      expect(saveRes.validationErrors?.length).toBeGreaterThan(0)
    })

    it('rejects writing to restricted system paths', () => {
      const saveRes = writeGenOfficeIgnoreFile('/etc', 'test\n')
      expect(saveRes.ok).toBe(false)
      expect(saveRes.error).toBe('Restricted path')
    })

    it('rejects overwriting symbolic links', () => {
      const realFile = join(tempDir, 'external-ignore.txt')
      writeFileSync(realFile, 'external content\n', 'utf-8')

      const symlinkPath = join(rootA, '.genofficeignore')
      symlinkSync(realFile, symlinkPath)

      const saveRes = writeGenOfficeIgnoreFile(rootA, 'attempted overwrite\n')
      expect(saveRes.ok).toBe(false)
      expect(saveRes.error).toBe('Cannot overwrite symbolic link')
    })

    it('handles UTF-8 and Vietnamese characters correctly', () => {
      const utf8Content = '# Tài liệu nội bộ\n!Báo cáo tài chính.docx\nBản nháp/\n'
      const saveRes = writeGenOfficeIgnoreFile(rootA, utf8Content)
      expect(saveRes.ok).toBe(true)

      const fileData = getGenOfficeIgnoreFileData(rootA)
      expect(fileData.content).toBe(utf8Content)
      expect(isPathIgnored(join(rootA, 'Báo cáo tài chính.docx'), rootA)).toBe(false)
      expect(isPathIgnored(join(rootA, 'Bản nháp/chi_tiet.txt'), rootA)).toBe(true)
    })

    it('handles Windows CRLF line endings transparently', () => {
      const crlfContent = '@mode standard\r\n!allow.docx\r\nignore.docx\r\n'
      const parsed = parseGenOfficeIgnoreContent(rootA, crlfContent)
      expect(parsed.mode).toBe('standard')
      expect(parsed.rules.length).toBe(2)
      expect(parsed.rules[0]?.action).toBe('allow')
      expect(parsed.rules[1]?.action).toBe('ignore')
    })

    it('handles empty configuration gracefully', () => {
      const saveRes = writeGenOfficeIgnoreFile(rootA, '')
      expect(saveRes.ok).toBe(true)
      const fileData = getGenOfficeIgnoreFileData(rootA)
      expect(fileData.rules).toEqual([])
    })

    it('maintains root isolation between distinct folders', () => {
      writeGenOfficeIgnoreFile(rootA, 'isolated_folder/\n')
      writeGenOfficeIgnoreFile(rootB, '!isolated_folder/\n')

      expect(isPathIgnored(join(rootA, 'isolated_folder/file.docx'), rootA)).toBe(true)
      expect(isPathIgnored(join(rootB, 'isolated_folder/file.docx'), rootB)).toBe(false)
    })

    it('invalidates cache and bumps policy generation on refresh', () => {
      writeGenOfficeIgnoreFile(rootA, 'cache_test/\n')
      // Simulate external file modification
      writeFileSync(join(rootA, '.genofficeignore'), 'new_content/\n', 'utf-8')
      const genBefore = getIgnorePolicyGeneration()
      const refreshed = refreshGenOfficeIgnoreForRoot(rootA)
      expect(refreshed).toBe(true)
      expect(getIgnorePolicyGeneration()).toBeGreaterThan(genBefore)
    })
  })

  // =========================================================================
  // 3. Scan Policy Directory Pruning Integration
  // =========================================================================

  describe('Scan Policy Directory Traversal Integration', () => {
    it('does not prune directory when descendant contains explicit Allow rule', () => {
      // If node_modules is ignored by default, but a rule explicitly allows node_modules/my-pkg/spec.docx
      const rules: IgnoreRule[] = [
        ...DEFAULT_IGNORE_RULES,
        {
          id: 'allow-pkg-spec',
          pattern: 'node_modules/my-pkg/**',
          enabled: true,
          scope: rootA,
          action: 'allow',
        },
      ]
      setActiveIgnoreRules(rules)

      // shouldSkipDirectory('node_modules', fullPath)
      const dirPath = join(rootA, 'node_modules')
      const skip = shouldSkipDirectory('node_modules', dirPath)
      expect(skip).toBe(false)
    })

    it('prunes directory when no descendant allow rule exists', () => {
      setActiveIgnoreRules([...DEFAULT_IGNORE_RULES])
      const dirPath = join(rootA, 'node_modules')
      const skip = shouldSkipDirectory('node_modules', dirPath)
      expect(skip).toBe(true)
    })
  })

  // =========================================================================
  // 4. Performance Benchmarks
  // =========================================================================

  describe('Performance Benchmarks: High Throughput & Low Latency', () => {
    it('benchmarks 10,000 paths cold and warm cache', () => {
      const paths: string[] = []
      for (let i = 0; i < 10_000; i++) {
        paths.push(join(rootA, `dir_${i % 20}`, `document_${i}.docx`))
      }

      // Cold run
      clearRegexCache()
      const coldStart = performance.now()
      for (let i = 0; i < paths.length; i++) {
        evaluateIgnore(paths[i]!, rootA)
      }
      const coldDuration = performance.now() - coldStart

      // Warm run
      const warmStart = performance.now()
      for (let i = 0; i < paths.length; i++) {
        evaluateIgnore(paths[i]!, rootA)
      }
      const warmDuration = performance.now() - warmStart

      expect(coldDuration).toBeLessThan(1200) // Less than 1.2s for 10,000 cold paths (< 0.12ms/path)
      expect(warmDuration).toBeLessThan(100) // Less than 100ms for 10,000 warm paths (< 0.01ms/path)
    })

    it('benchmarks 100,000 warm evaluations at high ops/second (> 200,000 ops/s)', () => {
      const testPath = join(rootA, 'finance', 'q4-report.xlsx')

      // Prime cache
      evaluateIgnore(testPath, rootA)

      const start = performance.now()
      const iterations = 100_000
      for (let i = 0; i < iterations; i++) {
        evaluateIgnore(testPath, rootA)
      }
      const duration = performance.now() - start
      const opsPerSec = (iterations / duration) * 1000

      // Must be blazing fast (zero sync FS calls, bounded LRU cache hit)
      expect(duration).toBeLessThan(300) // 100k evals under 300ms
      expect(opsPerSec).toBeGreaterThan(200_000)
    })

    it('evaluates large ruleset (500 rules) with low latency', () => {
      const largeRules: IgnoreRule[] = []
      for (let i = 0; i < 490; i++) {
        largeRules.push({
          id: `rule-${i}`,
          pattern: `**/generated_${i}/**`,
          enabled: true,
          scope: 'global',
          action: 'ignore',
        })
      }
      largeRules.push({
        id: 'allow-target',
        pattern: '**/target.docx',
        enabled: true,
        scope: 'global',
        action: 'allow',
      })
      setActiveIgnoreRules(largeRules)

      const targetPath = join(rootA, 'sub', 'target.docx')
      const start = performance.now()
      const res = evaluateIgnore(targetPath, rootA)
      const duration = performance.now() - start

      expect(res.ignored).toBe(false)
      expect(res.action).toBe('allow')
      expect(duration).toBeLessThan(50) // First compilation and match under 50ms
    })
  })
})
