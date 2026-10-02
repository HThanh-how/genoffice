import type { IpcRenderer, IpcRendererEvent } from 'electron'
import type { AgyActivity } from '@genoffice/ai-provider/agy-activity'
import {
  AGY_CHAT_CHANNELS,
  type AgyChatApi,
  type AgyChatCatalog,
  type AgyChatState,
  type AgyChatUsageState,
  type AgyLoginState,
} from '@genoffice/ai-provider/agy-chat'

const EMPTY_USAGE: AgyChatUsageState = { groups: null, readAt: 0, refreshing: false, failed: false }

function usageFrom(value: unknown): AgyChatUsageState {
  if (!value || typeof value !== 'object') return EMPTY_USAGE
  const v = value as Partial<AgyChatUsageState>
  return {
    groups: Array.isArray(v.groups) ? v.groups : null,
    readAt: typeof v.readAt === 'number' ? v.readAt : 0,
    refreshing: v.refreshing === true,
    failed: v.failed === true,
    ...(v.needsLogin === true ? { needsLogin: true } : {}),
  }
}

/** Preload half of the Antigravity chat chooser; spread into each editor's `window.desktop`. */
export function createAgyChatPreloadApi(ipcRenderer: IpcRenderer): AgyChatApi {
  return {
    async getAgyChatState() {
      return (await ipcRenderer.invoke(AGY_CHAT_CHANNELS.state)) as AgyChatState
    },
    async getAgyChatCatalog() {
      return (await ipcRenderer.invoke(AGY_CHAT_CHANNELS.catalog)) as AgyChatCatalog
    },
    async selectAgyChatModel(id) {
      return (await ipcRenderer.invoke(AGY_CHAT_CHANNELS.select, id)) === true
    },
    async setAgyChatEnabledModels(ids) {
      const result: unknown = await ipcRenderer.invoke(AGY_CHAT_CHANNELS.setEnabled, ids)
      return Array.isArray(result) ? result.filter((x): x is string => typeof x === 'string') : []
    },
    async getAgyChatUsage() {
      return usageFrom(await ipcRenderer.invoke(AGY_CHAT_CHANNELS.usage))
    },
    async refreshAgyChatUsage() {
      return usageFrom(await ipcRenderer.invoke(AGY_CHAT_CHANNELS.refreshUsage))
    },
    onAgyChatActivity(handler) {
      const listener = (_event: IpcRendererEvent, value: unknown) => {
        if (value && typeof value === 'object' && typeof (value as AgyActivity).runId === 'string')
          handler(value as AgyActivity)
      }
      ipcRenderer.on(AGY_CHAT_CHANNELS.activity, listener)
      return () => ipcRenderer.removeListener(AGY_CHAT_CHANNELS.activity, listener)
    },
    async startAgyLogin() {
      return (await ipcRenderer.invoke(AGY_CHAT_CHANNELS.loginStart)) as AgyLoginState
    },
    async submitAgyLoginCode(code) {
      return (await ipcRenderer.invoke(AGY_CHAT_CHANNELS.loginCode, code)) === true
    },
    async cancelAgyLogin() {
      await ipcRenderer.invoke(AGY_CHAT_CHANNELS.loginCancel)
    },
    onAgyLogin(handler) {
      const listener = (_event: IpcRendererEvent, value: unknown) => {
        if (value && typeof value === 'object') handler(value as AgyLoginState)
      }
      ipcRenderer.on(AGY_CHAT_CHANNELS.loginState, listener)
      return () => ipcRenderer.removeListener(AGY_CHAT_CHANNELS.loginState, listener)
    },
    onAgyChatUsage(handler) {
      const listener = (_event: IpcRendererEvent, value: unknown) => handler(usageFrom(value))
      ipcRenderer.on(AGY_CHAT_CHANNELS.usageUpdated, listener)
      return () => ipcRenderer.removeListener(AGY_CHAT_CHANNELS.usageUpdated, listener)
    },
  }
}
