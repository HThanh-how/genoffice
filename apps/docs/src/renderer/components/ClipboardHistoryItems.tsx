import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { clipboardHistoryLabels } from '@genoffice/electron-utils/clipboard-history-labels'
import type { ClipboardHistoryEntry } from '../../shared/ipc'
import { pasteFromClipboard } from '../editor/paste-actions'

interface Props {
  editor: Editor
  lang: string
  /** 'ctx' for the right-click submenu, 'ribbon' for the Paste dropdown */
  variant: 'ctx' | 'ribbon'
  /** wraps a click: the menu around closes itself, then the action runs */
  wrap: (action: () => void) => () => void
  /** show at most this many entries */
  limit?: number
}

/**
 * What was copied lately, to paste from: text goes in as typed, an image goes through the system
 * clipboard first. Shared by the right-click menu and the ribbon's Paste dropdown so both offer
 * exactly the same list.
 */
export function ClipboardHistoryItems({ editor, lang, variant, wrap, limit }: Props) {
  const labels = clipboardHistoryLabels(lang)
  const [state, setState] = useState<{
    enabled: boolean
    items: ClipboardHistoryEntry[]
  } | null>(null)
  useEffect(() => {
    let alive = true
    void Promise.all([
      window.desktop.getClipboardHistoryEnabled?.() ?? Promise.resolve(false),
      window.desktop.getClipboardHistory?.() ?? Promise.resolve([]),
    ])
      .then(([enabled, items]) => {
        if (alive) setState({ enabled, items })
      })
      .catch(() => {
        if (alive) setState({ enabled: false, items: [] })
      })
    return () => {
      alive = false
    }
  }, [])

  const ctx = variant === 'ctx'
  const item = ctx ? 'ctx-item' : 'paste-history-item'
  const label = ctx ? 'ctx-label' : undefined
  const notice = (text: string) => (
    <button className={item} role={ctx ? undefined : 'menuitem'} disabled>
      <span className={label}>{text}</span>
    </button>
  )

  if (!state) return null
  if (!state.enabled) return notice(labels.pasteMoreDisabled)
  if (state.items.length === 0) return notice(labels.pasteMoreEmpty)

  return (
    <>
      {state.items.slice(0, limit ?? state.items.length).map((entry) => {
        if (entry.kind === 'image') {
          const size = entry.width && entry.height ? `${entry.width}×${entry.height}` : ''
          return (
            <button
              key={entry.id}
              className={`${item} ${ctx ? 'ctx-history-image' : 'paste-history-image'}`}
              role={ctx ? undefined : 'menuitem'}
              title={size}
              onClick={wrap(() => {
                editor.view.focus()
                void window.desktop.restoreClipboardHistoryImage?.(entry.id).then((ok) => {
                  if (ok) void pasteFromClipboard(editor)
                })
              })}
            >
              <img src={entry.preview} alt={size} />
              {size && (
                <span className={ctx ? 'ctx-label ctx-history-size' : undefined}>{size}</span>
              )}
            </button>
          )
        }
        const preview = entry.text.replace(/\s+/g, ' ').trim()
        const text = entry.sensitive
          ? '••••••••••'
          : preview.length > 64
            ? `${preview.slice(0, 64)}…`
            : preview
        return (
          <button
            key={entry.id}
            className={item}
            role={ctx ? undefined : 'menuitem'}
            title={entry.sensitive ? labels.sensitiveHint : preview}
            onClick={wrap(() => {
              editor.view.focus()
              editor.view.pasteText(entry.text)
            })}
          >
            <span className={label}>{text || '(empty)'}</span>
          </button>
        )
      })}
    </>
  )
}
