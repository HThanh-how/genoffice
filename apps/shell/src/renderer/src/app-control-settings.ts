import { aiModelPickerSelection, withAiModelSelection } from '@genoffice/ui'
import { activeCustomEndpoint } from '@genoffice/ai-provider/browser'
import {
  parseAppControl,
  type AppControlInput,
  type AppActionResult,
} from '@genoffice/agent-core/app-control'
import type { HomeApi } from '../../shared/home-api'
import type { Lang } from '@genoffice/i18n'

/** The same preference and model-selection writers as Settings/the composer. */
export async function runWhitelistedSetting(
  api: HomeApi,
  raw: AppControlInput,
  signal: AbortSignal,
  languageChanged: (lang: Lang) => void,
  selectAgyModel?: (id: string) => Promise<boolean>,
): Promise<AppActionResult> {
  const { kind, ...args } = raw
  const input = parseAppControl(kind, args)
  if (input.kind === 'app_action') throw new Error('Expected a setting request')
  if (signal.aborted) return { status: 'cancelled' }
  if (input.key === 'theme') {
    if (input.kind === 'set_setting') await api.setTheme(input.value as 'light' | 'dark' | 'system')
    return { status: 'completed', value: await api.getTheme() }
  }
  if (input.key === 'language') {
    if (input.kind === 'set_setting') {
      await api.setLanguage(input.value as Lang)
      languageChanged(input.value as Lang)
    }
    return { status: 'completed', value: await api.getLanguage() }
  }
  // Re-read just before writing, as AiModelPicker does. Never expose this object to the model.
  const settings = await api.getAiSettings()
  const selection = aiModelPickerSelection(settings)
  if (input.kind === 'get_setting') return { status: 'completed', value: selection.model }
  if (settings.provider === 'agy') {
    if (!selectAgyModel) throw new Error('The validated model handler is unavailable')
    if (signal.aborted) return { status: 'cancelled' }
    // Same handler as AiModelPicker: it checks the enabled list and live catalog.
    if (!(await selectAgyModel(input.value))) throw new Error('Model selection was refused')
    return { status: 'completed', value: input.value }
  }
  const endpoint = activeCustomEndpoint(settings)
  const choices =
    settings.provider === 'custom'
      ? (endpoint?.models ?? [])
      : (api.getAiProviders().find((p) => p.id === settings.provider)?.models ?? [])
  if (!choices.includes(input.value) && input.value !== selection.model)
    throw new Error('Model is not a configured choice for the current provider')
  if (signal.aborted) return { status: 'cancelled' }
  await api.setAiSettings(withAiModelSelection(settings, { ...selection, model: input.value }))
  return { status: 'completed', value: input.value }
}
