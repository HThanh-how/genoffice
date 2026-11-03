import { canAttemptChat, type AiSettings } from '@genoffice/ai-provider/browser'

/** What the local, deterministic planner answered (it understands only a few fixed commands). */
export interface LocalPlanResult {
  readonly text: string
  readonly isError?: boolean | undefined
  /** natural language: the planner has no command for it, and changed nothing */
  readonly unsupported?: boolean | undefined
}

export type BlockedReason = 'not-configured' | 'settings-unreadable'

/**
 * How one send ended. Only `agent` and `local` consumed the message (bubble, composer, chips,
 * attachments); every other outcome left all of it where the user typed it.
 */
export type SendOutcome =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'blocked'; readonly reason: BlockedReason }
  | { readonly kind: 'agent' }
  | { readonly kind: 'local' }

export interface SendFlowDeps<TSent> {
  readonly instruction: string
  /** synchronous lock: a second send while the first still decides is ignored, not queued */
  readonly lock: { held: boolean }
  readonly currentSettings: () => AiSettings | null
  /** re-reads the stored settings; may reject (IPC failure) and may resolve to null */
  readonly getFreshSettings: () => Promise<AiSettings | null>
  /** make these the settings the agent run reads, so the decision and the run use one source */
  readonly adoptSettings: (settings: AiSettings) => void
  /** an agent loop exists and is neither running nor starting */
  readonly canStartAgent: () => boolean
  /** the user's message becomes a bubble; composer, chips and attachments clear */
  readonly consume: () => TSent
  readonly startAgent: (sent: TSent) => void
  readonly runDeterministicPlan: (instruction: string) => LocalPlanResult
  readonly replyLocal: (sent: TSent, result: LocalPlanResult) => void
  /** nothing could handle the message and nothing was consumed: say why */
  readonly onBlocked: (reason: BlockedReason) => void
  readonly log: (message: string, error: unknown) => void
}

/**
 * The send path of the Sheets AI chat, in one place so it can be tested as it runs:
 *
 * 1. Re-read the AI settings at every send (the first send can race the initial settings load).
 *    If that fails, fall back to the settings already held and remember that they were unreadable.
 * 2. A provider that can chat gets the message, whatever it says: natural language and commands alike.
 *    If a run cannot start right now, nothing is consumed (`busy`) so the message is not lost.
 * 3. Without a usable provider, the local planner still serves its fixed commands ("set A1 to 42").
 *    Anything else is `blocked`, with the real reason (not configured vs. settings unreadable) and
 *    without consuming the message, so the user can fix the settings and send it again.
 */
export async function runSendFlow<TSent>(deps: SendFlowDeps<TSent>): Promise<SendOutcome> {
  const instruction = deps.instruction.trim()
  if (!instruction || deps.lock.held) return { kind: 'ignored' }
  deps.lock.held = true
  try {
    let settings: AiSettings | null
    let unreadable = false
    try {
      const fresh = await deps.getFreshSettings()
      // read the held settings AFTER the wait: a settings-changed event may have updated them meanwhile
      settings = fresh ?? deps.currentSettings()
    } catch (error) {
      unreadable = true
      deps.log('could not read the AI settings', error)
      settings = deps.currentSettings()
    }

    if (settings && canAttemptChat(settings)) {
      if (!deps.canStartAgent()) return { kind: 'busy' }
      deps.adoptSettings(settings)
      deps.startAgent(deps.consume())
      return { kind: 'agent' }
    }

    let local: LocalPlanResult
    try {
      local = deps.runDeterministicPlan(instruction)
    } catch (error) {
      // the planner understood the command but could not apply it: that is an answer, not "unsupported"
      local = {
        text: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
    if (local.unsupported) {
      const reason: BlockedReason =
        unreadable && !settings ? 'settings-unreadable' : 'not-configured'
      deps.onBlocked(reason)
      return { kind: 'blocked', reason }
    }
    deps.replyLocal(deps.consume(), local)
    return { kind: 'local' }
  } finally {
    deps.lock.held = false
  }
}
