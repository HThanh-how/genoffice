import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import type { AiSettings } from '@genoffice/ai-provider/browser'
import {
  aiModelPickerGroups,
  aiModelPickerSelection,
  withAiModelSelection,
  type AiModelPickerSelection,
} from './ai-model-picker-options'
import { ProviderLogo } from './provider-logos'
import { useDismissablePopover } from './popover-dismiss'
import { AI_MODEL_PICKER_STRINGS } from './strings-ai-model-picker'

import type { AgyChatApi } from '@genoffice/ai-provider/agy-chat'
import type { AgyBarApi, AgyBarState } from './AgyChatBar'

/** Each app's preload exposes these under its own namespace; the panel adapts them. */
export interface AiModelPickerBridge {
  readonly getSettings: () => Promise<AiSettings>
  readonly setSettings: (settings: AiSettings) => Promise<void>
  /** fires after any renderer (this one, another tab, the shell settings page) saved ai-settings.json */
  readonly onSettingsChanged?: ((handler: () => void) => () => void) | undefined
  readonly gskLoggedIn?: (() => Promise<boolean>) | undefined
  /** shell: switch to Home and open Settings › AI Model */
  readonly openModelSettings?: (() => Promise<void> | void) | undefined
}

/**
 * Composer footer chip showing the active provider + model; the popover lists
 * every usable provider's models for a one-click switch (saved globally, the
 * same ai-settings.json the settings page edits) and ends with a row that
 * opens that page for keys and new vendors.
 */
export function AiModelPicker({
  bridge,
  lang,
}: {
  readonly bridge: AiModelPickerBridge
  readonly lang: Lang
}): React.JSX.Element | null {
  const strings = AI_MODEL_PICKER_STRINGS[lang] ?? AI_MODEL_PICKER_STRINGS.en
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [agyState, setAgyState] = useState<AgyBarState | null>(null)
  const [loggedIn, setLoggedIn] = useState(false)
  const [open, setOpen] = useState(false)
  const [popStyle, setPopStyle] = useState<React.CSSProperties>({})
  const chipRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  // tests render panels without a preload bridge: a throwing getter must not take the panel down
  const refresh = useCallback(() => {
    Promise.resolve()
      .then(() => bridge.getSettings())
      .then(setSettings, () => {})
    Promise.resolve()
      .then(() => bridge.gskLoggedIn?.() ?? false)
      .then(setLoggedIn, () => {})
    const agy =
      typeof window !== 'undefined'
        ? (window as unknown as { agyChat?: AgyBarApi }).agyChat
        : undefined
    if (agy?.getAgyChatState) {
      Promise.resolve()
        .then(() => agy.getAgyChatState())
        .then(setAgyState, () => {})
    }
  }, [bridge])

  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    window.addEventListener('genoffice-agy-model-changed', refresh)
    let off: (() => void) | undefined
    try {
      off = bridge.onSettingsChanged?.(refresh)
    } catch {
      off = undefined
    }
    // a model or enabled-list change made in another window also lands here
    let offAgy: (() => void) | undefined
    try {
      const agy =
        typeof window !== 'undefined'
          ? (window as unknown as { agyChat?: AgyBarApi }).agyChat
          : undefined
      offAgy = agy?.onAgyChatModelChanged?.(refresh)
    } catch {
      offAgy = undefined
    }
    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('genoffice-agy-model-changed', refresh)
      off?.()
      offAgy?.()
    }
  }, [bridge, refresh])

  useEffect(() => {
    if (open)
      popRef.current
        ?.querySelector<HTMLButtonElement>('[aria-selected="true"], [role="option"]')
        ?.focus()
  }, [open])

  const close = useCallback(() => setOpen(false), [])
  useDismissablePopover(open, close, {
    inside: () => [chipRef.current, popRef.current],
  })

  const groups = useMemo(
    () =>
      settings
        ? aiModelPickerGroups(
            settings,
            loggedIn,
            agyState?.models,
            agyState?.catalogError !== undefined,
          )
        : [],
    [settings, loggedIn, agyState?.models, agyState?.catalogError],
  )
  const current = settings ? aiModelPickerSelection(settings, agyState?.selected) : null
  const sameGroup = (g: { id: string; endpoint?: string | undefined }) =>
    g.id === current?.provider && (g.id !== 'custom' || g.endpoint === current?.endpoint)
  const currentUsable = groups.some(sameGroup)

  const toggle = () => {
    if (!open) {
      const rect = chipRef.current?.getBoundingClientRect()
      // the composer sits at the panel bottom: open upwards, pinned to the chip
      if (rect)
        setPopStyle({
          left: Math.max(12, Math.min(rect.left, window.innerWidth - 287)),
          bottom: window.innerHeight - rect.top + 6,
          maxHeight: Math.min(420, Math.max(100, rect.top - 18)),
        })
    }
    setOpen((v) => !v)
  }

  const pick = async (sel: AiModelPickerSelection) => {
    setOpen(false)
    if (!settings) return
    const prev = settings
    const agy =
      typeof window !== 'undefined'
        ? (window as unknown as { agyChat?: AgyChatApi }).agyChat
        : undefined
    // Antigravity models are only ever persisted through the validated Antigravity handler, so
    // the composer chip, the chat box and the CLI agree on one model and a model that is switched
    // off or absent from the catalog can never be written through the generic settings route.
    // The generic write only moves the provider; the model is checked against the enabled list
    // and the live catalog before it is stored.
    // Re-read the settings at the moment of the write so a snapshot taken before another window
    // changed the model is never written back over that newer change.
    let base = settings
    try {
      const fresh = await bridge.getSettings()
      if (fresh) base = fresh
    } catch {
      base = settings
    }
    if (sel.provider === 'agy' && agy?.selectAgyChatModel && agyState) {
      const switched = withAiModelSelection(base, {
        provider: 'agy',
        model: base.providers?.agy?.model ?? '',
      })
      setSettings(switched)
      try {
        await bridge.setSettings(switched)
      } catch {
        setSettings(prev)
        refresh()
        return
      }
      let ok: boolean
      try {
        ok = await agy.selectAgyChatModel(sel.model)
      } catch {
        ok = false
      }
      // A rejected model is not claimed as chosen: the chip re-reads what is really stored.
      refresh()
      if (ok) window.dispatchEvent(new Event('genoffice-agy-model-changed'))
      return
    }
    const next = withAiModelSelection(base, sel)
    setSettings(next)
    try {
      await bridge.setSettings(next)
      refresh()
      window.dispatchEvent(new Event('genoffice-agy-model-changed'))
    } catch {
      setSettings(prev)
      refresh()
    }
  }

  const manage = () => {
    setOpen(false)
    void bridge.openModelSettings?.()
  }

  if (!settings) return null
  const agyModelLabel =
    current?.provider === 'agy'
      ? agyState?.models?.find((m) => m.id === current.model)?.label
      : undefined
  const chipText =
    currentUsable && current
      ? agyModelLabel || current.model || (groups.find(sameGroup)?.label ?? '')
      : strings.choose

  return (
    <div
      className="ai-model-picker"
      onKeyDown={(e) => {
        if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
          const options = Array.from(
            popRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
          )
          if (options.length) {
            const at = options.indexOf(document.activeElement as HTMLButtonElement)
            const next =
              e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? options.length - 1
                  : (at + (e.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length
            options[next]?.focus()
            e.preventDefault()
          }
        }
        if (e.key === 'Escape' && open) {
          e.stopPropagation()
          setOpen(false)
          chipRef.current?.focus()
        }
      }}
    >
      <button
        ref={chipRef}
        type="button"
        className={`ai-model-chip${open ? ' open' : ''}`}
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tip={`${strings.title}: ${chipText}`}
        aria-label={`${strings.title}: ${chipText}`}
      >
        {currentUsable && current && <ProviderLogo id={current.provider} />}
        <span className="ai-model-chip-text">{chipText}</span>
        <svg className="ai-model-chip-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path
            d="M2 6.5 5 3.5l3 3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div
          ref={popRef}
          className="ai-model-pop"
          role="listbox"
          aria-label={strings.title}
          style={popStyle}
        >
          <div className="ai-model-pop-list">
            {groups.map((g) => (
              <div key={g.endpoint ? `${g.id}:${g.endpoint}` : g.id} className="ai-model-group">
                <div className="ai-model-group-head">
                  <ProviderLogo id={g.id} />
                  <span>{g.label}</span>
                </div>
                {[...g.models, ...(g.unusable ?? [])].length > 0 ? (
                  [...g.models, ...(g.unusable ?? [])].map((m) => {
                    const selected = sameGroup(g) && current?.model === m
                    // a stored Antigravity model that is switched off or unconfirmed is shown as
                    // the current configuration, but it cannot be chosen
                    const blocked = (g.unusable ?? []).includes(m)
                    const itemLabel =
                      g.modelItems?.find((item) => item.id === m)?.label || m || g.label
                    return (
                      <button
                        key={`${g.id}:${g.endpoint ?? ''}:${m}`}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        aria-disabled={blocked}
                        disabled={blocked}
                        title={blocked ? `${itemLabel} (${strings.unavailable})` : itemLabel}
                        className={`ai-model-item${selected ? ' selected' : ''}${blocked ? ' unusable' : ''}`}
                        onClick={() => {
                          if (blocked) return
                          void pick({ provider: g.id, endpoint: g.endpoint, model: m })
                        }}
                      >
                        <span className="ai-model-item-text">{itemLabel}</span>
                        {selected && (
                          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                            <path
                              d="M2.5 6.5 5 9l4.5-6"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.6"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </button>
                    )
                  })
                ) : (
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="ai-model-item"
                  >
                    <span className="ai-model-item-text">{g.label}</span>
                  </button>
                )}
              </div>
            ))}
          </div>
          {bridge.openModelSettings && (
            <button type="button" className="ai-model-item ai-model-manage" onClick={manage}>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
              </svg>
              <span className="ai-model-item-text">{strings.manage}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
