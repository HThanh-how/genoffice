/** Pure helpers behind the Antigravity block of the AI Media & Search panel (no React, for tests). */

interface MediaConfigLike {
  cliPath?: string | undefined
}

/**
 * Config handed to the "Test connection" IPC. The media block's own path wins; otherwise the chat
 * provider's path is used, so the CLI location is configured once (same rule as activeMediaConfig).
 */
export function agyMediaTestConfig<T extends MediaConfigLike>(
  provider: string,
  config: T,
  chatCliPath: string | undefined,
): T {
  if (provider !== 'agy') return config
  const own = config.cliPath?.trim()
  const shared = chatCliPath?.trim()
  return !own && shared ? { ...config, cliPath: shared } : config
}

/** The path the CLI check should use: media override, else the chat provider's, else auto-detect. */
export function agyEffectiveCliPath(
  own: string | undefined,
  chatCliPath: string | undefined,
): string | undefined {
  return own?.trim() || chatCliPath?.trim() || undefined
}

/** Live model list for the dropdown; a stored selection missing from it stays pinned on top. */
export function agyMediaModelOptions(live: string[], seed: string[], selected: string): string[] {
  const base = live.length > 0 ? live : seed
  const pick = selected.trim()
  return pick && !base.includes(pick) ? [pick, ...base] : base
}
