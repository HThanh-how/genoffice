/**
 * Text appended to the system prompt of every streamed AI turn, whatever the provider. The host
 * app supplies it (the reply language and the user's own instructions); it is read on each turn,
 * so a change in Settings or in the instructions file applies to the next message.
 */
let source: (() => string) | null = null

export function setSystemAddendum(provider: (() => string) | null): void {
  source = provider
}

/** `system` followed by the addendum; unchanged when there is none or the provider fails. */
export function withSystemAddendum(system: string): string {
  let extra: string
  try {
    extra = source?.().trim() ?? ''
  } catch {
    extra = ''
  }
  return extra ? `${system}\n\n${extra}` : system
}
