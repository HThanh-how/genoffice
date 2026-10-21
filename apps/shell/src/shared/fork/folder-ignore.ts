/**
 * Fork-only: pure helpers for the Home folder tree "Ignore this folder" /
 * "Stop ignoring" action. No node or electron imports, so main and renderer
 * share the exact same rule identity.
 */
import type { IgnoreRule, IgnoreTestResult } from './document-index-api'

export const FOLDER_IGNORE_ID_PREFIX = 'folder-ignore:'
export const FOLDER_IGNORE_DESCRIPTION = 'Ignored from Home'
const MAX_ID_LENGTH = 100
const MAX_SCOPE_LENGTH = 500

/** Forward slashes, collapsed separators, no trailing slash (root "C:/" keeps its slash-less drive form). */
export function normalizeFolderScope(path: string): string {
  const isUnc = path.startsWith('\\\\') || path.startsWith('//')
  const unified = path.replace(/\\/g, '/').replace(/\/+/g, '/')
  const withUnc = isUnc ? '/' + unified : unified
  return withUnc.length > 1 ? withUnc.replace(/\/+$/, '') : withUnc
}

function hashHex(input: string): string {
  // cyrb53: deterministic, dependency free
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (
    (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
  )
}

export function folderIgnoreRuleId(path: string, caseInsensitive: boolean): string {
  const norm = normalizeFolderScope(path)
  const key = caseInsensitive ? norm.toLowerCase() : norm
  const id = FOLDER_IGNORE_ID_PREFIX + key
  if (id.length <= MAX_ID_LENGTH) return id
  const hash = hashHex(key)
  const tail = key.slice(-(MAX_ID_LENGTH - FOLDER_IGNORE_ID_PREFIX.length - hash.length - 1))
  return `${FOLDER_IGNORE_ID_PREFIX}${hash}:${tail}`
}

export function buildFolderIgnoreRule(path: string, caseInsensitive: boolean): IgnoreRule | null {
  const scope = normalizeFolderScope(path)
  if (!scope || scope.length > MAX_SCOPE_LENGTH) return null
  return {
    id: folderIgnoreRuleId(path, caseInsensitive),
    pattern: '**',
    enabled: true,
    scope,
    action: 'ignore',
    source: 'user',
    description: FOLDER_IGNORE_DESCRIPTION,
  }
}

function sameScope(a: string, b: string, caseInsensitive: boolean): boolean {
  const x = normalizeFolderScope(a)
  const y = normalizeFolderScope(b)
  return caseInsensitive ? x.toLowerCase() === y.toLowerCase() : x === y
}

/** True when `rule` is the rule this feature creates for exactly `path`. */
export function isFolderIgnoreRuleFor(
  rule: Pick<IgnoreRule, 'id' | 'pattern' | 'scope' | 'source' | 'action'>,
  path: string,
  caseInsensitive: boolean,
): boolean {
  if (rule.source !== 'user' || (rule.action ?? 'ignore') !== 'ignore') return false
  if (rule.id === folderIgnoreRuleId(path, caseInsensitive)) return true
  return rule.pattern === '**' && rule.scope !== 'global' && sameScope(rule.scope, path, caseInsensitive)
}

/** Pure list edits used by the atomic main-process handlers. `changed` is false for no-ops. */
export function addFolderIgnoreToRules(
  rules: readonly IgnoreRule[],
  path: string,
  caseInsensitive: boolean,
): { rules: IgnoreRule[]; changed: boolean } | null {
  const rule = buildFolderIgnoreRule(path, caseInsensitive)
  if (!rule) return null
  const existing = rules.find((r) => isFolderIgnoreRuleFor(r, path, caseInsensitive))
  if (existing && existing.enabled) return { rules: [...rules], changed: false }
  const rest = rules.filter((r) => !isFolderIgnoreRuleFor(r, path, caseInsensitive))
  return { rules: [...rest, rule], changed: true }
}

export function removeFolderIgnoreFromRules(
  rules: readonly IgnoreRule[],
  path: string,
  caseInsensitive: boolean,
): { rules: IgnoreRule[]; changed: boolean } {
  const rest = rules.filter((r) => !isFolderIgnoreRuleFor(r, path, caseInsensitive))
  return { rules: rest, changed: rest.length !== rules.length }
}

export type FolderIgnoreMenuState =
  | { kind: 'hidden' }
  | { kind: 'checking' }
  | { kind: 'ignore' }
  | { kind: 'stop' }
  | { kind: 'blocked'; reason: string }

/**
 * Decides which menu entry to show. `result` is the testIgnorePath answer
 * (undefined while it is still in flight, null when the lookup failed).
 */
export function decideFolderIgnoreMenu(args: {
  path: string
  isRoot: boolean
  result: IgnoreTestResult | null | undefined
  caseInsensitive: boolean
}): FolderIgnoreMenuState {
  if (args.isRoot) return { kind: 'hidden' }
  const { result } = args
  if (result === undefined) return { kind: 'checking' }
  if (result === null) return { kind: 'hidden' }
  if (!result.ignored) return { kind: 'ignore' }
  const winning = result.winningRule
  const own =
    result.source === 'user' &&
    result.scope !== undefined &&
    result.scope !== 'global' &&
    sameScope(result.scope, args.path, args.caseInsensitive) &&
    (result.ruleId === folderIgnoreRuleId(args.path, args.caseInsensitive) ||
      (result.pattern === '**' && (!winning || winning.pattern === '**')))
  if (own) return { kind: 'stop' }
  return { kind: 'blocked', reason: result.pattern ?? result.reason ?? '' }
}
