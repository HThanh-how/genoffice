import { createIpcTransport, type AgentTransport } from '@genoffice/agent-core'
import { agyErrorText, createGeminiRouter } from '@genoffice/ai-provider/browser'
import type { AiSettings } from '@genoffice/ai-provider'
import { getLang, t } from '../i18n/locale'

/** The shared IPC transport wired to the markdown preload bridge (window.markdownApi). */
export function createElectronTransport(getSettings: () => AiSettings): AgentTransport {
  return createIpcTransport<AiSettings>({
    route: createGeminiRouter(),
    onStream: (listener) => window.markdownApi.onAiStream(listener),
    start: (request) => window.markdownApi.aiStream(request),
    cancel: (requestId) => void window.markdownApi.aiStreamCancel(requestId),
    getSettings,
    unknownErrorText: () => t('aiUnknownError'),
    timeoutErrorText: () => t('aiTimeoutError'),
    creditsErrorText: () => t('aiCreditsExhausted'),
    networkErrorText: () => t('aiNetworkError'),
    overloadedErrorText: () => t('aiOverloadedError'),
    quotaErrorText: (resetAt) => agyErrorText(getLang(), 'quota', { resetAt }),
    authErrorText: () => agyErrorText(getLang(), 'auth'),
  })
}
