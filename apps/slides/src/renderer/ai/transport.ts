import { createIpcTransport, type AgentTransport } from '@genoffice/agent-core'
import { agyErrorText, createGeminiRouter } from '@genoffice/ai-provider/browser'
import type { AiSettings } from '../../shared/ipc'
import { getLang, t } from '../i18n/locale'

/** The shared IPC transport wired to the slides preload bridge (window.slidesApi). */
export function createElectronTransport(getSettings: () => AiSettings): AgentTransport {
  return createIpcTransport<AiSettings>({
    route: createGeminiRouter(),
    onStream: (listener) => window.slidesApi.onAiStream(listener),
    start: (request) => window.slidesApi.aiStream(request),
    cancel: (requestId) => void window.slidesApi.aiStreamCancel(requestId),
    getSettings,
    unknownErrorText: () => t('aiErrUnknown'),
    timeoutErrorText: () => t('aiErrStreamTimeout'),
    creditsErrorText: () => t('aiCreditsExhausted'),
    networkErrorText: () => t('aiErrNetwork'),
    overloadedErrorText: () => t('aiErrOverloaded'),
    quotaErrorText: (resetAt) => agyErrorText(getLang(), 'quota', { resetAt }),
    authErrorText: () => agyErrorText(getLang(), 'auth'),
  })
}
