/** Browser-safe settings surface. Keep Node-backed transports out of renderer bundles. */
export type {
  AiCustomEndpoint,
  AiProviderConfig,
  AiProviderId,
  AiProviderMeta,
  AiSettings,
  CodexModelCatalog,
} from './types'
export type { GeminiModelInfo } from './gemini-models'
export {
  createGeminiRouter,
  GEMINI_DEFAULT_ORDER,
  GEMINI_ROUTING_EVENT,
  readGeminiChoice,
  readGeminiModels,
  readGeminiUsage,
  saveGeminiChoice,
  saveGeminiModels,
} from './gemini-routing'
export type { GeminiModelChoice } from './gemini-routing'
export {
  AI_PROVIDERS,
  activeProvider,
  cloudToolsEnabled,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_MAX_OUTPUT_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
  clampMaxOutputTokens,
} from './providers'
export {
  activeCustomEndpoint,
  customEndpointLabel,
  newCustomEndpointId,
  removeCustomEndpoint,
  resolveCustomEndpoints,
  selectCustomEndpoint,
  upsertCustomEndpoint,
} from './custom-endpoints'
export { getProviderAdapter, modelLacksVision } from './registry'
export { AI_MEDIA_PROVIDERS, imageGenerationAvailable, mediaAnalysisAvailable } from './media'
export { AI_SEARCH_PROVIDERS } from './search-settings'
export { agyErrorText, formatAgyResetTime } from './agy-error-text'
export type { AgyErrorLang, AgyErrorTextCode } from './agy-error-text'
