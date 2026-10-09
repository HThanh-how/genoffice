import type { AiSettings } from './types'
import { getProviderAdapter } from './registry'

/**
 * Determines whether the configured AI provider is ready to attempt a chat/agent run.
 *
 * Auth capability rules:
 * - 'agy-cli': local Antigravity CLI does not require an API key or explicit model in config
 * - 'codex-chatgpt': Codex app-server bridge uses the local Codex login session
 * - 'gsk-login': Genspark proxy requires a configured model
 * - 'api-key': direct providers require both a non-empty API key and a model
 */
export function canAttemptChat(settings: AiSettings | null | undefined): boolean {
  if (!settings) return false
  const provider = settings.provider
  const config = settings.providers?.[provider]
  if (!config) return false

  let auth: ReturnType<typeof getProviderAdapter>['capabilities']['auth']
  try {
    auth = getProviderAdapter(provider).capabilities.auth
  } catch {
    return false
  }

  switch (auth) {
    case 'agy-cli':
    case 'codex-chatgpt':
      return true
    case 'gsk-login':
      return Boolean(config.model)
    case 'api-key':
      return Boolean(config.apiKey?.trim() && config.model?.trim())
    default:
      return false
  }
}
