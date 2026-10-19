import type { AgyActivity } from './agy-activity'

/**
 * Pure helpers for the Antigravity (`agy`) chat model chooser: which models exist, which the user
 * lets appear in the chat box, and how their quota cost compares. Browser-safe (no Node imports).
 *
 * Costs are measured, not guessed: the same six-page OCR call (about 75k tokens) used this share
 * of the 5-hour quota on average: gemini-3.8-flash-low 0.45%, 3.7-flash-low 0.48%,
 * 3.8-flash-medium 1.0%, 3.1-pro-low 1.2%, 3.8-flash-high 1.5%, 3.1-pro-high 2.1%,
 * claude-sonnet-4-6 4.5%. Accuracy on that task was the same for all Gemini Flash levels, so extra
 * reasoning only costs time and quota.
 */

/** The chat model a fresh installation starts with: Gemini 3.8 Flash High. */
export const AGY_CHAT_DEFAULT_MODEL = 'gemini-3.8-flash-high'

/**
 * The list used only when the installed CLI's model catalog cannot be read at all. It is a seed
 * that keeps the chat box usable offline, not a claim that these models are installed: callers
 * that show it also report the catalog error.
 */
export const AGY_CHAT_DEFAULT_ENABLED: readonly string[] = [AGY_CHAT_DEFAULT_MODEL]

/**
 * Every Gemini model the installed CLI reported, in catalog order, without duplicates. Claude,
 * GPT and anything else stay off until the person turns them on. An empty or failed catalog
 * yields nothing: it is not evidence that any model exists.
 */
export function defaultEnabledChatModels(catalogModels?: readonly string[]): string[] {
  if (!Array.isArray(catalogModels)) return []
  const out: string[] = []
  for (const raw of catalogModels) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (!/^gemini-/i.test(id) || out.includes(id)) continue
    out.push(id)
  }
  return out
}

/** A stored model id, or undefined when the person never chose one. */
export function normalizeChatModel(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * The model a chat turn really uses.
 *  - an explicit selection always wins, even when the CLI no longer lists it;
 *  - the app's own seeded default is re-resolved against the catalog, so a first run never sends
 *    a model id the installed CLI cannot serve;
 *  - a catalog failure is never read as "the model is missing": the stored choice is kept.
 */
export function resolveChatModel(
  storedModel: unknown,
  catalog: { models?: readonly string[]; error?: string },
): string {
  const stored = normalizeChatModel(storedModel)
  // Anything other than the app's own seeded default is the person's choice and is kept, even
  // when the CLI no longer lists it.
  if (stored && stored !== AGY_CHAT_DEFAULT_MODEL) return stored
  return firstRunChatModel(catalog)
}

/**
 * The chat model a first run should use: the High default when the installed CLI offers it,
 * otherwise the first Gemini model it offers, otherwise the seed (availability reported separately).
 */
export function firstRunChatModel(catalog: { models?: readonly string[]; error?: string }): string {
  if (catalog?.error || !Array.isArray(catalog.models) || catalog.models.length === 0)
    return AGY_CHAT_DEFAULT_MODEL
  if (catalog.models.includes(AGY_CHAT_DEFAULT_MODEL)) return AGY_CHAT_DEFAULT_MODEL
  return defaultEnabledChatModels(catalog.models)[0] ?? AGY_CHAT_DEFAULT_MODEL
}

/**
 * Which models the chat box offers and which one requests use, decided from stored settings and
 * the live catalog without writing anything.
 *  - a saved enabled list is the person's choice and is never rewritten;
 *  - with no saved list, every Gemini model the CLI reports is enabled;
 *  - a selection that is not in the enabled list is kept and shown, so the UI never disagrees
 *    with what the CLI is sent.
 */
export function resolveChatModels(input: {
  /** the `agyChatModels` app setting; undefined means the person never touched it */
  savedEnabled: unknown
  /** `providers.agy.model` as stored */
  savedModel?: string | null
  catalog: { models: readonly string[]; error?: string }
  provider?: string
}): {
  models: AgyChatModelInfo[]
  selected: string
  enabled: string[]
  /** the enabled list came from the live catalog rather than from a saved preference */
  fromCatalog: boolean
  /** the CLI could not be reached, so availability is unverified */
  catalogError?: string
} {
  const catalogError =
    typeof input.catalog.error === 'string' && input.catalog.error.trim()
      ? input.catalog.error.trim()
      : undefined
  const fromCatalog = input.savedEnabled === undefined && input.catalog.models.length > 0
  const enabled =
    input.savedEnabled === undefined
      ? defaultEnabledChatModels(input.catalog.models)
      : sanitizeEnabledChatModels(input.savedEnabled)
  const list = enabled.length ? enabled : [...AGY_CHAT_DEFAULT_ENABLED]
  const selected = resolveChatModel(input.savedModel, input.catalog)
  const ids = list.includes(selected) ? list : [selected, ...list]
  return {
    models: ids.map(agyChatModelInfo),
    selected,
    enabled: list,
    fromCatalog,
    ...(catalogError ? { catalogError } : {}),
  }
}

export type AgyQuotaGroup = 'Gemini Models' | 'Claude and GPT models'

export interface AgyChatModelInfo {
  id: string
  label: string
  family: 'gemini' | 'claude' | 'gpt' | 'other'
  /** shared quota pool the model draws from */
  group: AgyQuotaGroup | null
  effort?: 'low' | 'medium' | 'high'
  tier: 'flash' | 'pro' | 'other'
  /** quota use relative to gemini-3.8-flash-low (= 1) for the same work */
  relativeCost: number
  /** one-line guidance, plain language */
  speed: 'fast' | 'balanced' | 'slow'
}

const COSTS: Array<[RegExp, number]> = [
  [/^gemini-3\.\d-flash-low$/, 1],
  [/^gemini-3\.\d-flash-medium$/, 2.2],
  [/^gemini-3\.\d-flash-high$/, 3.4],
  [/^gemini-3\.\d-pro-low$/, 2.6],
  [/^gemini-3\.\d-pro-high$/, 4.7],
  [/^claude-/, 10],
  [/^gpt-/, 6],
]

/** What the chat box shows for a model id; unknown ids still get a usable entry. */
export function agyChatModelInfo(id: string): AgyChatModelInfo {
  const lower = id.toLowerCase()
  const family = lower.startsWith('gemini-')
    ? 'gemini'
    : lower.startsWith('claude-')
      ? 'claude'
      : lower.startsWith('gpt-')
        ? 'gpt'
        : 'other'
  const effort = /-(low|medium|high)$/.exec(lower)?.[1] as AgyChatModelInfo['effort']
  const tier = /-flash/.test(lower) ? 'flash' : /-pro/.test(lower) ? 'pro' : 'other'
  const version = /^gemini-(\d+\.\d+)/.exec(lower)?.[1]
  const effortLabel = effort ? ` ${effort[0]!.toUpperCase()}${effort.slice(1)}` : ''
  const label =
    family === 'gemini'
      ? `Gemini ${version ?? ''} ${tier === 'pro' ? 'Pro' : 'Flash'}${effortLabel}`.replace(
          /\s+/g,
          ' ',
        )
      : family === 'claude'
        ? id
            .replace(/^claude-/, 'Claude ')
            .replace(/-thinking$/, ' (Thinking)')
            .replace(/-/g, ' ')
        : family === 'gpt'
          ? id.replace(/^gpt-/, 'GPT ').replace(/-/g, ' ')
          : id
  const relativeCost = COSTS.find(([pattern]) => pattern.test(lower))?.[1] ?? 3
  const group: AgyQuotaGroup | null =
    family === 'gemini'
      ? 'Gemini Models'
      : family === 'claude' || family === 'gpt'
        ? 'Claude and GPT models'
        : null
  const speed: AgyChatModelInfo['speed'] =
    effort === 'low' && tier === 'flash'
      ? 'fast'
      : effort === 'high' || family === 'claude'
        ? 'slow'
        : 'balanced'
  return {
    id,
    label,
    family,
    group,
    ...(effort ? { effort } : {}),
    tier,
    relativeCost,
    speed,
  }
}

/** Keep only well-formed ids, without duplicates; empty or invalid input falls back to the default. */
export function sanitizeEnabledChatModels(value: unknown): string[] {
  const out: string[] = []
  if (Array.isArray(value))
    for (const item of value)
      if (
        typeof item === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(item) &&
        !out.includes(item)
      )
        out.push(item)
  return out.length ? out : [...AGY_CHAT_DEFAULT_ENABLED]
}

/** One reading of the quota, as the chat box shows it. */
export interface AgyChatUsageBucket {
  window: '5h' | 'weekly'
  /** 0..1 left */
  remaining: number
  /** epoch ms the bucket refills */
  resetAt?: number
}

export interface AgyChatUsageState {
  /** quota group -> its buckets; null before the first successful read */
  groups: Array<{ name: string; buckets: AgyChatUsageBucket[] }> | null
  /** epoch ms of the last successful read (0 = never) */
  readAt: number
  /** a read is running right now */
  refreshing: boolean
  /** the last attempt failed (the previous numbers, if any, are still shown) */
  failed: boolean
  /** the CLI is not signed in, so usage (and chat) cannot work until the user logs in */
  needsLogin?: boolean
  /** there is no `agy` on this computer: it has to be installed before anything else */
  cliMissing?: boolean
}

/** The usage buckets that apply to a model (its quota pool), or null when unknown. */
export function usageForModel(
  state: AgyChatUsageState | null | undefined,
  modelId: string,
): AgyChatUsageBucket[] | null {
  const group = agyChatModelInfo(modelId).group
  if (!state?.groups || !group) return null
  return state.groups.find((g) => g.name === group)?.buckets ?? null
}

/** Progress of signing the Antigravity CLI in from the app (see agy-login.ts). */
export type AgyLoginPhase = 'idle' | 'starting' | 'waiting' | 'checking' | 'done' | 'failed'

export interface AgyLoginState {
  phase: AgyLoginPhase
  /** the sign-in page, so the person can open it again */
  url?: string
  error?: 'cli-missing' | 'rejected' | 'timeout' | 'failed'
}

/** Progress of installing the Antigravity CLI from the app (see agy-install.ts). */
export type AgyInstallPhase = 'idle' | 'installing' | 'done' | 'failed'

export interface AgyInstallState {
  phase: AgyInstallPhase
  /** the last lines the installer printed, for the person to read if it fails */
  output?: string
  error?: 'script-failed' | 'not-found-after' | 'timeout' | 'unsupported' | 'busy'
}

export const AGY_CHAT_CHANNELS = {
  state: 'agyChat:state',
  catalog: 'agyChat:catalog',
  select: 'agyChat:select',
  setEnabled: 'agyChat:set-enabled',
  usage: 'agyChat:usage',
  refreshUsage: 'agyChat:refresh-usage',
  usageUpdated: 'agyChat:usage-updated',
  activity: 'agyChat:activity',
  loginStart: 'agyChat:login-start',
  loginCode: 'agyChat:login-code',
  loginCancel: 'agyChat:login-cancel',
  loginState: 'agyChat:login-state',
  installStart: 'agyChat:install-start',
  installState: 'agyChat:install-state',
} as const

export interface AgyChatState {
  /** models the user lets appear in the chat box, with metadata */
  models: AgyChatModelInfo[]
  /** the model chat requests use now (the saved agy model) */
  selected: string
  /** whether Antigravity is the active chat provider */
  active: boolean
  /** set when `agy models` could not be read, so the list is unverified */
  catalogError?: string
}

export interface AgyChatCatalog {
  /** every model `agy models` reports (empty when the CLI is unavailable) */
  all: AgyChatModelInfo[]
  enabled: string[]
  error?: string
}

/** What a renderer can call; implemented by the shared preload helper. */
export interface AgyChatApi {
  getAgyChatState(): Promise<AgyChatState>
  getAgyChatCatalog(): Promise<AgyChatCatalog>
  selectAgyChatModel(id: string): Promise<boolean>
  setAgyChatEnabledModels(ids: string[]): Promise<string[]>
  getAgyChatUsage(): Promise<AgyChatUsageState>
  refreshAgyChatUsage(): Promise<AgyChatUsageState>
  onAgyChatUsage(handler: (state: AgyChatUsageState) => void): () => void
  /** live steps of a chat turn (thinking, tool use, writing) for the thinking strip */
  onAgyChatActivity(handler: (activity: AgyActivity) => void): () => void
  /** open the Google sign-in page; resolves once the CLI is waiting for the code */
  startAgyLogin(): Promise<AgyLoginState>
  /** the code the sign-in page shows */
  submitAgyLoginCode(code: string): Promise<boolean>
  cancelAgyLogin(): Promise<void>
  onAgyLogin(handler: (state: AgyLoginState) => void): () => void
  /** download and run Google's own installer for the Antigravity CLI (once the person agreed) */
  startAgyInstall(): Promise<AgyInstallState>
  onAgyInstall(handler: (state: AgyInstallState) => void): () => void
}
