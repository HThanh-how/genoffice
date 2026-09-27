import type { AiSettings } from './types'
import type { AgentStreamRequest } from '@genoffice/agent-core'
import type { GeminiModelInfo } from './gemini-models'

export const GEMINI_CHOICE_KEY = 'genoffice-gemini-model-choice-v1'
export const GEMINI_MODELS_KEY = 'genoffice-gemini-models-v1'
export const GEMINI_ROUTING_EVENT = 'genoffice-gemini-routing-changed'
export const GEMINI_USAGE_KEY = 'genoffice-gemini-usage-v1'
export const GEMINI_ROUTING_LOG_KEY = 'genoffice-gemini-routing-log-v1'
export const GEMINI_CALL_LOG_KEY = 'genoffice-gemini-call-log-v1'
const GEMINI_COOLDOWN_KEY = 'genoffice-gemini-cooldowns-v1'
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
const CALL_LOG_LIMIT = 200
const CALL_LOG_MAX_BYTES = 128 * 1024
const ROUTING_LOG_MAX_BYTES = 64 * 1024

export type GeminiModelChoice = 'auto' | 'smart' | 'fast' | `model:${string}`

export const GEMINI_DEFAULT_ORDER = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemma-4-26b-a4b-it',
  'gemma-4-31b-it',
] as const

export function readGeminiChoice(): GeminiModelChoice {
  try {
    const saved = localStorage.getItem(GEMINI_CHOICE_KEY)
    if (saved === 'auto' || saved === 'smart' || saved === 'fast') return saved
    if (saved?.startsWith('model:') && saved.length > 6) return saved as GeminiModelChoice
  } catch {
    // Storage may be unavailable in a transient renderer.
  }
  return 'auto'
}

export function saveGeminiChoice(choice: GeminiModelChoice): void {
  localStorage.setItem(GEMINI_CHOICE_KEY, choice)
  window.dispatchEvent(new Event(GEMINI_ROUTING_EVENT))
}

export function readGeminiModels(): GeminiModelInfo[] {
  try {
    const saved = JSON.parse(localStorage.getItem(GEMINI_MODELS_KEY) || '[]') as unknown
    if (Array.isArray(saved)) {
      return saved.filter(
        (entry): entry is GeminiModelInfo =>
          !!entry &&
          typeof entry === 'object' &&
          typeof entry.id === 'string' &&
          typeof entry.displayName === 'string' &&
          typeof entry.usableForChat === 'boolean',
      )
    }
  } catch {
    // Treat a stale or corrupt cache as empty.
  }
  return []
}

export function saveGeminiModels(models: GeminiModelInfo[]): void {
  try {
    localStorage.setItem(GEMINI_MODELS_KEY, JSON.stringify(models))
  } catch {
    // Listing remains usable for this session without persistence.
  }
}

function pacificDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

export function readGeminiUsage(): Record<string, number> {
  try {
    const saved = JSON.parse(localStorage.getItem(GEMINI_USAGE_KEY) || '{}') as {
      date?: string
      counts?: Record<string, number>
    }
    if (saved.date === pacificDate() && saved.counts && typeof saved.counts === 'object') {
      return saved.counts
    }
  } catch {
    /* no usable local record */
  }
  return {}
}

function recordGeminiAttempt(model: string): void {
  try {
    const counts = readGeminiUsage()
    counts[model] = (counts[model] || 0) + 1
    localStorage.setItem(GEMINI_USAGE_KEY, JSON.stringify({ date: pacificDate(), counts }))
    window.dispatchEvent(new Event(GEMINI_ROUTING_EVENT))
  } catch {
    /* usage display is best effort */
  }
}

export interface GeminiRoutingLogEntry {
  at: number
  model: string
  action: 'selected' | 'retry' | 'fallback' | 'exhausted'
  reason?: 'daily_quota' | 'rate_limit' | 'overloaded' | 'timeout' | 'unavailable' | 'other'
  to?: string
  delayMs?: number
}

export interface GeminiCallLogEntry {
  id: string
  at: number
  model: string
  purpose: 'chat' | 'generation' | 'compaction'
  messageCount: number
  inputTextChars: number
  toolNames: string[]
  status: 'pending' | 'ok' | 'error' | 'cancelled' | 'interrupted'
  durationMs?: number
  reason?: GeminiRoutingLogEntry['reason'] | 'network'
  httpStatus?: number
  quotaId?: string
  quotaMetric?: string
  retryAfterSeconds?: number
  usage?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
    cachedContentTokenCount?: number
    totalTokenCount?: number
  }
}

function pruneLog<T extends { at: number }>(
  entries: T[],
  maxEntries: number,
  maxBytes: number,
): T[] {
  const now = Date.now()
  const kept = entries
    .filter(
      (entry) =>
        !!entry &&
        typeof entry === 'object' &&
        Number.isFinite(entry.at) &&
        entry.at >= now - LOG_RETENTION_MS &&
        entry.at <= now,
    )
    .slice(0, maxEntries)
  while (kept.length && new TextEncoder().encode(JSON.stringify(kept)).byteLength > maxBytes)
    kept.pop()
  return kept
}

export function readGeminiCallLog(): GeminiCallLogEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(GEMINI_CALL_LOG_KEY) || '[]') as unknown
    if (!Array.isArray(raw)) return []
    const entries = pruneLog(
      raw.filter(
        (entry): entry is GeminiCallLogEntry =>
          !!entry &&
          typeof entry === 'object' &&
          typeof entry.id === 'string' &&
          typeof entry.model === 'string' &&
          typeof entry.at === 'number' &&
          ['pending', 'ok', 'error', 'cancelled', 'interrupted'].includes(entry.status),
      ),
      CALL_LOG_LIMIT,
      CALL_LOG_MAX_BYTES,
    ).map((entry) =>
      entry.status === 'pending' && Date.now() - entry.at > 5 * 60_000
        ? { ...entry, status: 'interrupted' as const }
        : entry,
    )
    if (entries.length !== raw.length || entries.some((entry, index) => entry !== raw[index])) {
      try {
        localStorage.setItem(GEMINI_CALL_LOG_KEY, JSON.stringify(entries))
      } catch {
        // Keep the readable entries even when storage is temporarily full.
      }
    }
    return entries
  } catch {
    return []
  }
}

function writeGeminiCallLog(entries: GeminiCallLogEntry[]): void {
  try {
    localStorage.setItem(
      GEMINI_CALL_LOG_KEY,
      JSON.stringify(pruneLog(entries, CALL_LOG_LIMIT, CALL_LOG_MAX_BYTES)),
    )
    window.dispatchEvent(new Event(GEMINI_ROUTING_EVENT))
  } catch {
    // Diagnostics must never interrupt a model request.
  }
}

function updateGeminiCall(
  id: string,
  update: (entry: GeminiCallLogEntry) => GeminiCallLogEntry,
): void {
  const entries = readGeminiCallLog()
  const index = entries.findIndex((entry) => entry.id === id)
  if (index < 0) return
  entries[index] = update(entries[index]!)
  writeGeminiCallLog(entries)
}

function recordRoutingEvent(entry: GeminiRoutingLogEntry): void {
  try {
    const raw = JSON.parse(localStorage.getItem(GEMINI_ROUTING_LOG_KEY) || '[]') as unknown
    const entries = Array.isArray(raw) ? raw : []
    localStorage.setItem(
      GEMINI_ROUTING_LOG_KEY,
      JSON.stringify(pruneLog([entry, ...entries], 40, ROUTING_LOG_MAX_BYTES)),
    )
    window.dispatchEvent(new Event(GEMINI_ROUTING_EVENT))
  } catch {
    // Diagnostics are local and best effort; never interrupt a request.
  }
}

function failureReason(error: string): NonNullable<GeminiRoutingLogEntry['reason']> {
  if (/quota_exceeded|per.?day|daily|\bRPD\b/i.test(error)) return 'daily_quota'
  if (/Gemini HTTP 404\b/i.test(error)) return 'unavailable'
  if (/Gemini HTTP (408|504)\b|timed out|timeout/i.test(error)) return 'timeout'
  if (/Gemini HTTP 429\b|RESOURCE_EXHAUSTED|rate.?limit|too many requests/i.test(error))
    return 'rate_limit'
  if (
    /Gemini HTTP (500|502|503|504|529)\b|UNAVAILABLE|overload|service is busy|capacity/i.test(error)
  )
    return 'overloaded'
  return 'other'
}

interface Cooldown {
  until?: number
  day?: string
}

function readCooldowns(): Record<string, Cooldown> {
  try {
    const saved = JSON.parse(localStorage.getItem(GEMINI_COOLDOWN_KEY) || '{}') as unknown
    return saved && typeof saved === 'object' && !Array.isArray(saved)
      ? (saved as Record<string, Cooldown>)
      : {}
  } catch {
    return {}
  }
}

function onCooldown(model: string): boolean {
  const item = readCooldowns()[model]
  return !!item && (item.day === pacificDate() || (item.until ?? 0) > Date.now())
}

function coolDown(model: string, error: string): void {
  const daily = /quota_exceeded|per.?day|daily|\bRPD\b/i.test(error)
  const retryDelay = /retryDelay["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)s/i.exec(error)
  const seconds = retryDelay
    ? Math.min(3600, Number(retryDelay[1]))
    : /Gemini HTTP 404\b/i.test(error)
      ? 3600
      : 60
  const saved = readCooldowns()
  saved[model] = daily ? { day: pacificDate() } : { until: Date.now() + seconds * 1000 }
  try {
    localStorage.setItem(GEMINI_COOLDOWN_KEY, JSON.stringify(saved))
  } catch {
    /* session fallback */
  }
}

function isRecoverableGeminiError(error: string, errorCode?: string): boolean {
  if (errorCode === 'timeout') return true
  if (errorCode === 'network' || errorCode === 'credits') return false
  return /Gemini HTTP (408|404|429|500|502|503|504|529)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|overload|rate.?limit|too many requests|service is busy|capacity/i.test(
    error,
  )
}

function retryDelayMs(error: string): number | null {
  const delay = /retryDelay["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)s/i.exec(error)
  return delay ? Number(delay[1]) * 1_000 : null
}

function shouldSkipRetry(error: string, errorCode?: string): boolean {
  if (
    errorCode === 'timeout' ||
    /Gemini HTTP (404|429)\b|quota_exceeded|per.?day|daily|\bRPD\b/i.test(error)
  )
    return true
  const delay = retryDelayMs(error)
  return delay !== null && delay > 2_000
}

function candidates(choice: GeminiModelChoice, configured: string): string[] {
  if (choice.startsWith('model:')) return [choice.slice(6)]
  const live = readGeminiModels()
    .filter((model) => model.usableForChat)
    .map((model) => model.id)
  const allowed = new Set(live)
  // Keep preferred Flash models first, but include newly released chat models
  // returned by the API rather than silently falling back to a stale setting.
  const defaults = GEMINI_DEFAULT_ORDER.filter((id) => allowed.size === 0 || allowed.has(id))
  const preferred = new Set<string>(defaults)
  const others = live.filter((id) => !preferred.has(id) && /^gemini-.*flash/i.test(id))
  const order = [...defaults, ...others]
  const list =
    choice === 'fast'
      ? order.filter((id) => id.includes('lite') || id.startsWith('gemma-4-'))
      : choice === 'smart'
        ? order.filter((id) => !id.includes('lite') && !id.startsWith('gemma-'))
        : order
  if (choice === 'auto' && allowed.size === 0 && configured) {
    return [configured, ...list.filter((id) => id !== configured)]
  }
  return list.length ? [...list] : [configured]
}

function withModel(settings: AiSettings, model: string): AiSettings {
  return {
    ...settings,
    providers: {
      ...settings.providers,
      gemini: { ...settings.providers.gemini, model },
    },
  }
}

/** A router lives as long as one chat transport and holds the fallback model between tool turns. */
export function createGeminiRouter() {
  let choice = readGeminiChoice()
  let activeModel = ''
  let activeDay = pacificDate()
  let activeRunId = ''
  let fallbackCount = 0
  let overloadRetries = 0
  return {
    firstContentTimeoutMs: 45_000,
    maxDurationMs: 120_000,
    maxAttempts: 10,
    onExhausted(settings: AiSettings, reason: 'deadline' | 'attempt_limit'): void {
      if (settings.provider !== 'gemini') return
      recordRoutingEvent({
        at: Date.now(),
        model: settings.providers.gemini.model,
        action: 'exhausted',
        reason: reason === 'deadline' ? 'timeout' : 'other',
      })
    },
    onAttempt(settings: AiSettings, requestId?: string, request?: AgentStreamRequest): void {
      if (settings.provider !== 'gemini') return
      recordGeminiAttempt(settings.providers.gemini.model)
      if (!requestId || !request) return
      const inputTextChars =
        request.system.length +
        request.messages.reduce(
          (total, message) =>
            total +
            (message.role === 'tool'
              ? message.results.reduce((sum, result) => sum + result.output.length, 0)
              : message.text.length),
          0,
        )
      writeGeminiCallLog([
        {
          id: requestId,
          at: Date.now(),
          model: settings.providers.gemini.model,
          purpose: request.system.startsWith('You are a conversation compressor.')
            ? 'compaction'
            : request.tools.length
              ? 'chat'
              : 'generation',
          messageCount: request.messages.length,
          inputTextChars,
          toolNames: [],
          status: 'pending',
        },
        ...readGeminiCallLog(),
      ])
    },
    onUsage(_settings: AiSettings, requestId: string, usage: GeminiCallLogEntry['usage']): void {
      if (!usage) return
      const cleaned: NonNullable<GeminiCallLogEntry['usage']> = {}
      for (const field of [
        'promptTokenCount',
        'candidatesTokenCount',
        'thoughtsTokenCount',
        'cachedContentTokenCount',
        'totalTokenCount',
      ] as const) {
        const value = usage[field]
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
          cleaned[field] = value
      }
      if (Object.keys(cleaned).length)
        updateGeminiCall(requestId, (entry) => ({ ...entry, usage: cleaned }))
    },
    onToolCall(_settings: AiSettings, requestId: string, toolName: string): void {
      updateGeminiCall(requestId, (entry) => ({
        ...entry,
        toolNames: [...(entry.toolNames || []), toolName.slice(0, 80)].slice(0, 10),
      }))
    },
    onResult(
      _settings: AiSettings,
      requestId: string,
      outcome: {
        status: 'ok' | 'error' | 'cancelled'
        error?: string | undefined
        errorCode?: string | undefined
      },
    ): void {
      const httpStatus = /Gemini HTTP (\d{3})\b/.exec(outcome.error || '')?.[1]
      const quotaId = /quotaId="([A-Za-z0-9_.-]{1,120})"/.exec(outcome.error || '')?.[1]
      const quotaMetric = /quotaMetric="([A-Za-z0-9_./-]{1,160})"/.exec(outcome.error || '')?.[1]
      const retryAfter = /retryDelay="(\d+(?:\.\d+)?)s"/.exec(outcome.error || '')?.[1]
      updateGeminiCall(requestId, (entry) => ({
        ...entry,
        status: outcome.status,
        durationMs: Math.max(0, Date.now() - entry.at),
        ...(outcome.status === 'error'
          ? {
              reason:
                outcome.errorCode === 'network'
                  ? ('network' as const)
                  : outcome.errorCode === 'timeout'
                    ? ('timeout' as const)
                    : failureReason(outcome.error || ''),
              ...(httpStatus ? { httpStatus: Number(httpStatus) } : {}),
              ...(quotaId ? { quotaId } : {}),
              ...(quotaMetric ? { quotaMetric } : {}),
              ...(retryAfter ? { retryAfterSeconds: Number(retryAfter) } : {}),
            }
          : {}),
      }))
    },
    prepare(settings: AiSettings, request?: AgentStreamRequest): AiSettings {
      if (settings.provider !== 'gemini') return settings
      if (request?.system.startsWith('You are a conversation compressor.')) {
        const available = new Set(
          readGeminiModels()
            .filter((m) => m.usableForChat)
            .map((m) => m.id),
        )
        const summaryModel = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'].find(
          (model) => available.size === 0 || available.has(model),
        )
        return summaryModel ? withModel(settings, summaryModel) : settings
      }
      const nextChoice = readGeminiChoice()
      if (nextChoice !== choice) {
        choice = nextChoice
        activeModel = ''
      }
      if (request?.runId && request.runId !== activeRunId) {
        activeRunId = request.runId
        activeModel = ''
      } else if (!request?.runId) {
        // Standalone writer calls have no run id; each is a fresh routing decision.
        activeModel = ''
      }
      if (activeDay !== pacificDate()) {
        activeDay = pacificDate()
        activeModel = ''
      }
      const order = candidates(choice, settings.providers.gemini.model).filter(
        (model) => choice.startsWith('model:') || !onCooldown(model),
      )
      if (!activeModel || !order.includes(activeModel)) {
        activeModel = order[0] || settings.providers.gemini.model
        recordRoutingEvent({ at: Date.now(), model: activeModel, action: 'selected' })
      }
      fallbackCount = 0
      overloadRetries = 0
      return withModel(settings, activeModel)
    },
    retry(
      settings: AiSettings,
      error: string,
      emitted: boolean,
      errorCode?: string,
    ): number | null {
      if (settings.provider !== 'gemini' || emitted || !isRecoverableGeminiError(error, errorCode))
        return null
      if (shouldSkipRetry(error, errorCode) || overloadRetries >= 2) return null
      const delayMs = Math.max([400, 1_000][overloadRetries++] ?? 0, retryDelayMs(error) ?? 0)
      recordRoutingEvent({
        at: Date.now(),
        model: settings.providers.gemini.model,
        action: 'retry',
        reason: errorCode === 'timeout' ? 'timeout' : failureReason(error),
        delayMs,
      })
      return delayMs
    },
    fallback(
      settings: AiSettings,
      error: string,
      emitted: boolean,
      errorCode?: string,
    ): AiSettings | null {
      if (settings.provider !== 'gemini' || emitted || choice.startsWith('model:')) return null
      if (!isRecoverableGeminiError(error, errorCode)) return null
      if (fallbackCount++ >= 5) return null
      coolDown(settings.providers.gemini.model, error)
      const order = candidates(choice, settings.providers.gemini.model)
      const current = settings.providers.gemini.model
      const remaining = order
        .slice(order.indexOf(current) + 1)
        .filter((model) => !onCooldown(model))
      const capacityFailure =
        errorCode === 'timeout' ||
        ['daily_quota', 'rate_limit', 'overloaded'].includes(failureReason(error))
      // A busy/quota-limited Flash should reach the economical backup promptly.
      // If Lite is also unavailable, move straight to a listed Gemma 4 model.
      const next = capacityFailure
        ? (remaining.find((model) => model.includes('flash-lite')) ??
          remaining.find((model) => model.startsWith('gemma-4-')) ??
          remaining[0])
        : remaining[0]
      if (!next) {
        recordRoutingEvent({
          at: Date.now(),
          model: current,
          action: 'exhausted',
          reason: errorCode === 'timeout' ? 'timeout' : failureReason(error),
        })
        return null
      }
      activeModel = next
      overloadRetries = 0
      recordRoutingEvent({
        at: Date.now(),
        model: current,
        action: 'fallback',
        reason: errorCode === 'timeout' ? 'timeout' : failureReason(error),
        to: next,
      })
      window.dispatchEvent(
        new CustomEvent(GEMINI_ROUTING_EVENT, { detail: { from: current, to: next } }),
      )
      return withModel(settings, next)
    },
  }
}
