import { Markdown, type MarkdownNav } from '@genoffice/ui'
import { FileTypeIcon } from './FileTypeIcon'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HomeChatSource } from '../../../shared/fork/home-chat-types'
import { FILE_LINK_SCHEME, FILE_NOTE_HREF, linkAnswer, plainAnswer, withRefs } from './file-refs'

export type ChatItem = {
  id: number
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  /** transient line shown beside the typing dots until the first token (e.g. "Starting Antigravity…") */
  status?: string
  error?: string
  /** the files the finished answer cites (or, flagged `related`, the retrieved ones) */
  sources?: HomeChatSource[]
  /** every file the model was given an id for in this turn; lets `[[file:N]]` resolve while it streams */
  candidates?: HomeChatSource[]
}

export type ChatLabels = {
  loading: string
  retry: string
  /** BCP-47 tag used to format dates on the file cards */
  locale: string
  filesInAnswer: (count: number) => string
  relatedFiles: (count: number) => string
  open: string
  openSource: (name: string) => string
  showInFolder: string
  copyPath: string
  pathCopied: string
  fileActions: (name: string) => string
  searchDetails: string
  statusOk: string
  nameOnly: string
  sourceMissing: string
  sourceStale: string
  sourceMissingHint: string
  sourceStaleHint: string
  sourceSkeleton: string
  sourceSkeletonHint: string
  copy: string
  copied: string
}

type Props = {
  item: ChatItem
  /** true only for the last assistant answer once nothing is streaming */
  canRetry: boolean
  /** memoized per language by the parent so memo() equality holds across renders */
  labels: ChatLabels
  onOpenSource: (source: HomeChatSource) => void
  onRevealSource: (source: HomeChatSource) => void
  onRetry: () => void
}

/**
 * Re-renders only when its own item (id/text/streaming/error/sources) or the
 * retry flag changes. Handlers are stable refs from the parent, so a streamed
 * token re-renders exactly one ChatMessage and re-parses exactly one Markdown
 * string instead of the whole transcript.
 */
export const ChatMessage = memo(function ChatMessage(props: Props) {
  if (props.item.role === 'user') {
    return (
      <article className="hc-msg user">
        <p>{props.item.text}</p>
      </article>
    )
  }
  return <AssistantMessage {...props} />
})

/** Opens one file: the file chips in the text and the source chips below share these. */
type FileHandlers = {
  labels: ChatLabels
  onOpen: (source: HomeChatSource) => void
  onReveal: (source: HomeChatSource) => void
}

function AssistantMessage({
  item,
  canRetry,
  labels,
  onOpenSource,
  onRevealSource,
  onRetry,
}: Props) {
  const showTyping = item.streaming && !item.text
  // While streaming, ids resolve against every file the model was given; afterwards against the
  // files the answer cites (what is saved), so a reopened chat renders the same way.
  const files = useMemo(
    () => withRefs(item.streaming ? (item.candidates ?? item.sources) : item.sources),
    [item.streaming, item.candidates, item.sources],
  )
  const linked = useMemo(
    () =>
      item.text ? linkAnswer(item.text, files ?? [], { streaming: item.streaming === true }) : null,
    [item.text, files, item.streaming],
  )
  const handlers = useMemo<FileHandlers>(
    () => ({ labels, onOpen: onOpenSource, onReveal: onRevealSource }),
    [labels, onOpenSource, onRevealSource],
  )
  const nav = useMemo<MarkdownNav | undefined>(() => {
    if (!files || files.length === 0) return undefined
    const byRef = new Map<number, HomeChatSource>()
    for (const source of files) if (source.ref !== undefined) byRef.set(source.ref, source)
    return {
      scheme: FILE_LINK_SCHEME,
      onNavigate: () => {},
      // only an id of THIS message's files becomes a chip; anything else the model typed is dropped
      render: (href, label) => {
        if (href === FILE_NOTE_HREF) return <span className="hc-file-note"> {label}</span>
        const source = byRef.get(Number(href.slice(FILE_LINK_SCHEME.length)))
        return source ? <FileChip source={source} {...handlers} /> : null
      },
    }
  }, [files, handlers])
  const plain = useMemo(
    () => (item.streaming || !item.text ? '' : plainAnswer(item.text, files ?? [])),
    [item.text, item.streaming, files],
  )
  const related = !!item.sources?.length && item.sources.every((source) => source.related)
  return (
    <article className="hc-msg assistant" aria-busy={item.streaming ? true : undefined}>
      {showTyping ? (
        <span className="hc-typing" role="status" aria-label={labels.loading}>
          <i />
          <i />
          <i />
          {item.status && <span className="hc-typing-status">{item.status}</span>}
        </span>
      ) : (
        item.text && (
          <div className="hc-answer">
            <Markdown text={linked?.markdown ?? item.text} {...(nav ? { nav } : {})} />
          </div>
        )
      )}
      {item.error && (
        <div className="hc-error" role="alert">
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="7.25" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M10 6v4.5m0 3h.01"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
          <span>{item.error}</span>
          {canRetry && (
            <button type="button" className="hc-error-retry" onClick={onRetry}>
              {labels.retry}
            </button>
          )}
        </div>
      )}
      {!item.streaming && item.sources && item.sources.length > 0 && (
        <FilesPanel sources={item.sources} related={related} {...handlers} />
      )}
      {!item.streaming && item.text && <CopyButton text={plain || item.text} labels={labels} />}
    </article>
  )
}

const stateOf = (source: HomeChatSource): 'missing' | 'stale' | '' =>
  source.missing ? 'missing' : source.stale ? 'stale' : ''

/** A file named in the answer text: click opens it, the small button opens the actions menu. */
function FileChip({ source, labels, onOpen, onReveal }: { source: HomeChatSource } & FileHandlers) {
  const state = stateOf(source)
  const title = [source.name, source.path].filter(Boolean).join(' · ')
  return (
    <span className={`hc-file${state ? ` ${state}` : ''}`}>
      <button
        type="button"
        className="hc-file-open"
        disabled={source.missing === true}
        onClick={() => onOpen(source)}
        aria-label={labels.openSource(source.name)}
        title={title}
      >
        <FileTypeIcon name={source.name} size={18} />
        <span className="hc-file-name">{source.name}</span>
      </button>
      <FileMenu source={source} labels={labels} onOpen={onOpen} onReveal={onReveal} />
    </span>
  )
}

/** Writes text to the clipboard, with the old textarea route when the async API is refused. */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
}

/** The "…" button of a file and its menu: open, show in folder, copy path. */
function FileMenu({ source, labels, onOpen, onReveal }: { source: HomeChatSource } & FileHandlers) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [placement, setPlacement] = useState<{ up: boolean; right: boolean }>({
    up: false,
    right: false,
  })
  const rootRef = useRef<HTMLSpanElement>(null)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation() // the panel's own Escape would minimize the whole chat
        setOpen(false)
        rootRef.current?.querySelector<HTMLButtonElement>('.hc-file-more')?.focus()
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const items = [
          ...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
        ].filter((item) => !item.disabled)
        if (items.length === 0) return
        event.preventDefault()
        const at = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'ArrowDown' ? at + 1 : at - 1
        items[(next + items.length) % items.length]?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  const toggle = () => {
    if (!open) {
      // open towards the side that has room inside the scrolling thread
      const button = rootRef.current?.querySelector('.hc-file-more')?.getBoundingClientRect()
      const bounds = rootRef.current?.closest('.hc-scroll')?.getBoundingClientRect()
      if (button && bounds) {
        setPlacement({
          up: bounds.bottom - button.bottom < 150 && button.top - bounds.top > 150,
          right: bounds.right - button.left < 220,
        })
      }
    }
    setOpen((previous) => !previous)
  }

  useEffect(() => {
    if (open) rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [open])

  const missing = source.missing === true
  const copyPath = async () => {
    if (!source.path) return
    await copyToClipboard(source.path)
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      setCopied(false)
      setOpen(false)
    }, 900)
  }
  return (
    <span className="hc-file-menu-root" ref={rootRef}>
      <button
        type="button"
        className="hc-file-more"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={labels.fileActions(source.name)}
        title={labels.fileActions(source.name)}
        onClick={toggle}
      >
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <circle cx="4.5" cy="10" r="1.5" />
          <circle cx="10" cy="10" r="1.5" />
          <circle cx="15.5" cy="10" r="1.5" />
        </svg>
      </button>
      {open && (
        <div
          className={`hc-file-menu${placement.up ? ' up' : ''}${placement.right ? ' right' : ''}`}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            disabled={missing}
            onClick={() => {
              setOpen(false)
              onOpen(source)
            }}
          >
            {labels.open}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={missing}
            onClick={() => {
              setOpen(false)
              onReveal(source)
            }}
          >
            {labels.showInFolder}
          </button>
          {source.path && (
            <button type="button" role="menuitem" onClick={() => void copyPath()}>
              {copied ? labels.pathCopied : labels.copyPath}
            </button>
          )}
        </div>
      )}
    </span>
  )
}

const folderOf = (path: string | undefined): string =>
  path ? path.replace(/[\\/][^\\/]*$/, '') : ''

function formatDate(ms: number | undefined, locale: string): string {
  if (!ms) return ''
  try {
    return new Date(ms).toLocaleDateString(locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return new Date(ms).toLocaleDateString()
  }
}

/** The files an answer relies on, as compact cards, with the index details folded away. */
function FilesPanel({
  sources,
  related,
  labels,
  onOpen,
  onReveal,
}: { sources: HomeChatSource[]; related: boolean } & FileHandlers) {
  const title = related ? labels.relatedFiles(sources.length) : labels.filesInAnswer(sources.length)
  return (
    <section className="hc-files" aria-label={title}>
      <h4 className="hc-files-title">{title}</h4>
      <div className="hc-cards">
        {sources.map((source) => (
          <FileCard
            key={source.ref ?? (source.documentId || source.path)}
            source={source}
            labels={labels}
            onOpen={onOpen}
            onReveal={onReveal}
          />
        ))}
      </div>
      <details className="hc-details">
        <summary>{labels.searchDetails}</summary>
        <ul>
          {sources.map((source) => {
            const status = source.missing
              ? labels.sourceMissing
              : source.stale
                ? labels.sourceStale
                : source.skeletonIndex
                  ? labels.sourceSkeleton
                  : source.documentId === 0
                    ? labels.nameOnly
                    : labels.statusOk
            const where = source.location && source.location !== source.path ? source.location : ''
            return (
              <li key={source.ref ?? (source.documentId || source.path)}>
                <span className="hc-details-name">{source.name}</span>
                {[where, status].filter(Boolean).join(' · ')}
              </li>
            )
          })}
        </ul>
      </details>
    </section>
  )
}

function FileCard({ source, labels, onOpen, onReveal }: { source: HomeChatSource } & FileHandlers) {
  const state = stateOf(source)
  const skeleton = !state && source.skeletonIndex === true
  const hint = source.missing
    ? labels.sourceMissingHint
    : source.stale
      ? labels.sourceStaleHint
      : skeleton
        ? labels.sourceSkeletonHint
        : ''
  const folder = folderOf(source.path)
  const date = formatDate(source.modifiedAt, labels.locale)
  return (
    <div
      className={`hc-card hc-source${state ? ` ${state}` : ''}`}
      title={[source.name, source.path, hint].filter(Boolean).join(' · ')}
    >
      <FileTypeIcon name={source.name} size={36} />
      <div className="hc-card-text">
        <span className="hc-card-name">{source.name}</span>
        {folder && <span className="hc-card-meta">{folder}</span>}
        {date && <span className="hc-card-meta">{date}</span>}
        {(state || skeleton) && (
          <span className="hc-source-flag">
            {state === 'missing'
              ? labels.sourceMissing
              : state === 'stale'
                ? labels.sourceStale
                : labels.sourceSkeleton}
          </span>
        )}
      </div>
      <button
        type="button"
        className="hc-card-open"
        disabled={source.missing === true}
        onClick={() => onOpen(source)}
        aria-label={labels.openSource(source.name)}
      >
        {labels.open}
      </button>
      <FileMenu source={source} labels={labels} onOpen={onOpen} onReveal={onReveal} />
    </div>
  )
}

function CopyButton({ text, labels }: { text: string; labels: ChatLabels }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = useCallback(async () => {
    await copyToClipboard(text)
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1600)
  }, [text])
  return (
    <div className="hc-msg-actions">
      <button type="button" className="hc-text-button" onClick={() => void copy()}>
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
          {copied ? (
            <path
              d="m4.5 10.5 3.5 3.5 7.5-8"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : (
            <>
              <rect
                x="7"
                y="7"
                width="9"
                height="9.5"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </>
          )}
        </svg>
        <span aria-live="polite">{copied ? labels.copied : labels.copy}</span>
      </button>
    </div>
  )
}
