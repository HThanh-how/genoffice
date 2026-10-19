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

/** The chat model a fresh installation starts with, when the installed CLI can serve it. */
export const AGY_CHAT_DEFAULT_MODEL = 'gemini-3.8-flash-high'

/**
 * The list used only when the installed CLI's model catalog cannot be read at all. It is a seed
 * that keeps the chat box usable offline, not a claim that these models are installed: callers
 * that show it also report the catalog error.
 */
export const AGY_CHAT_DEFAULT_ENABLED: readonly string[] = [AGY_CHAT_DEFAULT_MODEL]

/** What `agy models` answered: the ids it reported, or `error` when it could not be read. */
export interface ChatCatalog {
  models?: readonly string[]
  error?: string
}

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

/** Ids in catalog order, without duplicates; identity is never rewritten. */
export function dedupeModelIds(models: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of models) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/** A stored model id, or undefined when nothing was persisted for it. */
export function normalizeChatModel(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * The model a first run should use, decided only from what the CLI actually reported: the High
 * default when it is there, otherwise the first Gemini model the CLI offers, otherwise nothing.
 * A failed or empty catalog is not evidence that any model exists, so it answers undefined rather
 * than inventing one.
 */
export function firstRunChatModel(catalog: ChatCatalog): string | undefined {
  if (typeof catalog?.error === 'string' && catalog.error.trim()) return undefined
  if (!Array.isArray(catalog?.models)) return undefined
  const gemini = defaultEnabledChatModels(catalog.models)
  if (gemini.length === 0) return undefined
  return gemini.includes(AGY_CHAT_DEFAULT_MODEL) ? AGY_CHAT_DEFAULT_MODEL : gemini[0]
}

/**
 * The model a chat turn really uses.
 *  - a persisted selection is the person's choice and is kept as-is, even when the CLI no longer
 *    lists it: nothing here ever rewrites a stored model;
 *  - only a genuinely unconfigured first run is resolved from the catalog;
 *  - undefined means no model was found and none can be verified, so the caller must not invent
 *    one.
 */
export function resolveChatModel(storedModel: unknown, catalog: ChatCatalog): string | undefined {
  const stored = normalizeChatModel(storedModel)
  if (stored) return stored
  return firstRunChatModel(catalog)
}

/**
 * Where the selected model stands with respect to the CLI that is configured right now:
 *  - `verified`: the CLI listed it;
 *  - `unavailable`: a successful catalog read did not list it;
 *  - `unverified`: the catalog could not be read, so nothing is known either way;
 *  - `none`: nothing is selected and nothing could be resolved.
 */
export type ChatModelStatus = 'verified' | 'unavailable' | 'unverified' | 'none'

/**
 * Which models the chat box offers and which one requests use, decided from stored settings and
 * the live catalog without writing anything. The concepts stay separate on purpose:
 *  - `available`: ids the CLI confirmed it can serve right now (empty when unverified);
 *  - `enabled`: ids the person lets appear in the chat box;
 *  - `selected`: the id a chat turn will send ('' when there is none);
 *  - `selectedStatus`: how well that id is supported by the current CLI.
 * A saved enabled list is the person's choice and is never rewritten; with no saved list every
 * Gemini the CLI reports is enabled; a selection outside the enabled list is kept and shown, so
 * the UI never disagrees with what the CLI is sent.
 */
export function resolveChatModels(input: {
  /** the `agyChatModels` app setting; undefined means the person never touched it */
  savedEnabled: unknown
  /** `providers.agy.model` as stored */
  savedModel?: string | null
  catalog: ChatCatalog
}): {
  models: AgyChatModelInfo[]
  selected: string
  enabled: string[]
  /** ids the current CLI confirmed it can serve; empty when availability is unverified */
  available: string[]
  /** the enabled list came from the live catalog rather than from a saved preference */
  fromCatalog: boolean
  /** a successful catalog read determined availability */
  verified: boolean
  selectedStatus: ChatModelStatus
  /** the CLI could not be reached, so availability is unverified */
  catalogError?: string
} {
  const catalogError =
    typeof input.catalog.error === 'string' && input.catalog.error.trim()
      ? input.catalog.error.trim()
      : undefined
  const available = catalogError ? [] : dedupeModelIds(input.catalog.models ?? [])
  const verified = available.length > 0
  const fromCatalog = input.savedEnabled === undefined && verified
  const enabled =
    input.savedEnabled === undefined
      ? defaultEnabledChatModels(available)
      : sanitizeEnabledChatModels(input.savedEnabled)
  const selected = resolveChatModel(input.savedModel, input.catalog) ?? ''
  // With nothing switched on there is nothing to offer: a verified catalog that had no eligible
  // model is reported as such instead of being padded with a hardcoded seed. Only an unreadable
  // catalog falls back to the seed, and the caller reports it as unverified.
  const list = enabled.length
    ? enabled
    : selected
      ? [selected]
      : verified
        ? []
        : [...AGY_CHAT_DEFAULT_ENABLED]
  const ids = list.includes(selected) ? list : selected ? [selected, ...list] : list
  const selectedStatus: ChatModelStatus = !selected
    ? 'none'
    : verified
      ? available.includes(selected)
        ? 'verified'
        : 'unavailable'
      : 'unverified'
  return {
    models: ids.map((id) => ({
      ...agyChatModelInfo(id),
      enabled: list.includes(id),
      // a model the CLI could not be reached for is never presented as confirmed
      verified: available.includes(id),
    })),
    selected,
    enabled: list,
    available,
    fromCatalog,
    verified,
    selectedStatus,
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
  /** set by resolveChatModels only: whether the person has this model switched on */
  enabled?: boolean
  /** set by resolveChatModels only: the current CLI confirmed it can serve this model */
  verified?: boolean
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
  /** broadcast to every window whenever the chat model or the enabled list changes */
  modelChanged: 'agyChat:model-changed',
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
  /** the model chat requests use now; '' when there is nothing usable */
  selected: string
  /** whether Antigravity is the active chat provider */
  active: boolean
  /** ids the installed CLI confirmed it can serve (empty when the catalog could not be read) */
  available: string[]
  /** how well the selected model is supported by the CLI configured now */
  selectedStatus: ChatModelStatus
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
  setAgyChatEnabledModels(ids: string[]): Promise<string[] | null>
  /** every window hears this after a model selection or an enabled-list change */
  onAgyChatModelChanged(handler: () => void): () => void
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
