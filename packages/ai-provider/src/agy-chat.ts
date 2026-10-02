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

/** The only model offered in the chat box until the user enables more. */
export const AGY_CHAT_DEFAULT_MODEL = 'gemini-3.8-flash-low'
export const AGY_CHAT_DEFAULT_ENABLED: readonly string[] = [AGY_CHAT_DEFAULT_MODEL]

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

export const AGY_CHAT_CHANNELS = {
  state: 'agyChat:state',
  catalog: 'agyChat:catalog',
  select: 'agyChat:select',
  setEnabled: 'agyChat:set-enabled',
  usage: 'agyChat:usage',
  refreshUsage: 'agyChat:refresh-usage',
  usageUpdated: 'agyChat:usage-updated',
  activity: 'agyChat:activity',
} as const

export interface AgyChatState {
  /** models the user lets appear in the chat box, with metadata */
  models: AgyChatModelInfo[]
  /** the model chat requests use now (the saved agy model) */
  selected: string
  /** whether Antigravity is the active chat provider */
  active: boolean
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
}
