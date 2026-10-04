import { join } from 'node:path'
import { BrowserWindow, ipcMain, nativeTheme, screen } from 'electron'
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { getUiLang } from '@genoffice/i18n'
import { FEEDBACK_CHANNELS } from '../shared/feedback-api'
import type { FeedbackWindowState, MessageBoxResult } from '../shared/feedback-api'

const pending = new Map<
  number,
  { state: FeedbackWindowState; finish(result: MessageBoxResult): void }
>()
let registered = false
let queue: Promise<unknown> = Promise.resolve()
let toastWindow: BrowserWindow | null = null
let themeGetter: () => 'light' | 'dark' | 'system' = () => 'system'
export function setFeedbackThemeGetter(getter: typeof themeGetter): void {
  themeGetter = getter
}

function register(): void {
  if (registered) return
  registered = true
  ipcMain.handle(FEEDBACK_CHANNELS.hitRegion, (event, rect: unknown) => {
    const entry = pending.get(event.sender.id)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (
      !entry?.state.toastTone ||
      !win ||
      process.platform === 'darwin' ||
      !rect ||
      typeof rect !== 'object'
    )
      return
    const r = rect as Record<string, unknown>
    if (
      ![r.x, r.y, r.width, r.height].every(
        (value) => typeof value === 'number' && Number.isFinite(value),
      )
    )
      return
    const { width, height } = win.getBounds()
    if (
      (r.x as number) < 0 ||
      (r.y as number) < 0 ||
      (r.width as number) <= 0 ||
      (r.height as number) <= 0 ||
      (r.x as number) + (r.width as number) > width ||
      (r.y as number) + (r.height as number) > height
    )
      return
    try {
      win.setShape([
        {
          x: Math.floor(r.x as number),
          y: Math.floor(r.y as number),
          width: Math.ceil(r.width as number),
          height: Math.ceil(r.height as number),
        },
      ])
    } catch {
      /* Some window managers do not support shaped windows. */
    }
  })
  ipcMain.handle(FEEDBACK_CHANNELS.notify, (event, message: unknown, tone: unknown) => {
    const host = BrowserWindow.fromWebContents(event.sender)
    if (
      !host ||
      typeof message !== 'string' ||
      message.length > 20000 ||
      !['info', 'success', 'warning', 'error', 'danger'].includes(String(tone))
    )
      return
    if (toastWindow && !toastWindow.isDestroyed()) toastWindow.destroy()
    void openBox(host, { message }, tone as FeedbackWindowState['toastTone'])
  })
  ipcMain.handle(FEEDBACK_CHANNELS.state, (event) => pending.get(event.sender.id)?.state ?? null)
  ipcMain.handle(FEEDBACK_CHANNELS.respond, (event, result: unknown) => {
    const entry = pending.get(event.sender.id)
    if (!entry || !result || typeof result !== 'object') return
    const value = result as Partial<MessageBoxResult>
    if (
      !Number.isInteger(value.response) ||
      value.response! < 0 ||
      value.response! >= (entry.state.request.buttons?.length ?? 1) ||
      typeof value.checkboxChecked !== 'boolean'
    )
      return
    entry.finish({ response: value.response!, checkboxChecked: value.checkboxChecked })
  })
}

export function showAppMessageBox(
  parentOrOptions: BrowserWindow | null | undefined | MessageBoxOptions,
  supplied?: MessageBoxOptions,
): Promise<MessageBoxReturnValue> {
  const parent = supplied
    ? ((parentOrOptions as BrowserWindow | null | undefined) ?? BrowserWindow.getFocusedWindow())
    : BrowserWindow.getFocusedWindow()
  const options = supplied ?? (parentOrOptions as MessageBoxOptions)
  const task = queue.then(() => openBox(parent, options))
  queue = task.catch(() => undefined)
  return task
}

function openBox(
  parent: BrowserWindow | null,
  options: MessageBoxOptions,
  toastTone?: FeedbackWindowState['toastTone'],
): Promise<MessageBoxReturnValue> {
  register()
  const buttons = options.buttons?.length ? options.buttons : ['OK']
  const cancel =
    options.cancelId !== undefined && options.cancelId >= 0 && options.cancelId < buttons.length
      ? options.cancelId
      : buttons.length - 1
  const fallback = { response: cancel, checkboxChecked: options.checkboxChecked ?? false }
  if (parent?.isDestroyed()) return Promise.resolve(fallback)
  const host = parent && !parent.isDestroyed() ? parent : null
  const area = (host ? screen.getDisplayMatching(host.getBounds()) : screen.getPrimaryDisplay())
    .workArea
  const win = new BrowserWindow({
    width: Math.min(toastTone ? 460 : 560, Math.max(280, area.width - 32)),
    height: Math.min(toastTone ? 220 : 480, Math.max(200, area.height - 48)),
    ...(host ? { parent: host, modal: !toastTone } : {}),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: options.title ?? 'GenOffice',
    webPreferences: {
      preload: join(__dirname, '../preload/feedback.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (toastTone) {
    toastWindow = win
    const bounds = host?.getBounds() ?? area
    const size = win.getBounds()
    win.setPosition(
      Math.max(
        area.x,
        Math.min(bounds.x + bounds.width - size.width - 12, area.x + area.width - size.width),
      ),
      Math.max(
        area.y,
        Math.min(bounds.y + bounds.height - size.height - 12, area.y + area.height - size.height),
      ),
    )
    win.setFocusable(false)
  }
  const theme = themeGetter()
  const state: FeedbackWindowState = {
    lang: getUiLang(),
    toastTone,
    theme: theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : theme,
    request: {
      message: options.message,
      title: options.title,
      detail: options.detail,
      buttons,
      defaultId: options.defaultId,
      cancelId: cancel,
      checkboxLabel: options.checkboxLabel,
      checkboxChecked: options.checkboxChecked,
      type: options.type,
    },
  }
  return new Promise((resolve) => {
    const id = win.webContents.id
    let settled = false
    let expiry: ReturnType<typeof setTimeout> | undefined
    const finish = (result: MessageBoxResult) => {
      if (settled) return
      settled = true
      clearTimeout(expiry)
      pending.delete(id)
      if (!win.isDestroyed()) win.destroy()
      resolve(result)
    }
    pending.set(id, { state, finish })
    if (toastTone) expiry = setTimeout(() => finish(fallback), 6800)
    win.once('ready-to-show', () => {
      if (!settled) {
        if (toastTone) win.showInactive()
        else win.show()
      }
    })
    win.once('closed', () => finish(fallback))
    win.once('unresponsive', () => finish(fallback))
    const loaded = process.env.ELECTRON_RENDERER_URL
      ? win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/feedback.html`)
      : win.loadFile(join(__dirname, '../renderer/feedback.html'))
    void loaded.catch(() => finish(fallback))
  })
}
register()
