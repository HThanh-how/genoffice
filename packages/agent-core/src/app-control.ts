import type { AgentSkill } from './skill'

export const APP_ACTION_IDS = [
  'open-index-screen',
  'open-settings',
  'new-chat',
  'print',
  'export-pdf',
] as const
export type AppActionId = (typeof APP_ACTION_IDS)[number]
export const SETTINGS_PANES = [
  'general',
  'aiModel',
  'aiMedia',
  'openingEffects',
  'integrations',
  'about',
] as const
export const SETTING_KEYS = ['language', 'theme', 'default-model'] as const
export type SettingKey = (typeof SETTING_KEYS)[number]
const LANGUAGES = [
  'ar',
  'cs',
  'de',
  'en',
  'es',
  'fr',
  'he',
  'hi',
  'id',
  'it',
  'ja',
  'ko',
  'ms',
  'nl',
  'pl',
  'pt',
  'ru',
  'th',
  'tr',
  'vi',
  'zh',
  'zh-TW',
]
export type AppControlInput =
  | { kind: 'app_action'; id: AppActionId; args: Record<string, unknown>; teach: boolean }
  | { kind: 'get_setting'; key: SettingKey }
  | { kind: 'set_setting'; key: SettingKey; value: string }

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function only(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}
/** Runtime allowlist as well as a tool schema: never accepts selectors, IPC or code. */
export function parseAppControl(kind: string, input: unknown): AppControlInput {
  if (!object(input)) throw new Error('Expected an object')
  if (kind === 'app_action' && only(input, ['id', 'args', 'teach'])) {
    if (!APP_ACTION_IDS.includes(input.id as AppActionId)) throw new Error('Unknown app action')
    const args = input.args ?? {}
    if (!object(args) || !only(args, input.id === 'open-settings' ? ['pane'] : []))
      throw new Error('Invalid action arguments')
    if (
      input.id === 'open-settings' &&
      args.pane !== undefined &&
      !SETTINGS_PANES.includes(args.pane as (typeof SETTINGS_PANES)[number])
    )
      throw new Error('Unknown settings pane')
    if (input.teach !== undefined && typeof input.teach !== 'boolean')
      throw new Error('Invalid teach mode')
    return { kind, id: input.id as AppActionId, args, teach: input.teach === true }
  }
  if (
    (kind === 'get_setting' || kind === 'set_setting') &&
    only(input, kind === 'get_setting' ? ['key'] : ['key', 'value'])
  ) {
    if (!SETTING_KEYS.includes(input.key as SettingKey))
      throw new Error('Setting is not whitelisted')
    const key = input.key as SettingKey
    if (kind === 'get_setting') return { kind, key }
    const value = input.value
    if (typeof value !== 'string' || !value.trim() || value.length > 160)
      throw new Error('Invalid setting value')
    if (key === 'theme' && !['light', 'dark', 'system'].includes(value))
      throw new Error('Unknown theme')
    if (key === 'language' && !LANGUAGES.includes(value)) throw new Error('Unknown language')
    return { kind, key, value }
  }
  throw new Error('Invalid app control request')
}

export function needsAppApproval(input: AppControlInput): boolean {
  return (
    input.kind === 'set_setting' ||
    (input.kind === 'app_action' && ['print', 'export-pdf'].includes(input.id))
  )
}
export interface AppActionResult {
  status: 'completed' | 'handoff' | 'cancelled' | 'error'
  value?: string
  error?: string
}
export interface AppActionRequest {
  requestId: string
  input: AppControlInput
}
export interface AppActionBridge {
  prepare(input: AppControlInput): Promise<string>
  execute(requestId: string): Promise<AppActionResult>
  cancel(requestId: string): void
  onRequest(
    ids: string[],
    handler: (request: AppActionRequest) => Promise<AppActionResult>,
  ): () => void
  onCancel(handler: (id: string) => void): () => void
}

export interface AppActionStep {
  label: string
  selector?: string
  event: 'click' | 'observe' | 'handoff'
}
export interface AppActionDefinition {
  id: string
  label: string
  risk: 'safe' | 'confirm'
  teach: boolean
  steps: AppActionStep[]
  resolveSteps?(input: AppControlInput): AppActionStep[]
  highlightSelector?: string
  run(input: AppControlInput, signal: AbortSignal): Promise<AppActionResult>
}
/** Command-palette IDs with renderer-owned implementations. */
export class AppActionRegistry {
  private commands = new Map<string, AppActionDefinition>()
  register(command: AppActionDefinition): void {
    if (this.commands.has(command.id)) throw new Error('Duplicate app action')
    this.commands.set(command.id, command)
  }
  get(id: string): AppActionDefinition {
    const command = this.commands.get(id)
    if (!command) throw new Error('Unregistered app action')
    return command
  }
  ids(): string[] {
    return [...this.commands.keys()]
  }
}

export function createAppControlSkill(deps: {
  bridge: AppActionBridge
  confirm(input: AppControlInput, signal?: AbortSignal): Promise<boolean>
}): AgentSkill {
  const key = { type: 'string', enum: [...SETTING_KEYS] }
  return {
    id: 'app-control',
    systemPrompt: `Use app_action for named app commands, get_setting/set_setting for the three allowed preferences. Set teach:true only when the user wants guidance: it waits for their real clicks. Print and settings changes require explicit approval. A handoff means a dialog opened, never that printing finished. PDF completed means a file was saved. Never invent completion after cancellation/error. default-model selects an already configured model on the current provider; no credentials, paths or endpoints are exposed. new-chat ends the current conversation.`,
    tools: [
      {
        name: 'app_action',
        description:
          'Run an app command, or guide the user through its controls. print/export-pdf target the current Docs document.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', enum: [...APP_ACTION_IDS] },
            args: {
              type: 'object',
              additionalProperties: false,
              properties: { pane: { type: 'string', enum: [...SETTINGS_PANES] } },
            },
            teach: { type: 'boolean' },
          },
          required: ['id'],
        },
      },
      {
        name: 'get_setting',
        description:
          'Read language, theme or the current provider’s default-model. No secret settings.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { key },
          required: ['key'],
        },
      },
      {
        name: 'set_setting',
        description:
          'Change a whitelisted preference after approval; default-model must be an already configured choice.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { key, value: { type: 'string', maxLength: 160 } },
          required: ['key', 'value'],
        },
      },
    ],
    async executeTool(call, signal) {
      let requestId: string | undefined
      let unsubscribe: (() => void) | undefined
      const lifetime = new AbortController()
      const effectiveSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
      const cancel = () => {
        if (requestId) deps.bridge.cancel(requestId)
      }
      try {
        const input = parseAppControl(call.name, call.input)
        if (signal?.aborted) return { output: '{"status":"cancelled"}', summary: call.name }
        // Capture the target BEFORE the approval card; never resolve "current" again afterwards.
        requestId = await deps.bridge.prepare(input)
        unsubscribe = deps.bridge.onCancel((id) => {
          if (id === requestId) lifetime.abort()
        })
        signal?.addEventListener('abort', cancel, { once: true })
        if (
          effectiveSignal.aborted ||
          (needsAppApproval(input) && !(await deps.confirm(input, effectiveSignal)))
        ) {
          return { output: '{"status":"cancelled"}', summary: call.name }
        }
        if (effectiveSignal.aborted) return { output: '{"status":"cancelled"}', summary: call.name }
        const result = await deps.bridge.execute(requestId)
        return {
          output: JSON.stringify(result),
          isError: result.status === 'error',
          summary: call.name,
        }
      } catch (error) {
        return { output: String(error), isError: true, summary: call.name }
      } finally {
        signal?.removeEventListener('abort', cancel)
        unsubscribe?.()
        lifetime.abort()
        cancel()
      }
    },
  }
}
