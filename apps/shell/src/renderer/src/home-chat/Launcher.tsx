import { useEffect, useState, type RefObject } from 'react'
import {
  elapsedSeconds,
  formatElapsed,
  type LauncherPhase,
  type LauncherState,
} from './launcher-status'

export type LauncherLabels = {
  launch: string
  close: string
  invite: string
  working: string
  done: string
  error: string
  stop: string
  elapsed: (n: number) => string
}

type Props = {
  state: LauncherState
  /** the panel is expanded: the launcher shows its plain look */
  open: boolean
  invitation: boolean
  /** transient pre-answer line ("Starting Antigravity…"), empty once tokens arrive */
  starting: string
  labels: LauncherLabels
  buttonRef: RefObject<HTMLButtonElement | null>
  onToggle: () => void
  onStop: () => void
  onInvitation: (visible: boolean) => void
  /** pointer over / focus within the launcher: keeps a finished preview on screen */
  onHold: (held: boolean) => void
}

const Sparkle = () => (
  <svg viewBox="0 0 20 20" fill="none">
    <path
      d="M10 2.5 11.8 8.2 17.5 10l-5.7 1.8L10 17.5l-1.8-5.7L2.5 10l5.7-1.8L10 2.5Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
)

const Check = () => (
  <svg viewBox="0 0 20 20" fill="none">
    <circle cx="10" cy="10" r="7.25" stroke="currentColor" strokeWidth="1.5" />
    <path
      d="m6.9 10.2 2.2 2.2 4-4.4"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

/** Whole seconds of the running reply, ticking once a second only while it is shown. */
function useElapsed(startedAt: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [active])
  return elapsedSeconds(startedAt, now)
}

/**
 * The floating launcher. Expanded panel or idle: the "Ask AI" pill. Minimized with a
 * reply running or finished it becomes a compact status chip so the user can tell what
 * the assistant is doing without reopening it.
 */
export function Launcher({
  state,
  open,
  starting,
  labels,
  buttonRef,
  onToggle,
  onStop,
  onInvitation,
  onHold,
}: Props) {
  const phase: LauncherPhase = open ? 'idle' : state.phase
  const seconds = useElapsed(state.startedAt, phase === 'working')
  const elapsed = phase === 'working' ? formatElapsed(seconds, labels.elapsed) : null
  const unread = !open && state.unread

  const working = starting || labels.working
  const doneText = labels.done
  const text =
    phase === 'working'
      ? working
      : phase === 'done'
        ? doneText
        : phase === 'error'
          ? labels.error
          : labels.launch
  // Elapsed time is left out on purpose: a live region that changes every second is noise.
  const announce = open
    ? ''
    : phase === 'working'
      ? working
      : phase === 'done'
        ? labels.done
        : phase === 'error'
          ? labels.error
          : ''

  return (
    <div
      className={`hc-dock is-${phase}${open ? ' panel-open' : ''}`}
      onMouseEnter={() => {
        onInvitation(true)
        onHold(true)
      }}
      onMouseLeave={() => {
        onInvitation(false)
        onHold(false)
      }}
      onFocus={() => {
        onInvitation(true)
        onHold(true)
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return
        onInvitation(false)
        onHold(false)
      }}
    >
      <button
        type="button"
        ref={buttonRef}
        className="home-chat-launcher"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={
          open ? labels.close : phase === 'idle' ? labels.launch : `${labels.launch}: ${announce}`
        }
        title={phase === 'done' ? doneText : undefined}
        onClick={onToggle}
      >
        <span className="home-chat-launch-icon" aria-hidden="true">
          {phase === 'working' ? (
            <span className="hc-dock-dots">
              <i />
              <i />
              <i />
            </span>
          ) : phase === 'done' ? (
            <span className="hc-dock-check">
              <Check />
            </span>
          ) : phase === 'error' ? (
            <span className="hc-dock-alert" />
          ) : (
            <Sparkle />
          )}
        </span>
        <span key={phase} className="home-chat-launch-label hc-dock-text" aria-hidden="true">
          <span className="hc-dock-line">{text}</span>
          {elapsed && <span className="hc-dock-elapsed">{elapsed}</span>}
        </span>
      </button>
      {phase === 'working' && (
        <button type="button" className="hc-dock-stop" onClick={onStop}>
          <span className="hc-dock-stop-glyph" aria-hidden="true" />
          {labels.stop}
        </button>
      )}
      {unread && <span className={`hc-unread ${unread}`} aria-hidden="true" />}
      <span className="home-chat-sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </div>
  )
}
