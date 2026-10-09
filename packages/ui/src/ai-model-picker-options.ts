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

export interface AiModelPickerGroup {
  readonly id: AiProviderId
  /** set on custom groups: one group per saved endpoint */
  readonly endpoint?: string | undefined
  readonly label: string
  readonly models: readonly string[]
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
function pickerProviderUsable(settings: AiSettings, meta: AiProviderMeta): boolean {
  if (meta.id === 'genspark') return false
  const config = settings.providers?.[meta.id]
  const stored = config?.model?.trim() ?? ''
  if (meta.needsCliPath) {
    // a CLI vendor's seeded default model proves nothing: list it once a path, a chosen model
    // or an explicit selection says the person set it up
    return Boolean(
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
 * listed first.
 */
export function aiModelPickerGroups(
  input: AiSettings,
  _gskLoggedIn: boolean,
): AiModelPickerGroup[] {
  const settings = resolveCustomEndpoints(input)
  const groups: AiModelPickerGroup[] = []
  for (const meta of AI_PROVIDERS) {
    if (meta.id === 'custom') {
      for (const ep of settings.customEndpoints ?? []) {
        if (!ep.baseUrl || !ep.model) continue
        const models = [ep.model, ...(ep.models ?? []).filter((m) => m !== ep.model)]
        groups.push({
          id: meta.id,
          endpoint: ep.id,
          label: customEndpointLabel(ep, meta.label),
          models,
        })
      }
      continue
    }
    if (!pickerProviderUsable(settings, meta)) continue
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
