/**
 * The acknowledgement contract shared by every editor's `ai:set-settings` IPC handler.
 *
 * A settings write is successful only when the main process affirms it with `ok: true`.
 * Anything else - `null`, `undefined`, a malformed response, `ok: false`, or a transport
 * failure - is a failure, and the renderer must not report "Saved" for it. Keeping the rule in
 * one place means Shell, Docs, Slides and Sheets cannot drift apart.
 */
export interface SettingsWriteResult {
  ok?: boolean
  reason?: string
}

const REASONS: Record<string, string> = {
  invalid: 'the payload was invalid',
  unverified: 'Antigravity could not confirm that model',
  'not-confirmed': 'the Antigravity CLI no longer reports that model',
  'not-enabled': 'that model is switched off in the chat box settings',
  'unknown-policy': 'this app cannot read the model policy for the chat box',
  'stale-model': 'another window chose a different model first',
  conflict: 'another window changed those settings first',
  stale: 'another window changed the settings first',
  'write-failed': 'the settings file could not be written',
}

/** Returns the settings that were committed, or throws with a user-readable reason. */
export function assertSettingsSaved(result: unknown): SettingsWriteResult {
  if (result && typeof result === 'object' && (result as SettingsWriteResult).ok === true)
    return result as SettingsWriteResult
  const reason =
    result && typeof result === 'object' ? (result as SettingsWriteResult).reason : undefined
  const detail = REASONS[reason ?? ''] ?? 'the app did not acknowledge the write'
  throw new Error(`The settings were not saved: ${detail}.`)
}
