import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  evaluateIgnore,
  isPathIgnored,
  readGenOfficeIgnore,
  setIgnoreStoragePath,
  setActiveIgnoreRules,
  getActiveIgnoreRules,
  DEFAULT_IGNORE_RULES,
  type IgnoreRule,
} from '../src/main/document-memory/ignore-policy'
import { isIndexablePath } from '../src/main/document-memory/folder-scan'
import { shouldSkipDirectory } from '../src/main/document-memory/scan-policy'

describe('document-index ignore policy (Phase 4)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-ignore-test-'))
    setIgnoreStoragePath(join(tempDir, 'ignore-rules.json'))
    setActiveIgnoreRules([...DEFAULT_IGNORE_RULES])
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // safe cleanup
    }
  })

  it('correctly matches glob patterns for temporary and lock files', () => {
    expect(isPathIgnored('/docs/notes.tmp')).toBe(true)
    expect(isPathIgnored('/docs/backup.bak')).toBe(true)
    expect(isPathIgnored('/docs/~$WordDoc.docx')).toBe(true)
    expect(isPathIgnored('/docs/normal.docx')).toBe(false)
  })

  it('handles Windows backslash separators transparently', () => {
    expect(isPathIgnored('C:\\Users\\User\\Documents\\temp.tmp')).toBe(true)
    expect(isPathIgnored('C:\\Users\\User\\Documents\\~$Draft.xlsx')).toBe(true)
    expect(isPathIgnored('C:\\Users\\User\\Documents\\node_modules\\package\\index.js')).toBe(true)
    expect(isPathIgnored('C:\\Users\\User\\Documents\\Finance\\Report.xlsx')).toBe(false)
  })

  it('handles directory patterns and private folders', () => {
    expect(isPathIgnored('/workspace/node_modules/lodash/index.js')).toBe(true)
    expect(isPathIgnored('/workspace/.git/config')).toBe(true)
    expect(isPathIgnored('/workspace/private/key.pem')).toBe(true)
    expect(isPathIgnored('/workspace/secrets/token.json')).toBe(true)
    expect(isPathIgnored('/workspace/src/app.tsx')).toBe(false)
  })

  it('supports root-scoped rules and root isolation', () => {
    const rootA = '/Users/user/project-a'
    const rootB = '/Users/user/project-b'

    const rules: IgnoreRule[] = [
      {
        id: 'rule-root-a-only',
        pattern: 'drafts/**',
        enabled: true,
        scope: rootA,
        description: 'Drafts in Project A only',
      },
    ]
    setActiveIgnoreRules(rules)

    // Path under rootA matches
    const resA = evaluateIgnore(`${rootA}/drafts/chapter1.docx`, rootA)
    expect(resA.ignored).toBe(true)
    expect(resA.reason).toContain('drafts/**')

    // Path under rootB does NOT match the rootA-scoped rule
    const resB = evaluateIgnore(`${rootB}/drafts/chapter1.docx`, rootB)
    expect(resB.ignored).toBe(false)
  })

  it('reads and enforces .genofficeignore in a directory', () => {
    const root = join(tempDir, 'repo')
    const ignoreFile = join(root, '.genofficeignore')
    mkdirSync(root, { recursive: true })

    writeFileSync(
      ignoreFile,
      `
# Comment line
*.secret
custom_cache/
`,
      'utf-8',
    )

    const rules = readGenOfficeIgnore(root)
    expect(rules).toHaveLength(2)
    expect(rules[0]!.pattern).toBe('*.secret')
    expect(rules[1]!.pattern).toBe('custom_cache/')

    const evalSecret = evaluateIgnore(join(root, 'passwords.secret'), root)
    expect(evalSecret.ignored).toBe(true)
    expect(evalSecret.reason).toContain('.genofficeignore')

    const evalCache = evaluateIgnore(join(root, 'custom_cache', 'item.dat'), root)
    expect(evalCache.ignored).toBe(true)

    const evalValid = evaluateIgnore(join(root, 'readme.md'), root)
    expect(evalValid.ignored).toBe(false)
  })

  it('provides informative reason explaining which rule caused exclusion', () => {
    const res = evaluateIgnore('/test/workspace/~$important.docx')
    expect(res.ignored).toBe(true)
    expect(res.matchedRule).toBeDefined()
    expect(res.matchedRule?.pattern).toBe('~$*')
    expect(res.reason).toContain('~$*')
  })

  it('persists rules safely and recovers them on reload', () => {
    const customRule: IgnoreRule = {
      id: 'custom-1',
      pattern: '*.log',
      enabled: true,
      scope: 'global',
      description: 'Log files',
    }
    setActiveIgnoreRules([customRule])

    // Load from disk into fresh query
    const loaded = getActiveIgnoreRules()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.pattern).toBe('*.log')
    expect(isPathIgnored('/var/app.log')).toBe(true)
  })

  it('integrates with shouldSkipDirectory and isIndexablePath', () => {
    // Directory check
    expect(shouldSkipDirectory('node_modules')).toBe(true)
    expect(shouldSkipDirectory('private', '/docs/private')).toBe(true)

    // File check via isIndexablePath
    expect(isIndexablePath('/docs', '/docs/file.tmp')).toBe(false)
    expect(isIndexablePath('/docs', '/docs/report.docx')).toBe(true)
  })
})
