import { ipcMain, type WebContents } from 'electron'
import { parseAppControl } from '@genoffice/agent-core/app-control'
import type { AppActionResult } from '@genoffice/agent-core/app-control'
import { AppCommandBus } from './app-command-bus'
import type { TabManager } from './tab-manager'

/** Only the shell and attached Docs renderers may own commands. */
export function registerAppActionIpc(deps: {
  home(): WebContents | undefined
  tabs(): TabManager | null
}): () => void {
  const bus = new AppCommandBus()
  const registrations = new Map<number, { ids: Set<string>; generation: number }>()
  const watched = new Set<number>()
  let generation = 0
  const isHome = (wc: WebContents) => deps.home() === wc
  const isDocs = (wc: WebContents) => deps.tabs()?.describeWebContents(wc.id)?.kind === 'docs'
  const allowed = (wc: WebContents) => isHome(wc) || isDocs(wc)
  ipcMain.on('app-action:register', (event, ids: unknown) => {
    const wc = event.sender
    if (!allowed(wc) || !Array.isArray(ids) || !ids.length) return
    const permitted = isHome(wc)
      ? ['open-index-screen', 'open-settings', 'new-chat', 'get_setting', 'set_setting']
      : ['print', 'export-pdf']
    if (!ids.every((id) => typeof id === 'string' && permitted.includes(id))) return
    bus.invalidate(wc.id)
    registrations.set(wc.id, { ids: new Set(ids), generation: ++generation })
    if (!watched.has(wc.id)) {
      watched.add(wc.id)
      const invalidate = () => {
        registrations.delete(wc.id)
        bus.invalidate(wc.id)
      }
      wc.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
        if (mainFrame) invalidate()
      })
      wc.once('destroyed', () => {
        invalidate()
        watched.delete(wc.id)
      })
    }
  })
  ipcMain.on('app-action:unregister', (event) => {
    registrations.delete(event.sender.id)
    bus.invalidate(event.sender.id)
  })
  ipcMain.handle('app-action:prepare', (event, raw: unknown) => {
    if (!allowed(event.sender) || !raw || typeof raw !== 'object')
      throw new Error('Unauthorized app control')
    const { kind, ...args } = raw as Record<string, unknown>
    const input = parseAppControl(String(kind), args)
    const documentAction = input.kind === 'app_action' && ['print', 'export-pdf'].includes(input.id)
    const tab = documentAction
      ? deps
          .tabs()
          ?.list()
          .find((t) => t.active && t.kind === 'docs')
      : undefined
    const target =
      documentAction && tab
        ? deps.tabs()?.webContentsForTab(tab.id)
        : documentAction
          ? undefined
          : deps.home()
    const id = input.kind === 'app_action' ? input.id : input.kind
    const registration = target && registrations.get(target.id)
    if (!target || !registration?.ids.has(id))
      throw new Error(
        'No registered target for this command (print/export require the current Docs tab)',
      )
    const stillValid = () =>
      !target.isDestroyed() &&
      registrations.get(target.id) === registration &&
      (!tab ||
        (deps.tabs()?.webContentsForTab(tab.id) === target &&
          deps
            .tabs()
            ?.list()
            .some((t) => t.id === tab.id && t.active && t.filePath === tab.filePath) === true))
    return bus.prepare(event.sender.id, input, {
      key: target.id,
      valid: stillValid,
      send: (request) => {
        if (!documentAction && input.kind === 'app_action') deps.tabs()?.openHomeTab()
        if (documentAction) target.send('menu:command', id, undefined, request)
        else target.send('app-action:run', request)
      },
      cancel: (requestId) => {
        if (!target.isDestroyed()) target.send('app-action:cancelled', requestId)
        if (target !== event.sender && !event.sender.isDestroyed())
          event.sender.send('app-action:cancelled', requestId)
      },
    })
  })
  ipcMain.handle('app-action:execute', (event, id: unknown) => {
    if (!allowed(event.sender) || typeof id !== 'string') throw new Error('Invalid command ticket')
    return bus.execute(event.sender.id, id)
  })
  ipcMain.on('app-action:cancel', (event, id: unknown) => {
    if (typeof id === 'string') bus.cancel(event.sender.id, id)
  })
  ipcMain.on('app-action:ack', (event, id: unknown, result: AppActionResult) => {
    if (
      typeof id !== 'string' ||
      !result ||
      !['completed', 'handoff', 'cancelled', 'error'].includes(result.status)
    )
      return
    // Only scalar output: never return a renderer's settings object or credentials.
    bus.ack(event.sender.id, id, {
      status: result.status,
      ...(typeof result.value === 'string' ? { value: result.value } : {}),
      ...(typeof result.error === 'string' ? { error: result.error } : {}),
    })
  })
  return () => bus.validateTargets()
}
