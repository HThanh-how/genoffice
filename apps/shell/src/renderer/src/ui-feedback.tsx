import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from './locale'
import './ui-feedback.css'
import type { MessageBoxRequest, MessageBoxResult } from '../../shared/feedback-api'

export type FeedbackTone = 'info' | 'success' | 'warning' | 'error' | 'danger'
export type FeedbackOptions = {
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: FeedbackTone
}

type DialogRequest = {
  id: number
  message: string
  kind: 'confirm' | 'alert' | 'messagebox'
  options: FeedbackOptions
  box?: MessageBoxRequest
  resolve: (result: MessageBoxResult) => void
}
type Toast = { id: number; message: string; tone: FeedbackTone }
type FeedbackState = { dialogs: DialogRequest[]; toasts: Toast[] }

let nextId = 0
let state: FeedbackState = { dialogs: [], toasts: [] }
const listeners = new Set<() => void>()
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const snapshot = () => state
function publish(next: FeedbackState) {
  state = next
  listeners.forEach((listener) => listener())
}

/** Queued confirmations always require an explicit affirmative action. */
export function appConfirm(message: string, options: FeedbackOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    publish({
      ...state,
      dialogs: [
        ...state.dialogs,
        {
          id: ++nextId,
          message,
          kind: 'confirm',
          options,
          resolve: (result) => resolve(result.response === 1),
        },
      ],
    })
  })
}

/** Native message-box button indices and checkbox state are preserved. */
export function appMessageBox(box: MessageBoxRequest): Promise<MessageBoxResult> {
  return new Promise((resolve) => {
    publish({
      ...state,
      dialogs: [
        ...state.dialogs,
        {
          id: ++nextId,
          message: box.message,
          kind: 'messagebox',
          box,
          options: {
            title: box.title,
            tone: box.type === 'error' ? 'error' : box.type === 'warning' ? 'warning' : 'info',
          },
          resolve,
        },
      ],
    })
  })
}

/** An acknowledgment dialog for information that should remain until read. */
export function appAlert(message: string, options: FeedbackOptions = {}): Promise<void> {
  return new Promise((resolve) => {
    publish({
      ...state,
      dialogs: [
        ...state.dialogs,
        { id: ++nextId, message, kind: 'alert', options, resolve: () => resolve() },
      ],
    })
  })
}

function dismissToast(id: number) {
  clearTimeout(toastTimers.get(id))
  toastTimers.delete(id)
  publish({ ...state, toasts: state.toasts.filter((toast) => toast.id !== id) })
}

/** Nonblocking notices expire after six seconds and can be dismissed sooner. */
export function appNotify(message: string, tone: FeedbackTone = 'info'): void {
  const bridge = (
    window as Window & {
      appFeedbackShell?: { notify(message: string, tone: FeedbackTone): Promise<void> }
    }
  ).appFeedbackShell
  if (bridge) {
    void bridge.notify(message, tone).catch(() => localNotify(message, tone))
    return
  }
  localNotify(message, tone)
}

function localNotify(message: string, tone: FeedbackTone): void {
  const toast = { id: ++nextId, message, tone }
  if (state.toasts.length >= 4) dismissToast(state.toasts[0].id)
  publish({ ...state, toasts: [...state.toasts, toast] })
  toastTimers.set(
    toast.id,
    setTimeout(() => dismissToast(toast.id), 6000),
  )
}

function settleDialog(id: number, response: number, checkboxChecked = false) {
  const request = state.dialogs[0]
  if (request?.id !== id) return
  publish({ ...state, dialogs: state.dialogs.slice(1) })
  request.resolve({ response, checkboxChecked })
}

function cancelIndex(request: DialogRequest): number {
  if (request.kind !== 'messagebox') return 0
  const buttons = request.box?.buttons ?? []
  const explicit = request.box?.cancelId
  if (explicit !== undefined && explicit >= 0 && explicit < Math.max(1, buttons.length))
    return explicit
  const labeled = buttons.findIndex((label) =>
    /^(cancel|hủy|取消|no|không|否)$/i.test(label.replaceAll('&', '').trim()),
  )
  return labeled >= 0 ? labeled : Math.max(0, buttons.length - 1)
}

const COPY = {
  en: {
    confirm: 'Confirm',
    cancel: 'Cancel',
    okay: 'OK',
    title: 'GenOffice',
    confirmTitle: 'Please confirm',
    close: 'Dismiss notification',
  },
  vi: {
    confirm: 'Xác nhận',
    cancel: 'Hủy',
    okay: 'Đã hiểu',
    title: 'GenOffice',
    confirmTitle: 'Vui lòng xác nhận',
    close: 'Đóng thông báo',
  },
  zh: {
    confirm: '确认',
    cancel: '取消',
    okay: '知道了',
    title: 'GenOffice',
    confirmTitle: '请确认',
    close: '关闭通知',
  },
}

function FeedbackIcon({ tone }: { tone: FeedbackTone }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      {tone === 'success' ? (
        <path
          d="m7.5 12 3 3 6-6"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M12 7.5v5m0 3.5h.01"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      )}
    </svg>
  )
}

/** Mount once below LocaleProvider. Helpers can be called from any renderer module. */
export function UiFeedbackHost() {
  const { lang } = useI18n()
  const words = COPY[lang as keyof typeof COPY] ?? COPY.en
  const feedback = useSyncExternalStore(subscribe, snapshot, snapshot)
  const request = feedback.dialogs[0]
  const rootRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const initialFocusRef = useRef<HTMLButtonElement>(null)
  const checkboxRef = useRef<HTMLInputElement>(null)
  const buttons =
    request?.kind === 'messagebox'
      ? request.box?.buttons?.length
        ? request.box.buttons
        : [words.okay]
      : request?.kind === 'confirm'
        ? [
            request.options.cancelLabel ?? words.cancel,
            request.options.confirmLabel ?? words.confirm,
          ]
        : [request?.options.confirmLabel ?? words.okay]
  const cancelId = request ? cancelIndex(request) : 0
  const defaultId =
    request?.kind === 'messagebox'
      ? Math.max(0, Math.min(buttons.length - 1, request.box?.defaultId ?? 0))
      : request?.kind === 'confirm'
        ? 1
        : 0
  const focusId =
    request?.kind === 'messagebox' && request.box?.cancelId === undefined ? defaultId : cancelId

  useEffect(() => {
    if (!request) return
    const root = rootRef.current
    const dialog = dialogRef.current
    if (!root || !dialog) return
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const siblings = Array.from(document.body.children).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== root,
    )
    const previousInert = siblings.map((element) => ({ element, inert: element.inert }))
    siblings.forEach((element) => {
      element.inert = true
    })
    const focusInitial = () => (initialFocusRef.current ?? dialog).focus()
    focusInitial()
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) focusInitial()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault()
        event.stopPropagation()
        settleDialog(
          request.id,
          cancelIndex(request),
          checkboxRef.current?.checked ?? request.box?.checkboxChecked ?? false,
        )
      } else if (event.key === 'Tab') {
        const buttons = Array.from(
          dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'),
        )
        const first = buttons[0]
        const last = buttons.at(-1)
        if (
          event.shiftKey &&
          (document.activeElement === first || !dialog.contains(document.activeElement))
        ) {
          event.preventDefault()
          last?.focus()
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !dialog.contains(document.activeElement))
        ) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocus, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', onFocus, true)
      previousInert.forEach(({ element, inert }) => {
        element.inert = inert
      })
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [request])

  return createPortal(
    <div className="ui-feedback-root" ref={rootRef}>
      {request && (
        <div
          className="ui-feedback-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && request.kind === 'confirm')
              settleDialog(request.id, 0)
          }}
        >
          <div
            ref={dialogRef}
            className={`ui-feedback-dialog tone-${request.options.tone ?? 'info'}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ui-feedback-title"
            aria-describedby={
              request.box?.detail ? 'ui-feedback-message ui-feedback-detail' : 'ui-feedback-message'
            }
            tabIndex={-1}
          >
            <div className="ui-feedback-dialog-heading">
              <span className="ui-feedback-icon">
                <FeedbackIcon tone={request.options.tone ?? 'info'} />
              </span>
              <h2 id="ui-feedback-title">
                {request.options.title ??
                  (request.kind === 'confirm' ? words.confirmTitle : words.title)}
              </h2>
            </div>
            <p className="ui-feedback-message" id="ui-feedback-message">
              {request.message}
            </p>
            {request.box?.detail && (
              <p className="ui-feedback-detail" id="ui-feedback-detail">
                {request.box.detail}
              </p>
            )}
            {request.box?.checkboxLabel && (
              <label className="ui-feedback-checkbox">
                <input
                  key={request.id}
                  ref={checkboxRef}
                  type="checkbox"
                  defaultChecked={request.box.checkboxChecked ?? false}
                />
                <span>{request.box.checkboxLabel}</span>
              </label>
            )}
            <div className="ui-feedback-actions">
              {buttons.map((label, index) => (
                <button
                  key={index}
                  ref={index === focusId ? initialFocusRef : undefined}
                  type="button"
                  className={`ui-feedback-button${index === defaultId ? ' primary' : ''}`}
                  onClick={() =>
                    settleDialog(
                      request.id,
                      index,
                      checkboxRef.current?.checked ?? request.box?.checkboxChecked ?? false,
                    )
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <div
        className="ui-feedback-toasts"
        aria-live="polite"
        aria-relevant="additions"
        aria-atomic="false"
      >
        {feedback.toasts.map((toast) => (
          <div className={`ui-feedback-toast tone-${toast.tone}`} key={toast.id}>
            <span className="ui-feedback-icon">
              <FeedbackIcon tone={toast.tone} />
            </span>
            <p>{toast.message}</p>
            <button
              type="button"
              className="ui-feedback-dismiss"
              aria-label={words.close}
              onClick={() => dismissToast(toast.id)}
            >
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path
                  d="m5.5 5.5 9 9m0-9-9 9"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  )
}
