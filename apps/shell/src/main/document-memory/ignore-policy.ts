import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { IpcMain } from 'electron'
import {
  DOCUMENT_INDEX_CHANNELS,
  type GenOfficeIgnoreFileResult,
  type GenOfficeIgnoreSaveResult,
  type IgnorePolicyConfig,
  type IndexPolicyMode,
  type IndexRuleAction,
  type IndexingPreset,
} from '../../shared/fork/document-index-api'

export type { IndexRuleAction, IndexPolicyMode, IndexingPreset, IgnorePolicyConfig }

export interface IgnoreRule {
  id: string
  pattern: string
  enabled: boolean
  scope: 'global' | string
  description?: string
  source?: 'user' | '.genofficeignore' | 'preset'
  action?: IndexRuleAction
}

export interface IgnoreMatchResult {
  ignored: boolean
  matchedRule?: IgnoreRule
  reason?: string
  decision?: 'allow' | 'ignore'
  action?: IndexRuleAction
  source?: string
  scope?: string
  winningRule?: IgnoreRule
  overriddenRule?: IgnoreRule
  mode?: IndexPolicyMode
  eligibility?: 'supported' | 'unsupported' | 'outside-root' | 'invalid'
  hardGateBlocked?: boolean
  hardGateReason?: string
  explanation?: string
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

export const DEFAULT_INDEXING_PRESETS: readonly IndexingPreset[] = [
  {
    id: 'preset-common-docs',
    name: 'Common Documents',
    action: 'allow',
    category: 'recommended',
    description:
      'Allow standard document formats (PDF, Word, Excel, PowerPoint, Text, Markdown, HTML)',
    patterns: [
      '*.doc',
      '*.docx',
      '*.xls',
      '*.xlsx',
      '*.xlsm',
      '*.ppt',
      '*.pptx',
      '*.pdf',
      '*.txt',
      '*.csv',
      '*.tsv',
      '*.md',
      '*.markdown',
      '*.html',
    ],
  },
  {
    id: 'preset-dev-artifacts',
    name: 'Development Artifacts',
    action: 'ignore',
    category: 'protective',
    isProtective: true,
    description: 'Exclude build outputs, package managers, and version control directories',
    patterns: [
      '**/.git/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.next/**',
      '**/.nuxt/**',
      '**/.turbo/**',
      '**/.cache/**',
      '**/.venv/**',
      '**/venv/**',
      '**/__pycache__/**',
      '**/target/**',
      '**/.gradle/**',
      '**/.idea/**',
      '**/.vscode/**',
    ],
  },
  {
    id: 'preset-temp-files',
    name: 'Temporary Files',
    action: 'ignore',
    category: 'protective',
    isProtective: true,
    description: 'Exclude temporary files, backup files, and lock files',
    patterns: [
      '*.tmp',
      '*.temp',
      '*.bak',
      '*.old',
      '*.swp',
      '*.swo',
      '*.lock',
      '*.lck',
      '*.part',
      '*.partial',
      '*.crdownload',
      '~$*',
    ],
  },
  {
    id: 'preset-sensitive-locations',
    name: 'Sensitive Locations',
    action: 'ignore',
    category: 'protective',
    isProtective: true,
    description: 'Exclude credential directories and environment configuration files',
    patterns: [
      '**/.ssh/**',
      '**/.aws/**',
      '**/.gnupg/**',
      '**/.env',
      '**/.env.*',
      '**/secrets/**',
      '**/credentials/**',
      '**/private/**',
    ],
  },
  {
    id: 'preset-media',
    name: 'Media Files',
    action: 'allow',
    category: 'media',
    description: 'Allow supported image and video metadata indexing',
    patterns: [
      '*.jpg',
      '*.jpeg',
      '*.png',
      '*.webp',
      '*.gif',
      '*.bmp',
      '*.tiff',
      '*.mp4',
      '*.mov',
      '*.avi',
      '*.mkv',
    ],
  },
  {
    id: 'preset-advanced-docs',
    name: 'Advanced Developer Documents',
    action: 'allow',
    category: 'advanced',
    description: 'Allow Markdown and HTML documents',
    patterns: ['*.md', '*.markdown', '*.html', '*.htm'],
  },
]

const DEFAULT_PRESET_STATES: Record<string, boolean> = {
  'preset-common-docs': true,
  'preset-dev-artifacts': true,
  'preset-temp-files': true,
  'preset-sensitive-locations': true,
  'preset-media': false,
  'preset-advanced-docs': true,
}

// GenOffice supported index extensions (content or metadata)
const KNOWN_DOCUMENT_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.csv',
  '.tsv',
  '.ppt',
  '.pptx',
  '.pdf',
  '.md',
  '.markdown',
  '.html',
  '.htm',
  '.txt',
])

const KNOWN_MEDIA_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.tiff',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
])

export function isKnownSupportedExtension(ext: string): boolean {
  const lower = ext.toLowerCase()
  return KNOWN_DOCUMENT_EXTENSIONS.has(lower) || KNOWN_MEDIA_EXTENSIONS.has(lower)
}

const SENSITIVE_PATTERN_REGEX = /(\.ssh|\.aws|\.gnupg|\.env|secrets|credentials|private)/i

export function isSensitivePattern(pattern: string): boolean {
  return SENSITIVE_PATTERN_REGEX.test(pattern)
}

let activeRules: IgnoreRule[] = [...DEFAULT_IGNORE_RULES]
let policyMode: IndexPolicyMode = 'standard'
let activePresetStates: Record<string, boolean> = { ...DEFAULT_PRESET_STATES }
let storageFilePath: string | null = null
let policyGeneration = 1
let localCacheRevision = 0
let isWorkerReplica = false
let snapshotRoots: string[] = []

export interface IgnorePolicySnapshot {
  version: number
  rules: IgnoreRule[]
  roots: string[]
  mode?: IndexPolicyMode
  presets?: Record<string, boolean>
}

export type SnapshotApplyStatus = 'applied' | 'unchanged' | 'rejected-stale' | 'rejected-invalid'

export interface SnapshotApplyResult {
  applied: boolean
  status: SnapshotApplyStatus
  version: number
}

export interface IgnorePolicyChangeEvent {
  version: number
  reason: 'user-rules' | 'genofficeignore' | 'reload' | 'mode' | 'preset'
  affectedRoots?: string[]
  globalChanged: boolean
}

type IgnorePolicyListener = (event: IgnorePolicyChangeEvent) => void
const policyListeners = new Set<IgnorePolicyListener>()

export function subscribeIgnorePolicyChanges(listener: IgnorePolicyListener): () => void {
  policyListeners.add(listener)
  return () => {
    policyListeners.delete(listener)
  }
}

function emitIgnorePolicyChange(event: IgnorePolicyChangeEvent): void {
  for (const listener of policyListeners) {
    try {
      listener(event)
    } catch {
      // Listener errors must never break policy updates
    }
  }
}

export function getIgnorePolicyGeneration(): number {
  return policyGeneration
}

export function getLocalIgnoreCacheRevision(): number {
  return localCacheRevision
}

export function bumpIgnorePolicyGeneration(): void {
  policyGeneration++
  clearPolicyCaches()
}

function recordLocalGenOfficeIgnoreRevision(): boolean {
  localCacheRevision++
  if (isWorkerReplica) {
    return false
  }
  bumpIgnorePolicyGeneration()
  return true
}

export function setIgnoreStoragePath(path: string): void {
  isWorkerReplica = false
  storageFilePath = path
  loadPersistedIgnoreRules()
}

export function getIgnoreStoragePath(): string | null {
  return storageFilePath
}

export function getIndexingPolicyMode(): IndexPolicyMode {
  return policyMode
}

export function setIndexingPolicyMode(mode: IndexPolicyMode): boolean {
  if (mode !== 'standard' && mode !== 'allowlist') return false
  if (policyMode === mode) return true
  policyMode = mode
  persistCurrentConfiguration()
  bumpIgnorePolicyGeneration()
  emitIgnorePolicyChange({
    version: policyGeneration,
    reason: 'mode',
    globalChanged: true,
  })
  return true
}

export function getActivePolicyPresets(): IndexingPreset[] {
  return DEFAULT_INDEXING_PRESETS.map((p) => ({
    ...p,
    enabled: activePresetStates[p.id] ?? true,
  })) as IndexingPreset[]
}

export function setPolicyPresetState(presetId: string, enabled: boolean): boolean {
  const target = DEFAULT_INDEXING_PRESETS.find((p) => p.id === presetId)
  if (!target) return false
  activePresetStates[presetId] = enabled
  persistCurrentConfiguration()
  bumpIgnorePolicyGeneration()
  emitIgnorePolicyChange({
    version: policyGeneration,
    reason: 'preset',
    globalChanged: true,
  })
  return true
}

// ---------------------------------------------------------------------------
// Precompiled Rules & Performance Optimization
// ---------------------------------------------------------------------------

interface CompiledRule {
  raw: IgnoreRule
  action: IndexRuleAction
  isGlobal: boolean
  normScope: string
  normScopeLower: string
  isExtensionOnly: boolean
  extensionLower?: string
  regex: RegExp
  regexCI: RegExp
}

let compiledActiveRules: CompiledRule[] = []
let compiledRulesGeneration = -1

const regexCache = new Map<string, RegExp>()
const MAX_REGEX_CACHE = 1000

const evalCache = new Map<string, IgnoreMatchResult>()
const MAX_EVAL_CACHE = 10000

// Pruning-safety answers are memoized per directory and policy generation.
// shouldSkipDirectory() calls mayContainExplicitAllow() for every candidate
// pruned directory on the main thread, so an uncached lookup is a real
// traversal cost. The bound must stay above a typical folder count so a long
// walk does not evict its own answers.
interface AllowRuleIndex {
  scope: string | null
  scopeLower: string | null
  prefix: string | null
  prefixLower: string | null
}

let allowRuleIndex: AllowRuleIndex[] = []
let allowRuleIndexGeneration = -1
const allowCheckCache = new Map<string, boolean>()
const MAX_ALLOW_CHECK_CACHE = 50000

function setEvalCache(key: string, res: IgnoreMatchResult): void {
  if (evalCache.has(key)) {
    evalCache.delete(key)
  } else if (evalCache.size >= MAX_EVAL_CACHE) {
    const firstKey = evalCache.keys().next().value
    if (firstKey) evalCache.delete(firstKey)
  }
  evalCache.set(key, res)
}

export function clearRegexCache(): void {
  regexCache.clear()
  clearPolicyCaches()
}

function clearPolicyCaches(): void {
  regexCache.clear()
  evalCache.clear()
  allowCheckCache.clear()
  allowRuleIndexGeneration = -1
  compiledRulesGeneration = -1
}

export function isPathCaseInsensitive(p: string): boolean {
  return (
    process.platform === 'win32' ||
    /^[a-zA-Z]:[/\\]/.test(p) ||
    p.startsWith('\\\\') ||
    p.startsWith('//')
  )
}

function normalizePath(p: string): string {
  const isUnc = p.startsWith('\\\\') || p.startsWith('//')
  const unified = p.replace(/\\/g, '/').replace(/\/+/g, '/')
  return isUnc ? '/' + unified : unified
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

function compileSingleRule(rule: IgnoreRule): CompiledRule {
  const normScope = rule.scope !== 'global' ? normalizePath(rule.scope) : 'global'
  const normScopeLower = normScope.toLowerCase()
  const p = rule.pattern.trim()
  const isExtOnly = /^\*\.[a-zA-Z0-9_-]+$/.test(p)
  const ext = isExtOnly ? p.slice(1).toLowerCase() : undefined

  return {
    raw: rule,
    action: rule.action ?? 'ignore',
    isGlobal: rule.scope === 'global',
    normScope,
    normScopeLower,
    isExtensionOnly: isExtOnly,
    extensionLower: ext,
    regex: globToRegex(rule.pattern, false),
    regexCI: globToRegex(rule.pattern, true),
  }
}

function ensureCompiledRules(): CompiledRule[] {
  if (compiledRulesGeneration === policyGeneration) {
    return compiledActiveRules
  }
  compiledActiveRules = activeRules.map(compileSingleRule)
  compiledRulesGeneration = policyGeneration
  return compiledActiveRules
}

function isSubpathOrEqual(target: string, scope: string): boolean {
  const normTarget = normalizePath(target)
  const normScope = normalizePath(scope)
  const isCI = isPathCaseInsensitive(normTarget) || isPathCaseInsensitive(normScope)
  const t = isCI ? normTarget.toLowerCase() : normTarget
  const s = isCI ? normScope.toLowerCase() : normScope
  return t === s || t.startsWith(s.endsWith('/') ? s : s + '/')
}

export function scopesIntersect(configuredRoot: string, ruleScope: string): boolean {
  const normRoot = normalizePath(configuredRoot)
  const normScope = normalizePath(ruleScope)
  const isCI = isPathCaseInsensitive(normRoot) || isPathCaseInsensitive(normScope)
  const r = isCI ? normRoot.toLowerCase() : normRoot
  const s = isCI ? normScope.toLowerCase() : normScope
  return isSubpathOrEqual(r, s) || isSubpathOrEqual(s, r)
}

// ---------------------------------------------------------------------------
// .genofficeignore Parser, Cache, and Atomic Writer
// ---------------------------------------------------------------------------

interface CachedIgnore {
  mtimeMs: number
  size: number
  ino: number
  raw: string | null
  rules: IgnoreRule[]
  mode?: IndexPolicyMode
  validationErrors?: string[]
}

const genOfficeIgnoreCache = new Map<string, CachedIgnore>()
const MAX_GENOFFICEIGNORE_CACHE = 150

let knownRootsResolver: (() => string[]) | null = null

export function setKnownRootsResolver(resolver: () => string[]): void {
  knownRootsResolver = resolver
}

export function clearGenOfficeIgnoreCache(): void {
  genOfficeIgnoreCache.clear()
  clearPolicyCaches()
}

export function parseGenOfficeIgnoreContent(
  dir: string,
  content: string,
): {
  rules: IgnoreRule[]
  mode?: IndexPolicyMode
  validationErrors: string[]
} {
  const lines = content.split(/\r?\n/)
  const rules: IgnoreRule[] = []
  const validationErrors: string[] = []
  const seenPatterns = new Set<string>()
  let rootMode: IndexPolicyMode | undefined
  let idx = 0

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex]!
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    // Directives
    if (line.startsWith('@')) {
      const parts = line.slice(1).trim().split(/\s+/)
      const directive = parts[0]?.toLowerCase()
      const value = parts[1]?.toLowerCase()

      if (directive === 'mode') {
        if (value === 'standard' || value === 'allowlist') {
          rootMode = value
        } else {
          validationErrors.push(
            `Line ${lineIndex + 1}: Unknown mode "${parts[1] || ''}". Expected "standard" or "allowlist".`,
          )
        }
      } else {
        validationErrors.push(`Line ${lineIndex + 1}: Unknown directive "@${directive}".`)
      }
      continue
    }

    // Explicit Allow prefix '!'
    let action: IndexRuleAction = 'ignore'
    let pattern = line
    if (line.startsWith('!')) {
      action = 'allow'
      pattern = line.slice(1).trim()
    }

    if (!pattern) {
      validationErrors.push(`Line ${lineIndex + 1}: Empty pattern after '!'.`)
      continue
    }

    // Deduplicate identical pattern within the same file
    const dedupeKey = `${action}:${pattern}`
    if (seenPatterns.has(dedupeKey)) continue
    seenPatterns.add(dedupeKey)

    idx++
    rules.push({
      id: `.genofficeignore-${idx}-${action}-${pattern}`,
      pattern,
      enabled: true,
      scope: dir,
      source: '.genofficeignore',
      action,
      description: `.genofficeignore (${action}) in ${dir}`,
    })
  }

  return { rules, mode: rootMode, validationErrors }
}

function setCachedIgnoreEntry(dir: string, entry: CachedIgnore): void {
  if (!genOfficeIgnoreCache.has(dir) && genOfficeIgnoreCache.size >= MAX_GENOFFICEIGNORE_CACHE) {
    const firstKey = genOfficeIgnoreCache.keys().next().value
    if (firstKey) genOfficeIgnoreCache.delete(firstKey)
  }
  genOfficeIgnoreCache.set(dir, entry)
}

export function readGenOfficeIgnore(dir: string): IgnoreRule[] {
  const res = readGenOfficeIgnoreDetailed(dir)
  return res.rules
}

export function readGenOfficeIgnoreDetailed(dir: string): {
  rules: IgnoreRule[]
  mode?: IndexPolicyMode
  validationErrors?: string[]
} {
  const filePath = resolve(dir, '.genofficeignore')
  const cached = genOfficeIgnoreCache.get(dir)
  try {
    if (!existsSync(filePath)) {
      if (cached && cached.raw !== null) {
        if (!existsSync(dir)) {
          return { rules: cached.rules, mode: cached.mode }
        }
        setCachedIgnoreEntry(dir, {
          mtimeMs: -1,
          size: -1,
          ino: -1,
          raw: null,
          rules: [],
        })
        if (recordLocalGenOfficeIgnoreRevision()) {
          emitIgnorePolicyChange({
            version: policyGeneration,
            reason: 'genofficeignore',
            affectedRoots: [dir],
            globalChanged: false,
          })
        }
      } else if (!cached) {
        setCachedIgnoreEntry(dir, {
          mtimeMs: -1,
          size: -1,
          ino: -1,
          raw: null,
          rules: [],
        })
      }
      return { rules: [] }
    }
    const stat = statSync(filePath)
    if (
      cached &&
      cached.raw !== null &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size &&
      cached.ino === stat.ino
    ) {
      return {
        rules: cached.rules,
        mode: cached.mode,
        validationErrors: cached.validationErrors,
      }
    }
    const content = readFileSync(filePath, 'utf-8')
    if (cached && cached.raw === content) {
      cached.mtimeMs = stat.mtimeMs
      cached.size = stat.size
      cached.ino = stat.ino
      return {
        rules: cached.rules,
        mode: cached.mode,
        validationErrors: cached.validationErrors,
      }
    }
    const hadPrevious = cached !== undefined
    const bumpedAuthoritative = recordLocalGenOfficeIgnoreRevision()
    const parsed = parseGenOfficeIgnoreContent(dir, content)
    setCachedIgnoreEntry(dir, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      ino: stat.ino,
      raw: content,
      rules: parsed.rules,
      mode: parsed.mode,
      validationErrors: parsed.validationErrors,
    })
    if (hadPrevious && bumpedAuthoritative) {
      emitIgnorePolicyChange({
        version: policyGeneration,
        reason: 'genofficeignore',
        affectedRoots: [dir],
        globalChanged: false,
      })
    }
    return {
      rules: parsed.rules,
      mode: parsed.mode,
      validationErrors: parsed.validationErrors,
    }
  } catch {
    if (cached && cached.raw !== null) {
      return { rules: cached.rules, mode: cached.mode }
    }
    try {
      if (existsSync(filePath)) {
        const normalizedRoot = resolve(dir)
        const fallbackRules: IgnoreRule[] = [
          {
            id: `genofficeignore-${dir}-unreadable`,
            pattern: '**',
            enabled: true,
            scope: normalizedRoot,
            description: 'Rule from .genofficeignore (unreadable)',
            action: 'ignore',
            source: '.genofficeignore',
          },
        ]
        return { rules: fallbackRules }
      }
    } catch {
      // ignore secondary stat failure
    }
    return { rules: [] }
  }
}

export function refreshGenOfficeIgnoreForRoot(dir: string): boolean {
  const filePath = resolve(dir, '.genofficeignore')
  try {
    const cached = genOfficeIgnoreCache.get(dir)
    if (!existsSync(filePath)) {
      if (!cached || cached.raw === null) {
        if (!cached) {
          setCachedIgnoreEntry(dir, {
            mtimeMs: -1,
            size: -1,
            ino: -1,
            raw: null,
            rules: [],
          })
        }
        return false
      }
      if (!existsSync(dir)) {
        return false
      }
      setCachedIgnoreEntry(dir, {
        mtimeMs: -1,
        size: -1,
        ino: -1,
        raw: null,
        rules: [],
      })
      isWorkerReplica = false
      localCacheRevision++
      bumpIgnorePolicyGeneration()
      emitIgnorePolicyChange({
        version: policyGeneration,
        reason: 'genofficeignore',
        affectedRoots: [dir],
        globalChanged: false,
      })
      return true
    }
    const stat = statSync(filePath)
    const content = readFileSync(filePath, 'utf-8')
    if (cached && cached.raw === content) {
      cached.mtimeMs = stat.mtimeMs
      cached.size = stat.size
      cached.ino = stat.ino
      return false
    }
    const parsed = parseGenOfficeIgnoreContent(dir, content)
    setCachedIgnoreEntry(dir, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      ino: stat.ino,
      raw: content,
      rules: parsed.rules,
      mode: parsed.mode,
      validationErrors: parsed.validationErrors,
    })
    isWorkerReplica = false
    localCacheRevision++
    bumpIgnorePolicyGeneration()
    emitIgnorePolicyChange({
      version: policyGeneration,
      reason: 'genofficeignore',
      affectedRoots: [dir],
      globalChanged: false,
    })
    return true
  } catch {
    return false
  }
}

export function getGenOfficeIgnoreFileData(root: string): GenOfficeIgnoreFileResult {
  const normalizedRoot = resolve(root)
  const filePath = resolve(normalizedRoot, '.genofficeignore')
  try {
    if (!existsSync(filePath)) {
      return {
        exists: false,
        content: '',
        rules: [],
        mode: undefined,
      }
    }
    const stat = statSync(filePath)
    const content = readFileSync(filePath, 'utf-8')
    const parsed = parseGenOfficeIgnoreContent(normalizedRoot, content)
    const revision = createHash('sha256').update(content).digest('hex')
    return {
      exists: true,
      content,
      rules: parsed.rules,
      mode: parsed.mode,
      mtimeMs: stat.mtimeMs,
      revision,
    }
  } catch (err) {
    return {
      exists: false,
      content: '',
      rules: [],
      error: err instanceof Error ? err.message : 'Failed to read file',
    }
  }
}

const MAX_GENOFFICEIGNORE_SIZE_BYTES = 512 * 1024 // 512 KB

function isRestrictedRoot(rootPath: string): boolean {
  const norm = resolve(rootPath).replace(/\\/g, '/')
  const lower = norm.toLowerCase()
  if (norm === '/' || /^[a-zA-Z]:\/?$/.test(norm)) return true
  const restrictedPrefixes = [
    '/etc',
    '/bin',
    '/sbin',
    '/usr',
    '/system',
    '/library',
    '/windows',
    '/program files',
    '/program files (x86)',
  ]
  for (const prefix of restrictedPrefixes) {
    if (lower === prefix || lower.startsWith(prefix + '/')) return true
    if (lower.length >= 2 && lower[1] === ':') {
      const driveRelative = lower.slice(2)
      if (driveRelative === prefix || driveRelative.startsWith(prefix + '/')) return true
    }
  }
  return false
}

export function writeGenOfficeIgnoreFile(
  root: string,
  content: string,
  expectedRevision?: string,
): GenOfficeIgnoreSaveResult {
  try {
    const normalizedRoot = resolve(root)
    if (isRestrictedRoot(normalizedRoot)) {
      return { ok: false, error: 'Restricted path' }
    }

    if (!existsSync(normalizedRoot)) {
      return { ok: false, error: 'Root directory does not exist' }
    }

    // Safety: root must be a directory
    const dirStat = statSync(normalizedRoot)
    if (!dirStat.isDirectory()) {
      return { ok: false, error: 'Root is not a directory' }
    }

    const filePath = resolve(normalizedRoot, '.genofficeignore')

    // Reject symlinks masquerading as configuration file
    try {
      const lstat = lstatSync(filePath)
      if (lstat.isSymbolicLink()) {
        return { ok: false, error: 'Cannot overwrite symbolic link' }
      }
    } catch {
      // File does not exist yet or cannot lstat
    }

    if (existsSync(filePath)) {
      // Check concurrent edit conflict
      if (expectedRevision) {
        const currentContent = readFileSync(filePath, 'utf-8')
        const currentRev = createHash('sha256').update(currentContent).digest('hex')
        if (currentRev !== expectedRevision) {
          return {
            ok: false,
            error: 'conflict',
            revision: currentRev,
          }
        }
      }
    }

    // Size check
    const contentBuffer = Buffer.from(content, 'utf-8')
    if (contentBuffer.length > MAX_GENOFFICEIGNORE_SIZE_BYTES) {
      return { ok: false, error: 'File exceeds maximum allowed size (512KB)' }
    }

    // Syntax validation
    const parsed = parseGenOfficeIgnoreContent(normalizedRoot, content)
    if (parsed.validationErrors.length > 0) {
      // Directives errors or invalid patterns
      const hasFatalErrors = parsed.validationErrors.some(
        (e) =>
          e.includes('Unknown directive') ||
          e.includes('Unknown mode') ||
          e.includes('Empty pattern'),
      )
      if (hasFatalErrors) {
        return {
          ok: false,
          error: 'invalid-syntax',
          validationErrors: parsed.validationErrors,
        }
      }
    }

    // Atomic temporary-file replacement
    mkdirSync(normalizedRoot, { recursive: true })
    const tmpFile = resolve(
      normalizedRoot,
      `.genofficeignore.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
    )
    writeFileSync(tmpFile, content, { mode: 0o600 })
    renameSync(tmpFile, filePath)

    // Invalidate and emit
    refreshGenOfficeIgnoreForRoot(normalizedRoot)

    const newRev = createHash('sha256').update(content).digest('hex')
    return {
      ok: true,
      revision: newRev,
      validationErrors: parsed.validationErrors.length > 0 ? parsed.validationErrors : undefined,
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Save failed',
    }
  }
}

// ---------------------------------------------------------------------------
// Persistence and Snapshot Management
// ---------------------------------------------------------------------------

export function getActiveIgnoreRules(): IgnoreRule[] {
  return [...activeRules]
}

function persistCurrentConfiguration(): boolean {
  if (!storageFilePath) return true
  try {
    mkdirSync(dirname(storageFilePath), { recursive: true })
    const tmp = `${storageFilePath}.tmp.${process.pid}`
    const payload = {
      schemaVersion: 2,
      mode: policyMode,
      presets: activePresetStates,
      rules: activeRules,
    }
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
    renameSync(tmp, storageFilePath)
    return true
  } catch {
    return false
  }
}

export function persistIgnoreRules(): boolean {
  return persistCurrentConfiguration()
}

export const MAX_RULE_COUNT = 500
export const MAX_PATTERN_LENGTH = 500
export const MAX_ID_LENGTH = 100
export const MAX_SCOPE_LENGTH = 500

function ruleSignature(r: IgnoreRule): string {
  return `${r.id}\0${r.pattern}\0${r.enabled ? '1' : '0'}\0${r.scope}\0${r.action ?? 'ignore'}`
}

function areRulesEquivalent(a: readonly IgnoreRule[], b: readonly IgnoreRule[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const ra = a[i]!
    const rb = b[i]!
    if (
      ra.id !== rb.id ||
      ra.pattern !== rb.pattern ||
      ra.enabled !== rb.enabled ||
      ra.scope !== rb.scope ||
      ra.description !== rb.description ||
      ra.source !== rb.source ||
      (ra.action ?? 'ignore') !== (rb.action ?? 'ignore')
    ) {
      return false
    }
  }
  return true
}

function areRootsEquivalent(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function computeChangedRules(
  prev: readonly IgnoreRule[],
  next: readonly IgnoreRule[],
): IgnoreRule[] {
  const prevBySig = new Map<string, IgnoreRule>()
  for (const r of prev) prevBySig.set(ruleSignature(r), r)
  const nextBySig = new Map<string, IgnoreRule>()
  for (const r of next) nextBySig.set(ruleSignature(r), r)

  const changed: IgnoreRule[] = []
  for (const [sig, rule] of prevBySig) {
    if (!nextBySig.has(sig)) changed.push(rule)
  }
  for (const [sig, rule] of nextBySig) {
    if (!prevBySig.has(sig)) changed.push(rule)
  }
  return changed
}

export function setActiveIgnoreRules(rules: IgnoreRule[]): boolean {
  if (rules.length > MAX_RULE_COUNT) return false
  for (const r of rules) {
    if (!isValidIgnoreRule(r)) return false
  }
  // Preserve exact input object attributes (e.g. action is only set if provided)
  const candidate = rules.map((r) => ({ ...r }))
  const prevRules = activeRules
  activeRules = candidate
  const ok = persistCurrentConfiguration()
  if (!ok) {
    activeRules = prevRules
    return false
  }
  isWorkerReplica = false
  const changed = computeChangedRules(prevRules, candidate)
  bumpIgnorePolicyGeneration()
  if (changed.length > 0) {
    const globalChanged = changed.some((r) => r.scope === 'global')
    const affectedRoots = globalChanged ? undefined : [...new Set(changed.map((r) => r.scope))]
    emitIgnorePolicyChange({
      version: policyGeneration,
      reason: 'user-rules',
      ...(affectedRoots ? { affectedRoots } : {}),
      globalChanged,
    })
  }
  return true
}

export function setFullPolicyConfig(config: Partial<IgnorePolicyConfig>): boolean {
  if (config.rules && (!Array.isArray(config.rules) || config.rules.length > MAX_RULE_COUNT)) {
    return false
  }
  if (config.rules) {
    for (const r of config.rules) {
      if (!isValidIgnoreRule(r)) return false
    }
  }

  const prevRules = activeRules
  const prevMode = policyMode
  const prevPresets = { ...activePresetStates }

  if (config.rules) {
    activeRules = config.rules.map((r) => ({ ...r }))
  }
  if (config.mode === 'standard' || config.mode === 'allowlist') {
    policyMode = config.mode
  }
  if (config.presets) {
    activePresetStates = { ...activePresetStates, ...config.presets }
  }

  const ok = persistCurrentConfiguration()
  if (!ok) {
    activeRules = prevRules
    policyMode = prevMode
    activePresetStates = prevPresets
    return false
  }

  isWorkerReplica = false
  bumpIgnorePolicyGeneration()
  emitIgnorePolicyChange({
    version: policyGeneration,
    reason: 'user-rules',
    globalChanged: true,
  })
  return true
}

export function getFullPolicyConfig(): IgnorePolicyConfig {
  return {
    schemaVersion: 2,
    mode: policyMode,
    rules: activeRules.map((r) => ({ ...r })),
    presets: { ...activePresetStates },
  }
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
    (rule.source === undefined ||
      rule.source === 'user' ||
      rule.source === '.genofficeignore' ||
      rule.source === 'preset') &&
    (rule.action === undefined || rule.action === 'allow' || rule.action === 'ignore')
  )
}

export function isValidIgnorePolicySnapshot(snapshot: unknown): snapshot is IgnorePolicySnapshot {
  if (typeof snapshot !== 'object' || snapshot === null) return false
  const s = snapshot as Partial<IgnorePolicySnapshot>
  if (typeof s.version !== 'number' || !Number.isSafeInteger(s.version) || s.version < 1) {
    return false
  }
  if (!Array.isArray(s.rules) || s.rules.length > MAX_RULE_COUNT) {
    return false
  }
  for (const rule of s.rules) {
    if (!isValidIgnoreRule(rule)) return false
  }
  if (!Array.isArray(s.roots) || s.roots.length > MAX_RULE_COUNT) {
    return false
  }
  for (const root of s.roots) {
    if (typeof root !== 'string' || root.length === 0 || root.length > MAX_SCOPE_LENGTH) {
      return false
    }
  }
  if (s.mode !== undefined && s.mode !== 'standard' && s.mode !== 'allowlist') {
    return false
  }
  return true
}

export function getIgnorePolicySnapshot(extraRoots?: readonly string[]): IgnorePolicySnapshot {
  let configuredRoots: string[]
  try {
    configuredRoots = knownRootsResolver ? knownRootsResolver() : snapshotRoots
  } catch {
    configuredRoots = snapshotRoots
  }
  const mergedRoots: string[] = []
  const seenRoots = new Set<string>()
  for (const root of [...configuredRoots, ...(extraRoots ?? [])]) {
    if (
      typeof root === 'string' &&
      root.length > 0 &&
      root.length <= MAX_SCOPE_LENGTH &&
      !seenRoots.has(root)
    ) {
      seenRoots.add(root)
      mergedRoots.push(root)
      if (mergedRoots.length >= MAX_RULE_COUNT) break
    }
  }
  return {
    version: Math.max(1, policyGeneration),
    rules: activeRules.map((r) => ({ ...r })),
    roots: mergedRoots,
    mode: policyMode,
    presets: { ...activePresetStates },
  }
}

export function applyIgnorePolicySnapshotDetailed(snapshot: unknown): SnapshotApplyResult {
  if (!isValidIgnorePolicySnapshot(snapshot)) {
    return {
      applied: false,
      status: 'rejected-invalid',
      version: policyGeneration,
    }
  }
  if (snapshot.version < policyGeneration) {
    return {
      applied: false,
      status: 'rejected-stale',
      version: policyGeneration,
    }
  }
  const candidateRules = snapshot.rules.map((r) => ({ ...r }))
  const candidateRoots = [...new Set(snapshot.roots)]
  const candidateMode = snapshot.mode ?? 'standard'
  const candidatePresets = snapshot.presets ?? { ...DEFAULT_PRESET_STATES }

  const rulesChanged = !areRulesEquivalent(activeRules, candidateRules)
  const rootsChanged = !areRootsEquivalent(snapshotRoots, candidateRoots)
  const modeChanged = policyMode !== candidateMode
  const presetsChanged = JSON.stringify(activePresetStates) !== JSON.stringify(candidatePresets)

  if (isWorkerReplica && snapshot.version === policyGeneration) {
    if (!rulesChanged && !rootsChanged && !modeChanged && !presetsChanged) {
      return {
        applied: true,
        status: 'unchanged',
        version: policyGeneration,
      }
    }
    if (rulesChanged) {
      activeRules = candidateRules
      clearPolicyCaches()
    }
    if (modeChanged) {
      policyMode = candidateMode
    }
    if (presetsChanged) {
      activePresetStates = { ...candidatePresets }
    }
    if (rootsChanged) {
      const nextRootSet = new Set(candidateRoots)
      for (const cachedDir of genOfficeIgnoreCache.keys()) {
        if (!nextRootSet.has(cachedDir)) {
          genOfficeIgnoreCache.delete(cachedDir)
        }
      }
      snapshotRoots = candidateRoots
    }
    return {
      applied: true,
      status: 'applied',
      version: policyGeneration,
    }
  }

  isWorkerReplica = true
  activeRules = candidateRules
  snapshotRoots = candidateRoots
  policyMode = candidateMode
  activePresetStates = { ...candidatePresets }
  policyGeneration = snapshot.version
  clearPolicyCaches()
  clearGenOfficeIgnoreCache()

  return {
    applied: true,
    status: 'applied',
    version: policyGeneration,
  }
}

export function applyIgnorePolicySnapshot(snapshot: unknown): boolean {
  return applyIgnorePolicySnapshotDetailed(snapshot).applied
}

export function loadPersistedIgnoreRules(): IgnoreRule[] {
  isWorkerReplica = false
  if (!storageFilePath || !existsSync(storageFilePath)) {
    return activeRules
  }
  try {
    const raw = readFileSync(storageFilePath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown

    if (Array.isArray(parsed)) {
      // Legacy format (Array of rules)
      activeRules = parsed.filter(isValidIgnoreRule).map((r) => ({ ...r }))
      policyMode = 'standard'
    } else if (typeof parsed === 'object' && parsed !== null) {
      const cfg = parsed as {
        schemaVersion?: unknown
        mode?: unknown
        rules?: unknown
        presets?: unknown
      }

      // Reject future unsupported schema versions without destroying file
      if (typeof cfg.schemaVersion === 'number' && cfg.schemaVersion > 2) {
        return activeRules
      }

      if (cfg.mode === 'standard' || cfg.mode === 'allowlist') {
        policyMode = cfg.mode
      }
      if (Array.isArray(cfg.rules)) {
        activeRules = cfg.rules.filter(isValidIgnoreRule).map((r) => ({ ...r }))
      }
      if (cfg.presets && typeof cfg.presets === 'object' && !Array.isArray(cfg.presets)) {
        activePresetStates = {
          ...DEFAULT_PRESET_STATES,
          ...(cfg.presets as Record<string, boolean>),
        }
      }
    }
  } catch {
    // Keep in-memory rules on read failure
  }
  bumpIgnorePolicyGeneration()
  return activeRules
}

export function resolveIndexedRoot(targetPath: string, explicitRoot?: string): string | undefined {
  if (explicitRoot) return explicitRoot
  try {
    const roots = knownRootsResolver ? knownRootsResolver() : snapshotRoots
    if (!roots || roots.length === 0) return undefined
    const matching = roots.filter((r) => isSubpathOrEqual(targetPath, r))
    if (matching.length === 0) return undefined
    return matching.sort((a, b) => b.length - a.length)[0]
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Traversal Safety Check
// ---------------------------------------------------------------------------

/**
 * Literal leading path segments of a glob, up to the first wildcard.
 * "2026/reports/**" => "2026/reports"; "**/target.docx" => null.
 */
function literalPatternPrefix(pattern: string): string | null {
  const p = pattern.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!p) return null

  const segments: string[] = []
  for (const part of p.split('/')) {
    if (!part || part.includes('*') || part.includes('?') || part.includes('[')) break
    segments.push(part)
  }
  return segments.length > 0 ? segments.join('/') : null
}

/** Rebuild the allow-rule index once per policy generation. */
function ensureAllowRuleIndex(): AllowRuleIndex[] {
  if (allowRuleIndexGeneration === policyGeneration) return allowRuleIndex

  const built: AllowRuleIndex[] = []
  for (const rule of activeRules) {
    if (!rule.enabled || rule.action !== 'allow') continue
    const scope = rule.scope !== 'global' ? normalizePath(rule.scope).replace(/\/+$/, '') : null
    const prefix = literalPatternPrefix(rule.pattern)
    built.push({
      scope,
      scopeLower: scope ? scope.toLowerCase() : null,
      prefix,
      prefixLower: prefix ? prefix.toLowerCase() : null,
    })
  }

  allowRuleIndex = built
  allowRuleIndexGeneration = policyGeneration
  return built
}

/**
 * Can the subtree an allow rule matches ever live inside this directory?
 * Every test is a path-component boundary test; a bare substring match would
 * rescue "2026/reportsX" for prefix "2026/reports", which is the bug this fixes.
 */
function prefixRescuesDirectory(dirComp: string, prefix: string): boolean {
  if (dirComp === prefix) return true
  // the allowed subtree sits inside this directory
  if (prefix.startsWith(dirComp + '/')) return true
  // this directory is inside the allowed subtree
  if (dirComp.startsWith(prefix + '/') || dirComp === prefix) return true
  // relative patterns match anywhere, so the directory may be deeper inside
  // the matched subtree or end exactly on its literal prefix
  return dirComp.endsWith('/' + prefix) || dirComp.includes('/' + prefix + '/')
}

/**
 * Determines whether a directory may contain an explicitly allowed descendant,
 * or is itself inside an allowed scope. Prevents pruning directories that hold
 * specifically allowed files without re-walking the rule set per directory.
 */
export function mayContainExplicitAllow(dirPath: string, root?: string): boolean {
  const normDir = normalizePath(dirPath).replace(/\/+$/, '')
  const isCI = isPathCaseInsensitive(dirPath)
  const dirComp = isCI ? normDir.toLowerCase() : normDir
  const cacheKey = `${dirComp}::${policyGeneration}`

  const cached = allowCheckCache.get(cacheKey)
  if (cached !== undefined) return cached

  let result = false

  // 1. Active user rules: a scoped rule overlapping this directory, or a
  //    global pattern whose literal prefix touches this directory.
  for (const entry of ensureAllowRuleIndex()) {
    if (entry.scope) {
      const s = isCI ? entry.scopeLower! : entry.scope
      if (s === dirComp || s.startsWith(dirComp + '/') || dirComp.startsWith(s)) {
        result = true
        break
      }
    }
    if (!result && entry.prefix) {
      const p = isCI ? entry.prefixLower! : entry.prefix
      if (prefixRescuesDirectory(dirComp, p)) {
        result = true
        break
      }
    }
  }

  // 2. .genofficeignore in the owning root (already cached by mtime/size/ino).
  if (!result) {
    const resolvedRoot = resolveIndexedRoot(dirPath, root)
    if (resolvedRoot) {
      for (const rule of readGenOfficeIgnoreDetailed(resolvedRoot).rules) {
        if (!rule.enabled || rule.action !== 'allow') continue
        const scope = normalizePath(rule.scope).replace(/\/+$/, '')
        const s = isCI ? scope.toLowerCase() : scope
        if (s === dirComp || s.startsWith(dirComp + '/') || dirComp.startsWith(s)) {
          result = true
          break
        }
        const prefix = literalPatternPrefix(rule.pattern)
        if (!prefix) continue
        const p = isCI ? prefix.toLowerCase() : prefix
        if (prefixRescuesDirectory(dirComp, p)) {
          result = true
          break
        }
      }
    }
  }

  if (allowCheckCache.size >= MAX_ALLOW_CHECK_CACHE) {
    const firstKey = allowCheckCache.keys().next().value
    if (firstKey) allowCheckCache.delete(firstKey)
  }
  allowCheckCache.set(cacheKey, result)
  return result
}

// ---------------------------------------------------------------------------
// Evaluator: Deterministic Precedence Engine
// ---------------------------------------------------------------------------

function matchCompiledRule(
  cRule: CompiledRule,
  normTarget: string,
  relPath: string,
  normRoot: string | undefined,
  isCI: boolean,
  extLower: string,
): boolean {
  if (!cRule.raw.enabled) return false

  // Scope check
  if (!cRule.isGlobal) {
    const scopeBase = isCI ? cRule.normScopeLower : cRule.normScope
    const targetComp = isCI ? normTarget.toLowerCase() : normTarget
    const isInsideScope =
      targetComp === scopeBase ||
      targetComp.startsWith(scopeBase.endsWith('/') ? scopeBase : scopeBase + '/')

    if (!isInsideScope) return false

    if (normRoot) {
      const rootComp = isCI ? normRoot.toLowerCase() : normRoot
      const rootInsideScope =
        rootComp === scopeBase ||
        rootComp.startsWith(scopeBase.endsWith('/') ? scopeBase : scopeBase + '/')
      const scopeInsideRoot =
        scopeBase === rootComp ||
        scopeBase.startsWith(rootComp.endsWith('/') ? rootComp : rootComp + '/')
      if (!rootInsideScope && !scopeInsideRoot) return false
    }
  }

  // Fast path: extension only (*.tmp, *.docx)
  if (cRule.isExtensionOnly && cRule.extensionLower) {
    if (extLower === cRule.extensionLower) {
      return true
    }
  }

  // Regex match
  const regex = isCI ? cRule.regexCI : cRule.regex
  try {
    return regex.test(normTarget) || (relPath.length > 0 && regex.test(relPath))
  } catch {
    return false
  }
}

export function evaluateIgnore(targetPath: string, root?: string): IgnoreMatchResult {
  const normTarget = normalizePath(targetPath)
  const resolvedRoot = resolveIndexedRoot(targetPath, root)
  const normRoot = resolvedRoot ? normalizePath(resolvedRoot) : undefined
  const cacheKey = `${normTarget}::${normRoot ?? ''}::${policyGeneration}`

  const cached = evalCache.get(cacheKey)
  if (cached) {
    evalCache.delete(cacheKey)
    evalCache.set(cacheKey, cached)
    return cached
  }

  const isCI =
    isPathCaseInsensitive(targetPath) ||
    (resolvedRoot ? isPathCaseInsensitive(resolvedRoot) : false)

  const ext = extname(normTarget).toLowerCase()
  const isSupportedExt = isKnownSupportedExtension(ext)
  const isOutsideRoots = Boolean(snapshotRoots.length > 0 && !resolvedRoot)

  const scopeBase = normRoot
  const relPath =
    scopeBase && isSubpathOrEqual(normTarget, scopeBase)
      ? isSubpathOrEqual(scopeBase, normTarget)
        ? ''
        : normTarget.slice(scopeBase.length).replace(/^\/+/, '')
      : normTarget

  // Effective mode: .genofficeignore in root overrides global mode
  let effectiveMode = policyMode
  let rootRules: IgnoreRule[] = []
  if (resolvedRoot) {
    const rootDetails = readGenOfficeIgnoreDetailed(resolvedRoot)
    if (rootDetails.mode) {
      effectiveMode = rootDetails.mode
    }
    rootRules = rootDetails.rules
  }

  const active = ensureCompiledRules()
  const compiledRootRules = rootRules.map(compileSingleRule)

  // -------------------------------------------------------------------------
  // Level 1: Explicit User / .genofficeignore Allow rules
  // -------------------------------------------------------------------------
  let winningAllowRule: IgnoreRule | undefined
  for (const cRule of active) {
    if (
      cRule.action === 'allow' &&
      matchCompiledRule(cRule, normTarget, relPath, normRoot, isCI, ext)
    ) {
      winningAllowRule = cRule.raw
      break
    }
  }
  if (!winningAllowRule) {
    for (const cRule of compiledRootRules) {
      if (
        cRule.action === 'allow' &&
        matchCompiledRule(cRule, normTarget, relPath, normRoot, isCI, ext)
      ) {
        winningAllowRule = cRule.raw
        break
      }
    }
  }

  // -------------------------------------------------------------------------
  // Level 2 / 3: Configured Ignore rules (User, .genofficeignore, or preset rules)
  // -------------------------------------------------------------------------
  let matchingIgnoreRule: IgnoreRule | undefined
  for (const cRule of active) {
    if (
      cRule.action === 'ignore' &&
      matchCompiledRule(cRule, normTarget, relPath, normRoot, isCI, ext)
    ) {
      matchingIgnoreRule = cRule.raw
      break
    }
  }
  if (!matchingIgnoreRule) {
    for (const cRule of compiledRootRules) {
      if (
        cRule.action === 'ignore' &&
        matchCompiledRule(cRule, normTarget, relPath, normRoot, isCI, ext)
      ) {
        matchingIgnoreRule = cRule.raw
        break
      }
    }
  }

  // Level 1 Explicit Allow overrides Level 2 Ignore
  if (winningAllowRule) {
    const res: IgnoreMatchResult = {
      ignored: false,
      decision: 'allow',
      action: 'allow',
      source: winningAllowRule.source ?? 'user',
      scope: winningAllowRule.scope,
      matchedRule: winningAllowRule,
      winningRule: winningAllowRule,
      overriddenRule: matchingIgnoreRule,
      mode: effectiveMode,
      eligibility: isOutsideRoots ? 'outside-root' : isSupportedExt ? 'supported' : 'unsupported',
      reason: matchingIgnoreRule
        ? `Explicit Allow rule "${winningAllowRule.pattern}" overrides Ignore rule "${matchingIgnoreRule.pattern}"`
        : `Allowed by explicit rule "${winningAllowRule.pattern}" (${winningAllowRule.description || winningAllowRule.scope})`,
      explanation: matchingIgnoreRule
        ? `Admitted: The explicit Allow rule "${winningAllowRule.pattern}" took precedence over the conflicting Ignore rule "${matchingIgnoreRule.pattern}".`
        : `Admitted: Matched explicit Allow rule "${winningAllowRule.pattern}".`,
    }
    setEvalCache(cacheKey, res)
    return res
  }

  // Matching Ignore rule excludes the file
  if (matchingIgnoreRule) {
    const isFromGenOffice = matchingIgnoreRule.source === '.genofficeignore'
    const res: IgnoreMatchResult = {
      ignored: true,
      decision: 'ignore',
      action: 'ignore',
      source: matchingIgnoreRule.source ?? 'user',
      scope: matchingIgnoreRule.scope,
      matchedRule: matchingIgnoreRule,
      winningRule: matchingIgnoreRule,
      mode: effectiveMode,
      eligibility: isOutsideRoots ? 'outside-root' : isSupportedExt ? 'supported' : 'unsupported',
      reason: isFromGenOffice
        ? `Excluded by .genofficeignore rule "${matchingIgnoreRule.pattern}"`
        : `Excluded by rule "${matchingIgnoreRule.pattern}" (${matchingIgnoreRule.description || matchingIgnoreRule.scope})`,
      explanation: isFromGenOffice
        ? `Excluded: Matched .genofficeignore pattern "${matchingIgnoreRule.pattern}".`
        : `Excluded: Matched explicit Ignore rule "${matchingIgnoreRule.pattern}".`,
    }
    setEvalCache(cacheKey, res)
    return res
  }

  // -------------------------------------------------------------------------
  // Level 4: Recommended Allow Presets (In allowlist mode)
  // -------------------------------------------------------------------------
  if (effectiveMode === 'allowlist') {
    // In allowlist mode, check recommended documents preset if enabled
    if (activePresetStates['preset-common-docs'] !== false) {
      const commonDocs = DEFAULT_INDEXING_PRESETS.find((p) => p.id === 'preset-common-docs')
      if (commonDocs && isKnownSupportedExtension(ext)) {
        const res: IgnoreMatchResult = {
          ignored: false,
          decision: 'allow',
          action: 'allow',
          source: 'preset',
          scope: 'global',
          mode: 'allowlist',
          eligibility: isOutsideRoots
            ? 'outside-root'
            : isSupportedExt
              ? 'supported'
              : 'unsupported',
          reason: `Allowed by recommended preset "${commonDocs.name}" (*${ext})`,
          explanation: `Admitted in allowlist mode by Common Documents preset matching format "*${ext}".`,
        }
        setEvalCache(cacheKey, res)
        return res
      }
    }

    // Allowlist fallback: excluded by default
    const res: IgnoreMatchResult = {
      ignored: true,
      decision: 'ignore',
      action: 'ignore',
      source: 'mode-default',
      mode: 'allowlist',
      eligibility: isOutsideRoots ? 'outside-root' : isSupportedExt ? 'supported' : 'unsupported',
      reason: 'Excluded by default in allowlist mode (no matching Allow rule)',
      explanation:
        'Excluded: Policy is set to Allowlist mode and this path did not match any active Allow rule or preset.',
    }
    setEvalCache(cacheKey, res)
    return res
  }

  // -------------------------------------------------------------------------
  // Level 5: Standard Mode Fallback -> eligible by default
  // -------------------------------------------------------------------------
  const res: IgnoreMatchResult = {
    ignored: false,
    decision: 'allow',
    action: 'allow',
    source: 'mode-default',
    mode: 'standard',
    eligibility: isOutsideRoots ? 'outside-root' : isSupportedExt ? 'supported' : 'unsupported',
    reason: 'Eligible for indexing (standard mode default)',
    explanation:
      'Admitted: Standard mode indexes all eligible files by default unless matched by an Ignore rule.',
  }
  setEvalCache(cacheKey, res)
  return res
}

export function isPathIgnored(targetPath: string, root?: string): boolean {
  return evaluateIgnore(targetPath, root).ignored
}

// ---------------------------------------------------------------------------
// IPC Registration
// ---------------------------------------------------------------------------

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
        decision: res.decision,
        action: res.action,
        source: res.source,
        scope: res.scope,
        winningRule: res.winningRule,
        overriddenRule: res.overriddenRule,
        mode: res.mode,
        eligibility: res.eligibility,
        hardGateBlocked: res.hardGateBlocked,
        hardGateReason: res.hardGateReason,
        explanation: res.explanation,
      }
    },
  )

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.getIgnorePolicyConfig, () => {
    return getFullPolicyConfig()
  })

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.saveIgnorePolicyConfig, (_event, config: unknown) => {
    if (typeof config !== 'object' || config === null) {
      return { ok: false, error: 'invalid-config' }
    }
    const ok = setFullPolicyConfig(config as Partial<IgnorePolicyConfig>)
    if (ok) {
      onInvalidate?.()
      return { ok: true }
    }
    return { ok: false, error: 'save-failed' }
  })

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.getGenOfficeIgnoreFile, (_event, root: unknown) => {
    if (typeof root !== 'string')
      return { exists: false, content: '', rules: [], error: 'Invalid root' }
    return getGenOfficeIgnoreFileData(root)
  })

  ipcMain.handle(
    DOCUMENT_INDEX_CHANNELS.saveGenOfficeIgnoreFile,
    (_event, root: unknown, content: unknown, expectedRevision?: unknown) => {
      if (typeof root !== 'string' || typeof content !== 'string') {
        return { ok: false, error: 'Invalid arguments' }
      }
      const res = writeGenOfficeIgnoreFile(
        root,
        content,
        typeof expectedRevision === 'string' ? expectedRevision : undefined,
      )
      if (res.ok) {
        onInvalidate?.()
      }
      return res
    },
  )

  ipcMain.handle(DOCUMENT_INDEX_CHANNELS.getPolicyPresets, () => {
    return getActivePolicyPresets()
  })
}
