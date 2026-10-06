import { canAttemptChat, type AiSettings } from '@genoffice/ai-provider/browser'
import type { AttachmentMeta } from '../../shared/desktop-api'

export type PromptRouteAction = 'agent' | 'deterministic' | 'unconfigured'

export interface PromptRouteResult {
  readonly action: PromptRouteAction
  readonly message?: string | undefined
  readonly isError?: boolean | undefined
}

export interface RoutePromptOptions {
  readonly instruction: string
  readonly sentAtts?: readonly AttachmentMeta[] | undefined
  readonly currentSettings: AiSettings | null
  readonly getFreshSettings: () => Promise<AiSettings | null>
  readonly runAgent: (
    instruction: string,
    sentAtts: readonly AttachmentMeta[],
  ) => void | Promise<void>
  readonly runDeterministicPlan: (instruction: string) => {
    readonly text: string
    readonly isError?: boolean | undefined
    readonly unsupported?: boolean | undefined
  }
}

/**
 * Core routing logic for sheets AI chat:
 * 1. Refreshes AI settings via getFreshSettings each time a prompt is sent.
 * 2. If effective settings pass canAttemptChat -> delegates to runAgent.
 * 3. If settings are not ready for chat -> falls back to runDeterministicPlan.
 *    - If deterministic plan supports the syntax (set A1 to 42, etc.) -> returns plan result.
 *    - If unsupported (natural language query) -> returns action: 'unconfigured' with isError: true.
 */
export async function routePrompt(options: RoutePromptOptions): Promise<PromptRouteResult> {
  const {
    instruction,
    sentAtts,
    currentSettings,
    getFreshSettings,
    runAgent,
    runDeterministicPlan,
  } = options

  const freshSettings = await getFreshSettings()
  const effectiveSettings = freshSettings ?? currentSettings

  if (canAttemptChat(effectiveSettings)) {
    await runAgent(instruction, sentAtts ?? [])
    return { action: 'agent' }
  }

  const local = runDeterministicPlan(instruction)
  if (local.unsupported) {
    return { action: 'unconfigured', isError: true }
  }

  return { action: 'deterministic', message: local.text, isError: local.isError }
}
