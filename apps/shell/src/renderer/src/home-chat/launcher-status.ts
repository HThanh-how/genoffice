/**
 * Status of the minimized Home assistant launcher: what the floating pill says while
 * the panel is collapsed (idle / working / answer ready / error) and whether there is
 * something unread. Pure TypeScript with injectable timers so it is unit-testable.
 */

/** How long a finished answer's one-line preview stays on the launcher. */
export const PREVIEW_MS = 8_000
/** The elapsed-seconds counter only appears once a reply has taken this long. */
export const ELAPSED_AFTER_S = 5
export const PREVIEW_MAX = 70

export type LauncherPhase = 'idle' | 'working' | 'done' | 'error'

export interface LauncherState {
  phase: LauncherPhase
  /** wall-clock ms when the running reply started (meaningful while `working`) */
  startedAt: number
  /** one-line plain-text preview of the finished answer (while `done`) */
  preview: string
  /** something finished while the panel was minimized; stays until the panel is opened */
  unread: false | 'done' | 'error'
}

export const IDLE_STATE: LauncherState = { phase: 'idle', startedAt: 0, preview: '', unread: false }

export type RunResult =
  | { kind: 'done'; text: string }
  | { kind: 'error' }
  /** user pressed Stop, or the conversation was switched: nothing to announce */
  | { kind: 'stopped' }

interface Timers {
  now(): number
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
}

export interface LauncherController {
  getState(): LauncherState
  runStarted(): void
  runFinished(result: RunResult): void
  setPanelOpen(open: boolean): void
  /** hover or keyboard focus on the launcher keeps a preview on screen */
  setHovered(hovered: boolean): void
  /** the user has seen the chat (panel opened or window refocused while open) */
  acknowledge(): void
  dispose(): void
}

/**
 * State machine behind the launcher chip.
 * - runStarted: `working`.
 * - runFinished while minimized: `done` (preview + unread, collapses to the plain pill
 *   after PREVIEW_MS unless hovered, the unread mark stays) or `error` (stays until opened).
 * - runFinished while the panel is open, or a stopped run: back to `idle`, nothing unread.
 * - opening the panel acknowledges: unread clears, a finished chip returns to `idle`.
 */
export function createLauncherController(
  onChange: (state: LauncherState) => void,
  timers: Timers = realTimers,
): LauncherController {
  let state = IDLE_STATE
  let panelOpen = false
  let hovered = false
  let timer: unknown = null

  const set = (next: LauncherState) => {
    if (
      next.phase === state.phase &&
      next.startedAt === state.startedAt &&
      next.preview === state.preview &&
      next.unread === state.unread
    )
      return
    state = next
    onChange(state)
  }
  const stopTimer = () => {
    if (timer !== null) timers.clearTimeout(timer)
    timer = null
  }
  const startPreviewTimer = () => {
    stopTimer()
    timer = timers.setTimeout(() => {
      timer = null
      if (state.phase === 'done') set({ ...state, phase: 'idle', preview: '' })
    }, PREVIEW_MS)
  }

  const acknowledge = () => {
    stopTimer()
    set({
      ...state,
      phase: state.phase === 'working' ? 'working' : 'idle',
      preview: '',
      unread: false,
    })
  }

  return {
    getState: () => state,
    runStarted() {
      stopTimer()
      set({ phase: 'working', startedAt: timers.now(), preview: '', unread: false })
    },
    runFinished(result) {
      stopTimer()
      if (result.kind === 'stopped' || panelOpen) {
        set(IDLE_STATE)
        return
      }
      if (result.kind === 'error') {
        set({ phase: 'error', startedAt: 0, preview: '', unread: 'error' })
        return
      }
      set({ phase: 'done', startedAt: 0, preview: previewText(result.text), unread: 'done' })
      if (!hovered) startPreviewTimer()
    },
    setPanelOpen(open) {
      panelOpen = open
      if (open) acknowledge()
    },
    setHovered(next) {
      if (hovered === next) return
      hovered = next
      if (state.phase !== 'done') return
      if (next) stopTimer()
      else startPreviewTimer()
    },
    acknowledge,
    dispose: stopTimer,
  }
}

/** Seconds since the reply started. */
export function elapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000))
}

/**
 * Counter text for a long reply: nothing for the first few seconds, then "12 s" (the
 * caller supplies the localized seconds text) and a plain m:ss clock from one minute.
 */
export function formatElapsed(seconds: number, secondsText: (n: number) => string): string | null {
  if (seconds < ELAPSED_AFTER_S) return null
  if (seconds < 60) return secondsText(seconds)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** What a settled run means for the launcher, from the final assistant message. */
export function finishOf(
  last: { role: string; text: string; error?: string } | undefined,
  stoppedByUser: boolean,
): RunResult {
  if (stoppedByUser || last?.role !== 'assistant') return { kind: 'stopped' }
  if (last.error) return { kind: 'error' }
  return last.text.trim() ? { kind: 'done', text: last.text } : { kind: 'stopped' }
}

/**
 * One plain line from a Markdown answer: formatting dropped, whitespace collapsed,
 * cut at a word boundary (when one is near) and ended with an ellipsis. Counts code
 * points, so emoji and CJK text are never split.
 */
export function previewText(markdown: string, max = PREVIEW_MAX): string {
  const plain = markdown
    .replace(/\r\n?/g, '\n')
    .replace(/```[^\n]*\n?/g, '\n') // fence lines; the code itself still reads as text
    .replace(/<[^>\n]+>/g, ' ') // inline html
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> label
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1') // reference links
    .replace(/^\s{0,3}\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/gm, ' ') // table separators / rules
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, ' ') // horizontal rules
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s{0,3}>\s?/gm, '') // quotes
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '') // list markers
    .replace(/\|/g, ' ') // table cells
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]+(?=\S)|(?<=\S)[*_]+(?=$|[\s).,;:!?])/g, '$1') // emphasis marks
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1') // escapes
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(plain)
  if (chars.length <= max) return plain
  const room = max - 1
  const cut = chars.slice(0, room)
  const space = cut.lastIndexOf(' ')
  const kept = space >= room * 0.6 ? cut.slice(0, space) : cut
  return `${kept.join('').replace(/[\s.,;:!?-]+$/, '')}…`
}
