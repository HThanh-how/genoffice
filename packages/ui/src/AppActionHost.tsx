import { useEffect, useRef, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import type {
  AppActionBridge,
  AppActionRegistry,
  AppActionResult,
  AppActionStep,
} from '@genoffice/agent-core/app-control'
import { clarifyText, type ClarifyKey } from './strings-clarify'
import {
  AppActionSequence,
  spotlightRect,
  waitForActionStep,
  type SpotlightRect,
} from './app-action-steps'
import './app-action.css'

export const APP_ACTION_COMPLETED = 'genoffice:app-action-completed'
const activeSignals = new Map<string, AbortSignal>()
/** Lets an existing user-click handler join the guide's cancellation lifetime. */
export function appActionSignal(id: string): AbortSignal | undefined {
  return activeSignals.get(id)
}
export function reportAppAction(id: string, result: AppActionResult): void {
  window.dispatchEvent(new CustomEvent(APP_ACTION_COMPLETED, { detail: { id, result } }))
}
export function appActionBridge(): AppActionBridge | undefined {
  return (window as unknown as { appActions?: AppActionBridge }).appActions
}

function paintNarration(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let frame = 0
    const finish = () => {
      cancelAnimationFrame(frame)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
    else
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(finish)
      })
  })
}

function observeCompletion(id: string, signal: AbortSignal): Promise<AppActionResult> {
  return new Promise((resolve) => {
    const finish = (result: AppActionResult) => {
      window.removeEventListener(APP_ACTION_COMPLETED, listener)
      signal.removeEventListener('abort', cancel)
      resolve(result)
    }
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; result: AppActionResult }>).detail
      if (detail.id === id) finish(detail.result)
    }
    const cancel = () => finish({ status: 'cancelled' })
    window.addEventListener(APP_ACTION_COMPLETED, listener)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
}

export function AppActionHost({
  registry,
  lang,
  contextKey,
}: {
  registry: AppActionRegistry
  lang: Lang
  contextKey?: unknown
}) {
  const [guide, setGuide] = useState<{ step: AppActionStep; index: number; total: number } | null>(
    null,
  )
  const epoch = useRef(0)
  useEffect(() => {
    const generation = ++epoch.current
    const current = () => epoch.current === generation
    setGuide(null)
    const bridge = appActionBridge()
    if (!bridge) return
    let active: { id: string; controller: AbortController } | null = null
    const cancel = bridge.onCancel((id) => {
      if (active?.id === id) active.controller.abort()
    })
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') active?.controller.abort()
    }
    window.addEventListener('keydown', escape, true)
    const unregister = bridge.onRequest(registry.ids(), async (request) => {
      if (active) return { status: 'error', error: 'Renderer command already running' }
      const controller = new AbortController()
      active = { id: request.requestId, controller }
      const { signal } = controller
      const actionId = request.input.kind === 'app_action' ? request.input.id : request.input.kind
      activeSignals.set(actionId, signal)
      signal.addEventListener(
        'abort',
        () => {
          if (activeSignals.get(actionId) === signal) activeSignals.delete(actionId)
          if (current()) setGuide(null)
        },
        { once: true },
      )
      try {
        const input = request.input
        const command = registry.get(input.kind === 'app_action' ? input.id : input.kind)
        const steps = command.resolveSteps?.(input) ?? command.steps
        if (input.kind === 'app_action' && input.teach) {
          if (!command.teach) throw new Error('Teaching is unavailable for this command')
          // Subscribe before the click: export can complete while the next step mounts.
          const completion = observeCompletion(command.id, signal)
          const sequence = new AppActionSequence(steps)
          for (const [index, step] of steps.entries()) {
            setGuide({ step, index, total: steps.length })
            if (step.event === 'handoff') break
            await waitForActionStep(step, signal)
            sequence.observe(index, step.event)
          }
          return sequence.done ? { status: 'completed' } : await completion
        }
        if (steps.length) {
          setGuide({ step: steps[0]!, index: 0, total: steps.length })
          // Let React paint narration before invoking a dialog. No teach step advances here.
          await paintNarration(signal)
        }
        if (signal.aborted) return { status: 'cancelled' }
        const last = steps.at(-1)
        if (last?.event === 'handoff')
          setGuide({ step: last, index: steps.length - 1, total: steps.length })
        const result = await command.run(input, signal)
        return signal.aborted ? { status: 'cancelled' } : result
      } catch (error) {
        return signal.aborted ? { status: 'cancelled' } : { status: 'error', error: String(error) }
      } finally {
        controller.abort()
        if (activeSignals.get(actionId) === signal) activeSignals.delete(actionId)
        active = null
        if (current()) setGuide(null)
      }
    })
    return () => {
      ++epoch.current
      active?.controller.abort()
      unregister()
      cancel()
      window.removeEventListener('keydown', escape, true)
    }
  }, [registry, contextKey])
  return guide ? <AppActionSpotlight {...guide} lang={lang} /> : null
}

function AppActionSpotlight({
  step,
  index,
  total,
  lang,
}: {
  step: AppActionStep
  index: number
  total: number
  lang: Lang
}) {
  const [rect, setRect] = useState<SpotlightRect | null>(null)
  const frame = useRef(0)
  useEffect(() => {
    const measure = () => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(() => {
        const element = step.selector ? document.querySelector(step.selector) : null
        setRect(
          element
            ? spotlightRect(element.getBoundingClientRect(), window.innerWidth, window.innerHeight)
            : null,
        )
      })
    }
    const observer = new MutationObserver(measure)
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    })
    const resize = new ResizeObserver(measure)
    resize.observe(document.documentElement)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    measure()
    return () => {
      cancelAnimationFrame(frame.current)
      observer.disconnect()
      resize.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [step])
  return (
    <div className="app-action-guide">
      {rect && (
        <svg className="app-action-spotlight" width="100%" height="100%" aria-hidden="true">
          <path
            fillRule="evenodd"
            d={`M0 0H${window.innerWidth}V${window.innerHeight}H0Z M${rect.x} ${rect.y}h${rect.width}v${rect.height}h${-rect.width}Z`}
            className="app-action-shade"
          />
          <rect {...rect} rx="6" className="app-action-outline" />
        </svg>
      )}
      <div className="app-action-narration" role="status" aria-live="polite">
        {clarifyText(lang, 'aiActionStep', {
          step: index + 1,
          total,
          text: clarifyText(lang, step.label as ClarifyKey),
        })}
      </div>
    </div>
  )
}
