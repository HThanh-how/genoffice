import type { AiSettings } from './types'
import type { AgentStreamRequest } from '@genoffice/agent-core'
import type { GeminiModelInfo } from './gemini-models'

export const GEMINI_CHOICE_KEY = 'genoffice-gemini-model-choice-v1'
export const GEMINI_MODELS_KEY = 'genoffice-gemini-models-v1'
export const GEMINI_ROUTING_EVENT = 'genoffice-gemini-routing-changed'
export const GEMINI_USAGE_KEY = 'genoffice-gemini-usage-v1'
const GEMINI_COOLDOWN_KEY = 'genoffice-gemini-cooldowns-v1'

export type GeminiModelChoice = 'auto' | 'smart' | 'fast' | `model:${string}`

export const GEMINI_DEFAULT_ORDER = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
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
  const seconds = retryDelay ? Math.min(3600, Number(retryDelay[1])) : 60
  const saved = readCooldowns()
  saved[model] = daily ? { day: pacificDate() } : { until: Date.now() + seconds * 1000 }
  try {
    localStorage.setItem(GEMINI_COOLDOWN_KEY, JSON.stringify(saved))
  } catch {
    /* session fallback */
  }
}

function candidates(choice: GeminiModelChoice, configured: string): string[] {
  if (choice.startsWith('model:')) return [choice.slice(6)]
  const allowed = new Set(
    readGeminiModels()
      .filter((m) => m.usableForChat)
      .map((m) => m.id),
  )
  const defaults = GEMINI_DEFAULT_ORDER.filter((id) => allowed.size === 0 || allowed.has(id))
  const list =
    choice === 'fast'
      ? defaults.filter((id) => id.includes('lite'))
      : choice === 'smart'
        ? defaults.filter((id) => !id.includes('lite'))
        : defaults
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
  let retryCount = 0
  return {
    onAttempt(settings: AiSettings): void {
      if (settings.provider === 'gemini') recordGeminiAttempt(settings.providers.gemini.model)
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
      }
      if (activeDay !== pacificDate()) {
        activeDay = pacificDate()
        activeModel = ''
      }
      const order = candidates(choice, settings.providers.gemini.model).filter(
        (model) => choice.startsWith('model:') || !onCooldown(model),
      )
      if (!activeModel || !order.includes(activeModel))
        activeModel = order[0] || settings.providers.gemini.model
      retryCount = 0
      return withModel(settings, activeModel)
    },
    fallback(settings: AiSettings, error: string, emitted: boolean): AiSettings | null {
      if (settings.provider !== 'gemini' || emitted || choice.startsWith('model:')) return null
      if (!/Gemini HTTP (429|503)\b|RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(error)) return null
      if (retryCount++ >= 5) return null
      coolDown(settings.providers.gemini.model, error)
      const order = candidates(choice, settings.providers.gemini.model)
      const current = settings.providers.gemini.model
      const next = order.slice(order.indexOf(current) + 1).find((model) => !onCooldown(model))
      if (!next) return null
      activeModel = next
      window.dispatchEvent(
        new CustomEvent(GEMINI_ROUTING_EVENT, { detail: { from: current, to: next } }),
      )
      return withModel(settings, next)
    },
  }
}
