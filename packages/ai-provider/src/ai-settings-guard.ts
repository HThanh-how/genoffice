/**
 * Schema check for renderer-supplied AI settings. Apps wire it into their AI
 * IPC handlers: 'ai:set-settings' (what gets persisted), 'ai:stream' and
 * 'ai:chat' (what the main process acts on), and 'ai:codex-models' (the direct
 * cliPath probe). SECURITY.md promises payloads are schema-checked in the main
 * process; a compromised renderer must not be able to plant an arbitrary
 * cliPath (later spawn()ed by the Codex app-server) or a baseUrl that would
 * receive the user's gsk bearer token. Electron-free so unit tests can import
 * it directly.
 *
 * Coercion follows the file's own house style (String() narrowing like the
 * web-search handler, filename sanitizing like the style-template handler).
 */
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { normalizeChatModel, resolveChatModels, type ChatCatalog } from './agy-chat'
import { normalizeCustomProfile } from './custom-profile'
import { AI_PROVIDER_ADAPTERS, normalizeBaseUrl } from './registry'
import type {
  AiCustomEndpoint,
  AiCustomProfile,
  AiProviderConfig,
  AiProviderId,
  AiSettings,
} from './types'

const PROVIDER_IDS = Object.keys(AI_PROVIDER_ADAPTERS) as AiProviderId[]

const MAX_API_KEY_LENGTH = 8192
const MAX_MODEL_LENGTH = 256
const MAX_CLI_PATH_LENGTH = 1024
const MAX_ENDPOINT_ID_LENGTH = 64
const MAX_ENDPOINT_NAME_LENGTH = 128
const MAX_ENDPOINT_MODELS = 2000

/**
 * `~` / `~/…` (`~\…` on Windows) expanded against the real home directory, so
 * a user with a non-ASCII home can keep the short form. Non-`~` values pass
 * through untouched.
 */
function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Executable path accepted from the renderer. The Codex app-server hands it to
 * child_process.spawn() without a shell, so metacharacters are inert and no
 * character is rejected — including the non-ASCII user and directory names
 * common in real home paths (`/Users/<name>/bin/codex`,
 * `C:\Users\Ana María\codex.exe`). When the value looks like a path (`/`, `\`
 * or `.` anywhere, or a leading `~`) rather than a bare command, it must exist
 * as a file (`~` expanded for the check). A bare command name ("codex") is
 * kept: it resolves via PATH at spawn time and a miss is a handled ENOENT.
 * Empty means auto-detect.
 */
export function validCliPath(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  const value = raw.trim()
  if (value === '') return false
  if (value.length > MAX_CLI_PATH_LENGTH) return false
  if (/[./\\~]/.test(value)) {
    // a path, not a bare command: it must be an existing file
    try {
      return statSync(expandHome(value)).isFile()
    } catch {
      return false
    }
  }
  return true
}

/** http(s) URL with no embedded credentials, normalized like request time. */
function sanitizeBaseUrl(raw: unknown): string | undefined {
  try {
    return normalizeBaseUrl(typeof raw === 'string' ? raw : '', '')
  } catch {
    return undefined
  }
}

function sanitizeProviderConfig(input: unknown): AiProviderConfig {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const config: AiProviderConfig = {
    apiKey: String(raw.apiKey ?? '').slice(0, MAX_API_KEY_LENGTH),
    model: String(raw.model ?? '').slice(0, MAX_MODEL_LENGTH),
  }
  if (raw.baseUrl !== undefined && raw.baseUrl !== null && raw.baseUrl !== '') {
    const baseUrl = sanitizeBaseUrl(raw.baseUrl)
    if (baseUrl !== undefined) config.baseUrl = baseUrl
  }
  const cliPath = sanitizeCliPath(raw.cliPath)
  if (cliPath !== undefined) config.cliPath = cliPath
  // A custom slot may carry a nested profile; normalizeCustomProfile bounds every
  // field (protocol, headers via the HTTP-legality gate, sizes) and drops the rest.
  const profile = normalizeCustomProfile(raw.profile)
  if (profile !== undefined) config.profile = profile
  return config
}

/**
 * The spawnable form of a renderer-supplied cliPath (trimmed, `~` expanded —
 * spawn() does not expand tilde), or undefined when it fails validCliPath.
 */
export function sanitizeCliPath(raw: unknown): string | undefined {
  return validCliPath(raw) ? expandHome(raw.trim()) : undefined
}

function sanitizeMediaSettings(raw: Record<string, unknown>): AiSettings['media'] {
  const media = { ...raw } as unknown as NonNullable<AiSettings['media']>
  if (typeof raw.providers !== 'object' || raw.providers === null || Array.isArray(raw.providers)) {
    return media
  }
  const providers: Record<string, unknown> = {}
  for (const [id, value] of Object.entries(raw.providers as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const config = { ...(value as Record<string, unknown>) }
    if (config.baseUrl !== undefined && config.baseUrl !== null && config.baseUrl !== '') {
      const baseUrl = sanitizeBaseUrl(config.baseUrl)
      if (baseUrl === undefined) delete config.baseUrl
      else config.baseUrl = baseUrl
    } else {
      delete config.baseUrl
    }
    providers[id] = config
  }
  media.providers = providers as NonNullable<AiSettings['media']>['providers']
  return media
}

function sanitizeCustomEndpoints(raw: unknown): AiCustomEndpoint[] {
  if (!Array.isArray(raw)) return []
  const out: AiCustomEndpoint[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const e = entry as Record<string, unknown>
    const id = String(e.id ?? '')
      .trim()
      .slice(0, MAX_ENDPOINT_ID_LENGTH)
    if (!id) continue
    const config = sanitizeProviderConfig(e)
    const models = Array.isArray(e.models)
      ? e.models
          .filter((m): m is string => typeof m === 'string')
          .slice(0, MAX_ENDPOINT_MODELS)
          .map((m) => m.slice(0, MAX_MODEL_LENGTH))
      : undefined
    // A stored entry carries its profile flat (api/headers/compat/… beside the
    // identity fields); the nested `profile` form is normalized too, so a
    // hand-edited file in either shape survives the gate.
    const flat = normalizeCustomProfile(e) ?? {}
    const nested: AiCustomProfile = config.profile ?? {}
    const profile: AiCustomProfile = { ...flat, ...nested }
    const endpoint: AiCustomEndpoint = {
      id,
      name: String(e.name ?? '').slice(0, MAX_ENDPOINT_NAME_LENGTH),
      baseUrl: config.baseUrl ?? '',
      apiKey: config.apiKey,
      model: config.model,
      ...(models && models.length > 0 ? { models } : {}),
    }
    for (const key of [
      'api',
      'apiKeyEnv',
      'headers',
      'idleTimeoutMs',
      'compat',
      'bodyExtras',
      'modelProfiles',
      'probedProfiles',
    ] as const) {
      if (profile[key] !== undefined) {
        ;(endpoint as unknown as Record<string, unknown>)[key] = profile[key]
      }
    }
    out.push(endpoint)
  }
  return out
}

/**
 * Returns a sanitized copy of `input`, or null when the payload is not even
 * the right shape (non-object, unknown provider). Invalid individual fields
 * are dropped rather than rejecting the whole payload, so a half-filled
 * provider config cannot brick the rest of the settings.
 */
export function sanitizeAiSettings(input: unknown): AiSettings | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const raw = input as Record<string, unknown>
  const provider = raw.provider
  if (typeof provider !== 'string' || !PROVIDER_IDS.includes(provider as AiProviderId)) return null
  if (typeof raw.providers !== 'object' || raw.providers === null || Array.isArray(raw.providers)) {
    return null
  }
  const providers = {} as AiSettings['providers']
  for (const [id, config] of Object.entries(raw.providers as Record<string, unknown>)) {
    if (!PROVIDER_IDS.includes(id as AiProviderId)) continue
    ;(providers as Record<string, AiProviderConfig>)[id] = sanitizeProviderConfig(config)
  }
  const settings: AiSettings = {
    provider: provider as AiProviderId,
    providers,
  }
  if (typeof raw.gskToolsEnabled === 'boolean') settings.gskToolsEnabled = raw.gskToolsEnabled
  const customEndpoints = sanitizeCustomEndpoints(raw.customEndpoints)
  if (customEndpoints.length > 0) {
    settings.customEndpoints = customEndpoints
    if (typeof raw.customEndpoint === 'string') {
      settings.customEndpoint = raw.customEndpoint.slice(0, MAX_ENDPOINT_ID_LENGTH)
    }
  }
  if (
    typeof raw.maxOutputTokens === 'number' &&
    Number.isFinite(raw.maxOutputTokens) &&
    raw.maxOutputTokens > 0
  ) {
    settings.maxOutputTokens = Math.floor(raw.maxOutputTokens)
  }
  // media providers carry a baseUrl that receives their api key: same gate as
  // the chat providers; search carries only enums and api keys
  if (typeof raw.media === 'object' && raw.media !== null && !Array.isArray(raw.media)) {
    settings.media = sanitizeMediaSettings(raw.media as Record<string, unknown>)
  }
  if (typeof raw.search === 'object' && raw.search !== null && !Array.isArray(raw.search)) {
    settings.search = raw.search as AiSettings['search']
  }
  return settings
}

/**
 * Schema checking is not the same as live validation. `sanitizeAiSettings` bounds the shape of a
 * payload; it cannot know whether the Antigravity CLI that is configured right now can serve the
 * chat model the renderer is asking to store.
 *
 * The rule the validated selection path already enforces is repeated here at the generic write
 * boundary, so no renderer - Settings page, composer picker, or a direct IPC call - can persist an
 * Antigravity chat model that the main process would refuse to use:
 *
 *   a new Antigravity model must be confirmed by the configured CLI's catalog
 *   (read successfully) and switched on in the chat box's enabled list.
 *
 * Preserving what is already stored is not a new selection, so an unchanged model is never
 * touched, and a failed catalog never erases a model the person already chose. Only the model
 * field is rewritten; every other provider, key, endpoint, search and media setting is written
 * through unchanged.
 */
export interface SettingsWriteDecision {
  /** what may be persisted; null when the payload itself is not a settings object */
  settings: AiSettings | null
  /** true when the payload was accepted exactly as sent */
  ok: boolean
  /** why an Antigravity model change was refused, or why the payload could not be committed */
  reason?:
    | 'unverified'
    | 'not-confirmed'
    | 'not-enabled'
    | 'unknown-policy'
    | 'stale-model'
    | 'conflict'
    | 'write-failed'
}

/**
 * `catalogFor` is only called when the payload actually changes the Antigravity chat model, so
 * saving an unrelated setting never spawns `agy models`.
 */
export async function decideSettingsWrite(
  input: unknown,
  previous: AiSettings | null,
  catalogFor: (cliPath: string | undefined) => Promise<ChatCatalog>,
  savedEnabledModels: unknown,
  /** false when this process cannot read the person's enabled-model list (a standalone editor) */
  enabledPolicyKnown = true,
): Promise<SettingsWriteDecision> {
  const settings = sanitizeAiSettings(input)
  if (!settings) return { settings: null, ok: false }

  const incoming = normalizeChatModel(settings.providers.agy?.model)
  const stored = normalizeChatModel(previous?.providers?.agy?.model)
  // nothing changed, or the model was cleared: neither authorizes an unverified model
  if (incoming === stored || incoming === undefined) return { settings, ok: true }
  // A process that cannot read the enabled list cannot prove a *new* choice is allowed, so it
  // refuses the mutation instead of falling back to the seed list. Nothing else is touched.
  if (!enabledPolicyKnown) {
    const agy = settings.providers.agy ?? { apiKey: '', model: '' }
    return {
      settings: {
        ...settings,
        providers: { ...settings.providers, agy: { ...agy, model: stored ?? '' } },
      },
      ok: false,
      reason: 'unknown-policy',
    }
  }

  const catalog = await catalogFor(
    typeof settings.providers.agy?.cliPath === 'string' && settings.providers.agy.cliPath.trim()
      ? settings.providers.agy.cliPath.trim()
      : undefined,
  )
  const resolved = resolveChatModels({
    savedEnabled: savedEnabledModels,
    savedModel: stored ?? '',
    catalog,
  })
  if (
    catalog.error ||
    !resolved.available.includes(incoming) ||
    !resolved.enabled.includes(incoming)
  ) {
    const agy = settings.providers.agy ?? { apiKey: '', model: '' }
    const kept: AiSettings = {
      ...settings,
      providers: { ...settings.providers, agy: { ...agy, model: stored ?? '' } },
    }
    return {
      settings: kept,
      ok: false,
      reason: catalog.error
        ? 'unverified'
        : resolved.enabled.includes(incoming)
          ? 'not-confirmed'
          : 'not-enabled',
    }
  }
  return { settings, ok: true }
}

/**
 * Every top-level field the generic writer can carry, compared as one value. `providers` is
 * merged one provider at a time so a change to one provider never collides with a change to
 * another, and the Antigravity entry is merged field by field because a payload can move the
 * chat model without touching the CLI path (or the other way round).
 */
const WHOLE_FIELDS = [
  'provider',
  'customEndpoints',
  'customEndpoint',
  'media',
  'search',
  'gskToolsEnabled',
  'maxOutputTokens',
] as const

/** how many times a write retries when the file moves under it before the swap lands */
const COMMIT_ATTEMPTS = 3

/** JSON-stable comparison, so two reads of the same file compare equal whatever key order. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/** the exact bytes a decision was merged against, the compare side of the swap */
function settingsFingerprint(settings: AiSettings | null): string {
  return JSON.stringify(settings ?? null)
}

/**
 * Three-way merge of an accepted payload against the newest commit.
 *
 * `incoming` is the payload relative to `base` - the fields it differs from the base are the
 * changes this writer made. Anything the writer did not change takes the newest committed value,
 * so an unrelated change made in another window is never rolled back. A field both sides changed
 * to different values is a genuine collision and is refused rather than guessed.
 */
function mergeSettings(
  base: AiSettings,
  latest: AiSettings,
  incoming: AiSettings,
): { settings: AiSettings } | { reason: 'stale-model' | 'conflict' } {
  const merged: AiSettings = { ...incoming, providers: { ...incoming.providers } }
  const fields = merged as unknown as Record<string, unknown>
  const incomingAgy = incoming.providers.agy
  const baseAgy = base.providers.agy
  const latestAgy = latest.providers.agy

  // 1. Antigravity chat model
  const incomingModel = normalizeChatModel(incomingAgy?.model)
  const baseModel = normalizeChatModel(baseAgy?.model)
  const latestModel = normalizeChatModel(latestAgy?.model)
  if (latestModel !== baseModel) {
    // two windows choosing the same model is not a collision; choosing different models is
    if (incomingModel !== baseModel && incomingModel !== latestModel)
      return { reason: 'stale-model' }
    merged.providers.agy = {
      ...(merged.providers.agy ?? { apiKey: '', model: '' }),
      model: latestModel ?? '',
    }
  }

  // 2. Antigravity CLI identity
  const incomingCli = sanitizeCliPath(incomingAgy?.cliPath)
  const baseCli = sanitizeCliPath(baseAgy?.cliPath)
  const latestCli = sanitizeCliPath(latestAgy?.cliPath)
  if (latestCli !== baseCli) {
    if (incomingCli !== baseCli || incomingModel !== baseModel) return { reason: 'conflict' }
    if (merged.providers.agy) merged.providers.agy.cliPath = latestCli
  }

  // 3. active provider and every other provider configuration
  if (!sameValue(latest.provider, base.provider)) {
    if (!sameValue(incoming.provider, base.provider)) return { reason: 'conflict' }
    fields.provider = latest.provider
  }
  for (const p of PROVIDER_IDS) {
    if (p === 'agy') continue
    const latestCfg = latest.providers[p]
    const baseCfg = base.providers[p]
    const incomingCfg = incoming.providers[p]
    if (sameValue(latestCfg, baseCfg)) continue
    if (!sameValue(incomingCfg, baseCfg)) return { reason: 'conflict' }
    if (latestCfg) merged.providers[p] = latestCfg
    else delete merged.providers[p]
  }

  // 4. every remaining persisted field: endpoints, media, search, tool switches, token caps
  for (const field of WHOLE_FIELDS) {
    if (field === 'provider') continue
    const before = base[field]
    const newest = latest[field]
    if (sameValue(newest, before)) continue
    if (!sameValue(incoming[field], before)) return { reason: 'conflict' }
    if (newest === undefined) delete fields[field]
    else fields[field] = newest
  }
  return { settings: merged }
}

/**
 * The write boundary every editor uses.
 *
 * Validation is asynchronous, so the file on disk may have been replaced by another window
 * between reading the snapshot and committing. The accepted payload is merged field by field
 * against the newest committed state, re-validated against it, and then swapped in only if the
 * bytes it was merged against are still there. If the file moved in the meantime the merge is
 * retaken against the newer state; a collision that cannot be resolved is reported as an explicit
 * conflict instead of silently overwriting the newer change.
 *
 * Limitation, stated plainly: the payload is a whole settings object and this process cannot know
 * which baseline the renderer read it from, so this is an optimistic compare-and-swap, not a
 * cross-process transaction. A window that submits a stale whole snapshot is indistinguishable
 * from one that deliberately set those fields back; what is guaranteed is that no accepted change
 * disappears without an explicit conflict being reported.
 */
export async function applySettingsWrite(
  input: unknown,
  readSettings: () => AiSettings | null,
  writeSettings: (settings: AiSettings) => void,
  catalogFor: (cliPath: string | undefined) => Promise<ChatCatalog>,
  enabledModels: unknown,
  enabledPolicyKnown = true,
): Promise<SettingsWriteDecision> {
  const snapshot = readSettings()
  const decision = await decideSettingsWrite(
    input,
    snapshot,
    catalogFor,
    enabledModels,
    enabledPolicyKnown,
  )
  if (!decision.ok || !decision.settings) return decision

  // both sides of the merge are compared in the same normalised shape, so a field the sanitiser
  // bounds (a baseUrl, a truncated key) is not mistaken for somebody else's change
  const base = snapshot ? (sanitizeAiSettings(snapshot) ?? snapshot) : null

  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
    const latestRaw = readSettings()
    const latest = latestRaw ? (sanitizeAiSettings(latestRaw) ?? latestRaw) : null
    const merged =
      latest && base
        ? mergeSettings(base, latest, decision.settings)
        : { settings: decision.settings }
    if (!('settings' in merged)) return { settings: null, ok: false, reason: merged.reason }

    const rechecked = await decideSettingsWrite(
      merged.settings,
      latest,
      catalogFor,
      enabledModels,
      enabledPolicyKnown,
    )
    if (!rechecked.ok || !rechecked.settings) return rechecked

    // commit boundary: the swap lands only while the file still holds the state merged above
    if (settingsFingerprint(readSettings()) === settingsFingerprint(latestRaw)) {
      try {
        writeSettings(rechecked.settings)
      } catch {
        // nothing was committed: report the failure instead of claiming the settings were saved
        return { settings: null, ok: false, reason: 'write-failed' }
      }
      return { settings: rechecked.settings, ok: true }
    }
    // the file moved while the payload was being re-validated: retry against the newer state
  }
  return { settings: null, ok: false, reason: 'conflict' }
}
