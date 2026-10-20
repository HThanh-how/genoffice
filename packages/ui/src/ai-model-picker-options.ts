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
  /** Antigravity only: false means the person switched this model off */
  readonly enabled?: boolean | undefined
  /** Antigravity only: false means the CLI could not be reached, so availability is unconfirmed */
  readonly verified?: boolean | undefined
}

export interface AiModelPickerGroup {
  readonly id: AiProviderId
  /** set on custom groups: one group per saved endpoint */
  readonly endpoint?: string | undefined
  readonly label: string
  readonly models: readonly string[]
  /** Antigravity only: the stored model, shown as the current configuration but not selectable */
  readonly unusable?: readonly string[] | undefined
  readonly modelItems?: readonly AiModelItemMeta[] | undefined
}

export interface AiModelPickerSelection {
  readonly provider: AiProviderId
  readonly endpoint?: string | undefined
  readonly model: string
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
  /** true when the Antigravity catalog could not be read, so nothing is confirmed */
  agyCatalogFailed = false,
  /**
   * true when this window can reach the Antigravity selection handler. Without it an Antigravity
   * model could only be written through the generic settings route, which checks nothing, so no
   * Antigravity model is offered as selectable.
   */
  agySelectionAvailable = true,
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
    // Once the chat box has answered, its list is the only truth about Antigravity: an empty
    // answer means "no model is selectable", not "use the hardcoded seed". The seed is only used
    // when there is no live state at all (no preload bridge).
    if (meta.id === 'agy') {
      const stored = settings.providers?.agy?.model?.trim() ?? ''
      if (!agySelectionAvailable) {
        // This window cannot reach the Antigravity selection handler, so no Antigravity model can
        // be validated here. The group stays visible when Antigravity is already the provider (the
        // chip then keeps naming it), but nothing in it is clickable.
        if (stored || settings.provider === 'agy') {
          groups.push({
            id: meta.id,
            label: meta.label,
            models: [],
            unusable: stored ? [stored] : [],
            modelItems: liveAgyModels,
          })
        }
        continue
      }
      // Only models the person switched on *and* the CLI positively confirmed are selectable. A
      // catalog that could not be read proves nothing, so it can never widen this list: an
      // unconfirmed model is not the same as an empty catalog, and a failure is not permission.
      // A stored model that is switched off, unconfirmed or absent from the verified catalog is
      // still shown, as the current configuration, so the chip never lies about what is saved -
      // but it is marked unusable and cannot be clicked. With nothing usable and nothing stored
      // the group is omitted: the hardcoded provider seed is not evidence that a model exists.
      if (liveAgyModels === undefined) continue
      const usable = liveAgyModels
        .filter((m) => m.enabled !== false && !agyCatalogFailed && m.verified === true)
        .map((m) => m.id)
      const unusable = stored && !usable.includes(stored) ? [stored] : []
      if (usable.length === 0 && unusable.length === 0) continue
      groups.push({
        id: meta.id,
        label: meta.label,
        models: usable,
        unusable,
        modelItems: liveAgyModels,
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

/**
 * What the composer chip should show. For Antigravity the live chat selection wins over the
 * stored model: the CLI decides the first-run model, and the picker must not display a model the
 * chat box is not actually using.
 */
export function aiModelPickerSelection(
  input: AiSettings,
  liveAgySelected?: string | undefined,
): AiModelPickerSelection {
  const settings = resolveCustomEndpoints(input)
  const provider = activeProvider(settings)
  const meta = AI_PROVIDERS.find((m) => m.id === provider)
  const live = provider === 'agy' ? (liveAgySelected?.trim() ?? '') : ''
  const stored = settings.providers?.[provider]?.model?.trim() ?? ''
  // Antigravity has no seeded default: when neither the chat box nor the stored settings name a
  // model, the chip shows "choose a model" rather than a model the CLI never confirmed.
  const model = live || stored || (provider === 'agy' ? '' : (meta?.defaultModel ?? ''))
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
