import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { IpcMain } from 'electron'
import { DOCUMENT_INDEX_CHANNELS } from '../../shared/fork/document-index-api'

export interface IgnoreRule {
  id: string
  pattern: string
  enabled: boolean
  scope: 'global' | string
  description?: string
  source?: 'user' | '.genofficeignore'
}

export interface IgnoreMatchResult {
  ignored: boolean
  matchedRule?: IgnoreRule
  reason?: string
}

export const DEFAULT_IGNORE_RULES: IgnoreRule[] = [
  {
    id: 'rule-tmp',
    pattern: '*.tmp',
    enabled: true,
    scope: 'global',
    description: 'Temporary files',
  },
  { id: 'rule-bak', pattern: '*.bak', enabled: true, scope: 'global', description: 'Backup files' },
  {
    id: 'rule-lock',
    pattern: '~$*',
    enabled: true,
    scope: 'global',
    description: 'Office lock files',
  },
  {
    id: 'rule-modules',
    pattern: '**/node_modules/**',
    enabled: true,
    scope: 'global',
    description: 'Node modules',
  },
  {
    id: 'rule-git',
    pattern: '**/.git/**',
    enabled: true,
    scope: 'global',
    description: 'Git repository',
  },
  {
    id: 'rule-private',
    pattern: 'private/',
    enabled: true,
    scope: 'global',
    description: 'Private folder',
  },
  {
    id: 'rule-secrets',
    pattern: '**/secrets/**',
    enabled: true,
    scope: 'global',
    description: 'Secrets directories',
  },
]

let activeRules: IgnoreRule[] = [...DEFAULT_IGNORE_RULES]
let storageFilePath: string | null = null
let policyGeneration = 0

export function getIgnorePolicyGeneration(): number {
  return policyGeneration
}

export function bumpIgnorePolicyGeneration(): void {
  policyGeneration++
  clearRegexCache()
}

export function setIgnoreStoragePath(path: string): void {
  storageFilePath = path
  loadPersistedIgnoreRules()
}

export function getIgnoreStoragePath(): string | null {
  return storageFilePath
}

const regexCache = new Map<string, RegExp>()
const MAX_REGEX_CACHE = 500

export function clearRegexCache(): void {
  regexCache.clear()
}

export function isPathCaseInsensitive(p: string): boolean {
  return (
    process.platform === 'win32' ||
    /^[a-zA-Z]:[/\\]/.test(p) ||
    p.startsWith('\\\\') ||
    p.startsWith('//')
  )
}

export function globToRegex(
  pattern: string,
  caseInsensitive = process.platform === 'win32',
): RegExp {
  const cacheKey = `${pattern}::${caseInsensitive ? 'i' : 's'}`
  const cached = regexCache.get(cacheKey)
  if (cached) return cached

  let p = pattern.trim().replace(/\\/g, '/')
  const isDirOnly = p.endsWith('/')
  if (isDirOnly) p = p.slice(0, -1)

  let regexStr = ''
  let i = 0
  const len = p.length
  const matchAnywhere = !p.startsWith('/') && !p.startsWith('**/')

  while (i < len) {
    const c = p[i]!
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') {
        regexStr += '(?:.+/)?'
        i += 3
        continue
      } else {
        regexStr += '.*'
        i += 2
        continue
      }
    } else if (c === '*') {
      regexStr += '[^/]*'
      i++
    } else if (c === '?') {
      regexStr += '[^/]'
      i++
    } else if ('[].+^$(){}|\\'.includes(c)) {
      regexStr += '\\' + c
      i++
    } else {
      regexStr += c
      i++
    }
  }

  if (matchAnywhere) {
    regexStr = '(?:^|.*/)' + regexStr
  } else if (regexStr.startsWith('/')) {
    regexStr = '^' + regexStr.slice(1)
  } else {
    regexStr = '^' + regexStr
  }

  regexStr += '(?=$|/.*)'
  const regex = new RegExp(regexStr, caseInsensitive ? 'i' : undefined)
  if (regexCache.size >= MAX_REGEX_CACHE) {
    const firstKey = regexCache.keys().next().value
    if (firstKey) regexCache.delete(firstKey)
  }
  regexCache.set(cacheKey, regex)
  return regex
}

interface CachedIgnore {
  mtimeMs: number
  rules: IgnoreRule[]
}
const genOfficeIgnoreCache = new Map<string, CachedIgnore>()
const MAX_GENOFFICEIGNORE_CACHE = 100

let knownRootsResolver: (() => string[]) | null = null

export function setKnownRootsResolver(resolver: () => string[]): void {
  knownRootsResolver = resolver
}

export function clearGenOfficeIgnoreCache(): void {
  genOfficeIgnoreCache.clear()
}

export function readGenOfficeIgnore(dir: string): IgnoreRule[] {
  const filePath = resolve(dir, '.genofficeignore')
  try {
    if (!existsSync(filePath)) {
      if (genOfficeIgnoreCache.has(dir)) {
        genOfficeIgnoreCache.delete(dir)
        bumpIgnorePolicyGeneration()
      }
      return []
    }
    const stat = statSync(filePath)
    const cached = genOfficeIgnoreCache.get(dir)
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.rules
    }
    bumpIgnorePolicyGeneration()
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split(/\r?\n/)
    const rules: IgnoreRule[] = []
    let idx = 0
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      idx++
      rules.push({
        id: `.genofficeignore-${idx}-${line}`,
        pattern: line,
        enabled: true,
        scope: dir,
        source: '.genofficeignore',
        description: `.genofficeignore in ${dir}`,
      })
    }
    if (genOfficeIgnoreCache.size >= MAX_GENOFFICEIGNORE_CACHE) {
      const firstKey = genOfficeIgnoreCache.keys().next().value
      if (firstKey) genOfficeIgnoreCache.delete(firstKey)
    }
    genOfficeIgnoreCache.set(dir, { mtimeMs: stat.mtimeMs, rules })
    return rules
  } catch {
    return []
  }
}

export function getActiveIgnoreRules(): IgnoreRule[] {
  return [...activeRules]
}

function persistRulesToDisk(rules: IgnoreRule[]): boolean {
  if (!storageFilePath) return true
  try {
    mkdirSync(dirname(storageFilePath), { recursive: true })
    const tmp = `${storageFilePath}.tmp`
    writeFileSync(tmp, JSON.stringify(rules, null, 2), { mode: 0o600 })
    renameSync(tmp, storageFilePath)
    return true
  } catch {
    return false
  }
}

export function persistIgnoreRules(): boolean {
  return persistRulesToDisk(activeRules)
}

export const MAX_RULE_COUNT = 500
export const MAX_PATTERN_LENGTH = 500
export const MAX_ID_LENGTH = 100
export const MAX_SCOPE_LENGTH = 500

export function setActiveIgnoreRules(rules: IgnoreRule[]): boolean {
  if (rules.length > MAX_RULE_COUNT) return false
  for (const r of rules) {
    if (!isValidIgnoreRule(r)) return false
  }
  const candidate = rules.map((r) => ({ ...r }))
  const ok = persistRulesToDisk(candidate)
  if (!ok) {
    return false
  }
  activeRules = candidate
  bumpIgnorePolicyGeneration()
  return true
}

function isValidIgnoreRule(r: unknown): r is IgnoreRule {
  if (typeof r !== 'object' || r === null) return false
  const rule = r as IgnoreRule
  return (
    typeof rule.id === 'string' &&
    rule.id.length > 0 &&
    rule.id.length <= MAX_ID_LENGTH &&
    typeof rule.pattern === 'string' &&
    rule.pattern.length > 0 &&
    rule.pattern.length <= MAX_PATTERN_LENGTH &&
    typeof rule.enabled === 'boolean' &&
    typeof rule.scope === 'string' &&
    rule.scope.length <= MAX_SCOPE_LENGTH &&
    (rule.description === undefined || typeof rule.description === 'string') &&
    (rule.source === undefined || rule.source === 'user' || rule.source === '.genofficeignore')
  )
}

export function loadPersistedIgnoreRules(): IgnoreRule[] {
  if (!storageFilePath || !existsSync(storageFilePath)) {
    return activeRules
  }
  try {
    const raw = readFileSync(storageFilePath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      activeRules = parsed.filter(isValidIgnoreRule)
    }
  } catch {
    // Keep in-memory rules on read failure
  }
  bumpIgnorePolicyGeneration()
  return activeRules
}

function normalizePath(p: string): string {
  const isUnc = p.startsWith('\\\\') || p.startsWith('//')
  const unified = p.replace(/\\/g, '/').replace(/\/+/g, '/')
  return isUnc ? '/' + unified : unified
}

function isSubpathOrEqual(target: string, scope: string): boolean {
  const normTarget = normalizePath(target)
  const normScope = normalizePath(scope)
  const isCI = isPathCaseInsensitive(normTarget) || isPathCaseInsensitive(normScope)
  const t = isCI ? normTarget.toLowerCase() : normTarget
  const s = isCI ? normScope.toLowerCase() : normScope
  return t === s || t.startsWith(s.endsWith('/') ? s : s + '/')
}

export function resolveIndexedRoot(targetPath: string, explicitRoot?: string): string | undefined {
  if (explicitRoot) return explicitRoot
  if (!knownRootsResolver) return undefined
  try {
    const roots = knownRootsResolver()
    const matching = roots.filter((r) => isSubpathOrEqual(targetPath, r))
    if (matching.length === 0) return undefined
    return matching.sort((a, b) => b.length - a.length)[0]
  } catch {
    return undefined
  }
}

export function evaluateIgnore(targetPath: string, root?: string): IgnoreMatchResult {
  const resolvedRoot = resolveIndexedRoot(targetPath, root)
  const normTarget = normalizePath(targetPath)
  const normRoot = resolvedRoot ? normalizePath(resolvedRoot) : undefined
  const isCI =
    isPathCaseInsensitive(targetPath) ||
    (resolvedRoot ? isPathCaseInsensitive(resolvedRoot) : false)

  // 1. Check active user rules
  for (const rule of activeRules) {
    if (!rule.enabled) continue
    if (rule.scope !== 'global') {
      // Enforce path-component boundaries: target must be inside rule.scope
      if (!isSubpathOrEqual(normTarget, rule.scope)) {
        continue
      }
      // If root is known, ensure rule scope is related to this root
      if (
        normRoot &&
        !isSubpathOrEqual(normRoot, rule.scope) &&
        !isSubpathOrEqual(rule.scope, normRoot)
      ) {
        continue
      }
    }

    try {
      const regex = globToRegex(rule.pattern, isCI)
      const scopeBase = rule.scope !== 'global' ? normalizePath(rule.scope) : normRoot
      const relPath =
        scopeBase && isSubpathOrEqual(normTarget, scopeBase)
          ? isSubpathOrEqual(scopeBase, normTarget)
            ? ''
            : normTarget.slice(scopeBase.length).replace(/^\//, '')
          : normTarget

      if (regex.test(normTarget) || (relPath && regex.test(relPath))) {
        return {
          ignored: true,
          matchedRule: rule,
          reason: `Excluded by rule "${rule.pattern}" (${rule.description || rule.scope})`,
        }
      }
    } catch {
      // Ignore regex syntax errors safely
    }
  }

  // 2. Check .genofficeignore in resolvedRoot
  if (resolvedRoot) {
    const rootRules = readGenOfficeIgnore(resolvedRoot)
    const relPath =
      normRoot && isSubpathOrEqual(normTarget, normRoot)
        ? isSubpathOrEqual(normRoot, normTarget)
          ? ''
          : normTarget.slice(normRoot.length).replace(/^\//, '')
        : normTarget

    for (const rule of rootRules) {
      try {
        const regex = globToRegex(rule.pattern, isCI)
        if (regex.test(normTarget) || (relPath && regex.test(relPath))) {
          return {
            ignored: true,
            matchedRule: rule,
            reason: `Excluded by .genofficeignore rule "${rule.pattern}"`,
          }
        }
      } catch {
        // Safe skip
      }
    }
  }

  return { ignored: false }
}

export function isPathIgnored(targetPath: string, root?: string): boolean {
  return evaluateIgnore(targetPath, root).ignored
}

export function registerIgnoreIpcHandlers(
  ipcMain: Pick<IpcMain, 'handle'>,
  onInvalidate?: () => void,
  getRoots?: () => string[],
): void {
  if (getRoots) {
    setKnownRootsResolver(getRoots)
  }

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.getIgnoreRules, () => {
    const userRules = getActiveIgnoreRules()
    const roots = getRoots ? getRoots() : []
    const fileRules: IgnoreRule[] = []
    for (const r of roots) {
      fileRules.push(...readGenOfficeIgnore(r))
    }
    return [...userRules, ...fileRules]
  })

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.saveIgnoreRules, (_event, rules: unknown) => {
    if (!Array.isArray(rules) || rules.length > MAX_RULE_COUNT)
      return { ok: false, error: 'invalid-rules' }
    for (const r of rules) {
      if (!isValidIgnoreRule(r)) return { ok: false, error: 'invalid-rule-format' }
    }
    const userRules = rules.filter((r) => (r as IgnoreRule).source !== '.genofficeignore')
    const ok = setActiveIgnoreRules(userRules)
    if (!ok) {
      return { ok: false, error: 'persistence-failed' }
    }
    onInvalidate?.()
    return { ok: true }
  })

  ipcMain.handle(
    DOCUMENT_INDEX_CHANNELS.testIgnorePath,
    (_event, path: unknown, root?: unknown) => {
      if (typeof path !== 'string') return { ignored: false, reason: 'Invalid path' }
      const res = evaluateIgnore(path, typeof root === 'string' ? root : undefined)
      return {
        ignored: res.ignored,
        ruleId: res.matchedRule?.id,
        pattern: res.matchedRule?.pattern,
        reason: res.reason,
      }
    },
  )
}
