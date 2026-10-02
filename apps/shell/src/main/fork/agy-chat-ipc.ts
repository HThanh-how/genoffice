import { BrowserWindow, app } from 'electron'
import type { IpcMain } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { subscribeAgyActivity } from '@genoffice/ai-provider/agy-activity'
import { listAgyModels } from '@genoffice/ai-provider/agy-cli'
import { readAgyUsage } from '@genoffice/ai-provider/agy-usage'
import {
  AGY_CHAT_CHANNELS,
  AGY_CHAT_DEFAULT_MODEL,
  agyChatModelInfo,
  sanitizeEnabledChatModels,
  type AgyChatCatalog,
  type AgyChatState,
  type AgyChatUsageState,
} from '@genoffice/ai-provider/agy-chat'
import { readAppSettings, writeAppSetting } from '../app-settings'

export const AGY_CHAT_MODELS_KEY = 'agyChatModels'
/** A reading younger than this is served as is; an older one is shown at once and refreshed. */
export const AGY_USAGE_FRESH_MS = 5 * 60_000
/** First check shortly after launch, once the window is up. */
const STARTUP_CHECK_DELAY_MS = 4_000

export interface AgyChatDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  /** absolute path of app-settings.json */
  settingsPath: () => string
  /** absolute path of ai-settings.json (the chat provider settings every editor shares) */
  aiSettingsPath: () => string
  /** where the last usage reading is kept so the next launch can show it instantly */
  cachePath: () => string
}

interface AiSettingsFile {
  provider?: string
  providers?: Record<string, { model?: string } & Record<string, unknown>>
  [key: string]: unknown
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temporary, path)
}

/** Stale-while-revalidate quota reader: always answers from memory, refreshes behind the scenes. */
export class AgyUsageCache {
  private state: AgyChatUsageState = { groups: null, readAt: 0, refreshing: false, failed: false }
  private inflight: Promise<AgyChatUsageState> | null = null
  private busy = false

  constructor(
    private readonly read: typeof readAgyUsage,
    private readonly cachePath: string,
    private readonly now: () => number,
    private readonly onChange: (state: AgyChatUsageState) => void,
  ) {
    const saved = readJson<Partial<AgyChatUsageState> | null>(cachePath, null)
    if (saved && Array.isArray(saved.groups) && typeof saved.readAt === 'number')
      this.state = { groups: saved.groups, readAt: saved.readAt, refreshing: false, failed: false }
  }

  snapshot(): AgyChatUsageState {
    return { ...this.state, refreshing: this.busy }
  }

  /** Current numbers now; starts a refresh when they are older than the freshness window. */
  get(): AgyChatUsageState {
    if (this.state.readAt === 0 || this.now() - this.state.readAt > AGY_USAGE_FRESH_MS)
      void this.refresh()
    return this.snapshot()
  }

  refresh(): Promise<AgyChatUsageState> {
    if (this.inflight) return this.inflight
    this.busy = true
    this.inflight = (async () => {
      this.onChange(this.snapshot())
      const reading = await this.read()
      if (reading) {
        this.state = {
          groups: reading.groups.map((group) => ({
            name: group.name,
            buckets: group.buckets.map((bucket) => ({
              window: bucket.window,
              remaining: bucket.remaining,
              ...(bucket.resetAt === undefined ? {} : { resetAt: bucket.resetAt }),
            })),
          })),
          readAt: reading.readAt,
          refreshing: false,
          failed: false,
        }
        try {
          writeJsonAtomic(this.cachePath, this.state)
        } catch {
          // the cache only makes the next start faster
        }
      } else {
        this.state = { ...this.state, failed: true }
      }
      this.inflight = null
      this.busy = false
      const done = this.snapshot()
      this.onChange(done)
      return done
    })()
    return this.inflight
  }
}

/**
 * Chat model chooser for the Antigravity provider: which models appear in the chat box (default
 * only Gemini 3.8 Flash Low), picking one, and the quota readout shown beside it.
 */
export function registerAgyChat(deps: AgyChatDeps): void {
  const enabled = (): string[] =>
    sanitizeEnabledChatModels(readAppSettings(deps.settingsPath())[AGY_CHAT_MODELS_KEY])
  const aiSettings = (): AiSettingsFile => readJson<AiSettingsFile>(deps.aiSettingsPath(), {})
  const selectedModel = (): string => {
    const saved = aiSettings().providers?.agy?.model
    return typeof saved === 'string' && saved.trim() ? saved.trim() : AGY_CHAT_DEFAULT_MODEL
  }

  const usage = new AgyUsageCache(
    readAgyUsage,
    deps.cachePath(),
    () => Date.now(),
    (state) => {
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed()) window.webContents.send(AGY_CHAT_CHANNELS.usageUpdated, state)
    },
  )

  deps.ipcMain.handle(AGY_CHAT_CHANNELS.state, (): AgyChatState => {
    const settings = aiSettings()
    const current = selectedModel()
    // the saved model stays reachable even if the user later switched it off in the list
    const ids = enabled()
    if (!ids.includes(current)) ids.unshift(current)
    return {
      models: ids.map(agyChatModelInfo),
      selected: current,
      active: settings.provider === 'agy',
    }
  })

  deps.ipcMain.handle(AGY_CHAT_CHANNELS.catalog, async (): Promise<AgyChatCatalog> => {
    const catalog = await listAgyModels(undefined)
    return {
      all: catalog.models.map(agyChatModelInfo),
      enabled: enabled(),
      ...(catalog.error ? { error: catalog.error } : {}),
    }
  })

  deps.ipcMain.handle(AGY_CHAT_CHANNELS.setEnabled, (_event, ids: unknown): string[] => {
    const next = sanitizeEnabledChatModels(ids)
    writeAppSetting(deps.settingsPath(), AGY_CHAT_MODELS_KEY, next)
    return next
  })

  deps.ipcMain.handle(AGY_CHAT_CHANNELS.select, (_event, id: unknown): boolean => {
    if (typeof id !== 'string' || !enabled().includes(id)) return false
    const settings = aiSettings()
    const providers = { ...(settings.providers ?? {}) }
    providers.agy = { ...(providers.agy ?? {}), model: id }
    writeJsonAtomic(deps.aiSettingsPath(), { ...settings, providers })
    return true
  })

  // live steps of every Antigravity chat turn go to the windows for the thinking strip
  subscribeAgyActivity((activity) => {
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send(AGY_CHAT_CHANNELS.activity, activity)
  })

  deps.ipcMain.handle(AGY_CHAT_CHANNELS.usage, () => usage.get())
  deps.ipcMain.handle(AGY_CHAT_CHANNELS.refreshUsage, () => usage.refresh())

  // One check each time the app starts; the chat box then shows it (and tucks it away again).
  void app.whenReady().then(() => {
    const timer = setTimeout(() => {
      void usage.refresh()
    }, STARTUP_CHECK_DELAY_MS)
    timer.unref?.()
  })
}
