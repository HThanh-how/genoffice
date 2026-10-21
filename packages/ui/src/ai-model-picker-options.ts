import {
  AI_PROVIDERS,
  activeProvider,
  customEndpointLabel,
  resolveCustomEndpoints,
  upsertCustomEndpoint,
  type AiProviderId,
  type AiProviderMeta,
  type AiSettings,
} from '@genoffice/ai-provider/browser'

export interface AiModelItemMeta {
  readonly id: string
  readonly label: string
  readonly speed?: 'fast' | 'balanced' | 'slow' | undefined
  readonly relativeCost?: number | undefined
}

export interface AiModelPickerGroup {
  readonly id: AiProviderId
  /** set on custom groups: one group per saved endpoint */
  readonly endpoint?: string | undefined
  readonly label: string
  readonly models: readonly string[]
  readonly modelItems?: readonly AiModelItemMeta[] | undefined
}

export interface AiModelPickerSelection {
  readonly provider: AiProviderId
  readonly endpoint?: string | undefined
  readonly model: string
}

const AGY_UNVERSIONED_GEMINI = /^gemini-(flash|pro)-(low|medium|high)$/

/**
 * Older Antigravity catalogs spelled the rolling Gemini models without a version
 * (`gemini-flash-high`), which duplicated the versioned entry (`gemini-3.8-flash-high`) in the
 * picker. Maps such an alias to the newest versioned twin present in `ids`; any other id, or an
 * alias with no twin, comes back unchanged.
 */
export function resolveAgyModelAlias(id: string, ids: readonly string[]): string {
  const m = AGY_UNVERSIONED_GEMINI.exec(id.trim().toLowerCase())
  if (!m) return id
  const twin = new RegExp(`^gemini-(\\d+)\\.(\\d+)-${m[1]}-${m[2]}$`)
  let best: { id: string; v: number } | null = null
  for (const cand of ids) {
    const t = twin.exec(cand)
    if (!t) continue
    const v = Number(t[1]) * 1000 + Number(t[2])
    if (!best || v > best.v) best = { id: cand, v }
  }
  return best?.id ?? id
}

/** Live Antigravity models with alias duplicates folded into their versioned twin. */
export function dedupeAgyModelItems(items: readonly AiModelItemMeta[]): AiModelItemMeta[] {
  const ids = items.map((m) => m.id)
  const seen = new Set<string>()
  return items.filter((m) => {
    if (resolveAgyModelAlias(m.id, ids) !== m.id) return false
    if (seen.has(m.id)) return false
    seen.add(m.id)
    return true
  })
}

/**
 * A vendor is listed once its stored config is complete enough to chat with: a model, plus a key
 * (a base URL for custom endpoints, which accept anonymous requests); CLI vendors need a model or
 * a path. This build never routes through Genspark, so it is never offered here, signed in or not.
 */
function pickerProviderUsable(
  settings: AiSettings,
  meta: AiProviderMeta,
  liveAgyModels?: readonly AiModelItemMeta[],
): boolean {
  if (meta.id === 'genspark') return false
  const config = settings.providers?.[meta.id]
  const stored = config?.model?.trim() ?? ''
  if (meta.needsCliPath) {
    // a CLI vendor's seeded default model proves nothing: list it once a path, a chosen model
    // or an explicit selection says the person set it up. Live models only apply to Antigravity.
    const agyLive =
      meta.id === 'agy' &&
      Boolean((liveAgyModels && liveAgyModels.length > 0) || settings.provider === 'agy')
    return Boolean(
      agyLive ||
      config?.cliPath?.trim() ||
      (stored && stored !== meta.defaultModel) ||
      (stored && settings.provider === meta.id),
    )
  }
  if (!stored) return false
  if (meta.needsBaseUrl) return Boolean(config?.baseUrl?.trim())
  return Boolean(config?.apiKey?.trim())
}

/**
 * Providers the composer chip may switch to: every vendor whose settings are usable, so picking a
 * row never lands on a 401. A model typed into the settings page that is not in the catalog is
 * listed first. Live AGY models from the CLI can be passed in to enrich the Antigravity group.
 */
export function aiModelPickerGroups(
  input: AiSettings,
  _gskLoggedIn: boolean,
  liveAgyModels?: readonly AiModelItemMeta[],
): AiModelPickerGroup[] {
  const settings = resolveCustomEndpoints(input)
  const groups: AiModelPickerGroup[] = []
  for (const meta of AI_PROVIDERS) {
    if (meta.id === 'custom') {
      for (const ep of settings.customEndpoints ?? []) {
        if (!ep.baseUrl || !ep.model) continue
        // Declared models come before a server probe's answer: a profile entry
        // is the user's own list, which outranks what the server advertised
        // (a server that no longer serves an id the user pinned keeps it
        // selectable). The configured model is pinned to the top, as before.
        const ids = [ep.model, ...(ep.modelProfiles ?? []).map((m) => m.id), ...(ep.models ?? [])]
        const seen = new Set<string>()
        const models = ids.filter((m) => {
          if (!m || seen.has(m)) return false
          seen.add(m)
          return true
        })
        groups.push({
          id: meta.id,
          endpoint: ep.id,
          label: customEndpointLabel(ep, meta.label),
          models,
        })
      }
      continue
    }
    if (!pickerProviderUsable(settings, meta, liveAgyModels)) continue
    if (meta.id === 'agy' && liveAgyModels && liveAgyModels.length > 0) {
      const items = dedupeAgyModelItems(liveAgyModels)
      groups.push({
        id: meta.id,
        label: meta.label,
        models: items.map((m) => m.id),
        modelItems: items,
      })
      continue
    }
    const stored = settings.providers?.[meta.id]?.model?.trim() ?? ''
    const models = stored && !meta.models.includes(stored) ? [stored, ...meta.models] : meta.models
    if (models.length === 0 && !meta.needsCliPath) continue
    groups.push({ id: meta.id, label: meta.label, models })
  }
  return groups
}

export function aiModelPickerSelection(input: AiSettings): AiModelPickerSelection {
  const settings = resolveCustomEndpoints(input)
  const provider = activeProvider(settings)
  const meta = AI_PROVIDERS.find((m) => m.id === provider)
  const model = settings.providers?.[provider]?.model?.trim() || meta?.defaultModel || ''
  if (provider === 'custom' && settings.customEndpoint) {
    return { provider, endpoint: settings.customEndpoint, model }
  }
  return { provider, model }
}

export function withAiModelSelection(input: AiSettings, pick: AiModelPickerSelection): AiSettings {
  const settings = resolveCustomEndpoints(input)
  if (pick.provider === 'custom' && pick.endpoint) {
    const ep = settings.customEndpoints?.find((e) => e.id === pick.endpoint)
    if (ep) {
      return {
        ...upsertCustomEndpoint(settings, { ...ep, model: pick.model }, true),
        provider: 'custom',
      }
    }
  }
  const config = settings.providers[pick.provider] ?? { apiKey: '', model: '' }
  return {
    ...settings,
    provider: pick.provider,
    providers: { ...settings.providers, [pick.provider]: { ...config, model: pick.model } },
  }
}
