import { aiFetch } from './fetch'
import { GEMINI_BASE_URL } from './protocols/gemini'

export interface GeminiModelInfo {
  id: string
  displayName: string
  description: string
  inputTokenLimit?: number
  outputTokenLimit?: number
  usableForChat: boolean
}

/** The Models API describes capabilities, but does not expose a project's remaining quota. */
export async function listGeminiModels(apiKey: string): Promise<GeminiModelInfo[]> {
  if (!apiKey.trim()) throw new Error('A Gemini API key is required to list models')
  const models: GeminiModelInfo[] = []
  let pageToken = ''
  for (let page = 0; page < 100; page++) {
    const url = new URL(`${GEMINI_BASE_URL}/models`)
    url.searchParams.set('pageSize', '100')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const response = await aiFetch(url.toString(), {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Gemini model list failed (HTTP ${response.status})`)
    const body = (await response.json()) as {
      models?: Array<{
        name?: string
        displayName?: string
        description?: string
        inputTokenLimit?: number
        outputTokenLimit?: number
        supportedGenerationMethods?: string[]
      }>
      nextPageToken?: string
    }
    for (const model of body.models ?? []) {
      if (!model.name?.startsWith('models/')) continue
      const id = model.name.slice('models/'.length)
      models.push({
        id,
        displayName: model.displayName || model.name.slice('models/'.length),
        description: model.description || '',
        ...(typeof model.inputTokenLimit === 'number'
          ? { inputTokenLimit: model.inputTokenLimit }
          : {}),
        ...(typeof model.outputTokenLimit === 'number'
          ? { outputTokenLimit: model.outputTokenLimit }
          : {}),
        usableForChat:
          (model.supportedGenerationMethods?.includes('generateContent') ?? false) &&
          (/^gemini-/i.test(id) || /^gemma-4-(26b-a4b|31b)-it$/i.test(id)) &&
          !/(image|tts|live|transcribe|embedding|native-audio|robotics|video)/i.test(id),
      })
    }
    if (!body.nextPageToken) return models
    pageToken = body.nextPageToken
  }
  throw new Error('Gemini model list exceeded the pagination limit')
}
