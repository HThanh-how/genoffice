import { BrowserWindow, app, shell } from 'electron'
import type { IpcMain } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { subscribeAgyActivity } from '@genoffice/ai-provider/agy-activity'
import { listAgyModels } from '@genoffice/ai-provider/agy-cli'
import {
  agyChoice,
  agyDefaultsUsable,
  agyUsabilityKnown,
  probeAgyUsable,
} from '@genoffice/ai-provider'
import { AgyInstaller } from '@genoffice/ai-provider/agy-install'
import { AgyLogin } from '@genoffice/ai-provider/agy-login'
import {
  agyUsageCliMissing,
  agyUsageNeedsLogin,
  readAgyUsage,
} from '@genoffice/ai-provider/agy-usage'
import {
  AGY_CHAT_CHANNELS,
  AGY_CHAT_DEFAULT_MODEL,
  agyChatModelInfo,
  defaultEnabledChatModels,
  defaultSelectedChatModel,
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
  /** quota group -> epoch ms until which a failed turn said it is used up (overrides the readings) */
  private readonly exhausted = new Map<string, number>()

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

  /**
   * A turn failed with "quota used up": show the group as empty (0% left, refilling at `resetAt`)
   * even when the last `/usage` read said otherwise, until the reset time (or 30 min when unknown).
   */
  markExhausted(group: string | null | undefined, resetAt?: number): void {
    if (!group) return
    const until = resetAt !== undefined && resetAt > this.now() ? resetAt : this.now() + 30 * 60_000
    this.exhausted.set(group, until)
    this.state = this.withExhausted(this.state)
    this.onChange(this.snapshot())
  }

  private withExhausted(state: AgyChatUsageState): AgyChatUsageState {
    if (this.exhausted.size === 0) return state
    const now = this.now()
    for (const [group, until] of this.exhausted) if (until <= now) this.exhausted.delete(group)
    const groups = [...(state.groups ?? [])]
    for (const [group, until] of this.exhausted) {
      const empty = (window: '5h' | 'weekly') => ({ window, remaining: 0, resetAt: until })
      const index = groups.findIndex((g) => g.name === group)
      const existing = index >= 0 ? groups[index]! : undefined
      // keep a known bucket's own reset time; only the "left" is forced to zero
      const buckets = existing?.buckets.length
        ? existing.buckets.map((b) => ({ ...b, remaining: 0, resetAt: b.resetAt ?? until }))
        : [empty('5h')]
      if (index >= 0) groups[index] = { name: group, buckets }
      else groups.push({ name: group, buckets })
    }
    return { ...state, groups }
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
          needsLogin: false,
          cliMissing: false,
        }
        this.state = this.withExhausted(this.state)
        try {
          writeJsonAtomic(this.cachePath, this.state)
        } catch {
          // the cache only makes the next start faster
        }
      } else {
        this.state = {
          ...this.state,
          failed: true,
          needsLogin: agyUsageNeedsLogin(),
          cliMissing: agyUsageCliMissing(),
        }
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
  const aiSettings = (): AiSettingsFile => readJson<AiSettingsFile>(deps.aiSettingsPath(), {})
  const getCliPath = (): string | undefined => {
    const p = aiSettings().providers?.agy?.cliPath
    return typeof p === 'string' && p.trim() ? p.trim() : undefined
  }
  const enabled = async (catalogModels?: string[]): Promise<string[]> => {
    const raw = readAppSettings(deps.settingsPath())[AGY_CHAT_MODELS_KEY]
    if (raw !== undefined) {
      return sanitizeEnabledChatModels(raw)
    }
    if (catalogModels && catalogModels.length > 0) {
      return defaultEnabledChatModels(catalogModels)
    }
    try {
      const catalog = await listAgyModels(getCliPath())
      return defaultEnabledChatModels(catalog.models)
    } catch {
      return defaultEnabledChatModels()
    }
  }
  const notifyAiSettingsChanged = (): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('ai:settings-changed')
      }
    }
  }

  const selectedModel = (catalogModels?: string[]): string => {
    const saved = aiSettings().providers?.agy?.model
    return typeof saved === 'string' && saved.trim()
      ? saved.trim()
      : defaultSelectedChatModel(catalogModels)
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

  deps.ipcMain.handle(AGY_CHAT_CHANNELS.state, async (): Promise<AgyChatState> => {
    const settings = aiSettings()
    const ids = await enabled()
    const current = selectedModel()
    const selected = ids.includes(current) ? current : (ids[0] ?? current)
    return {
      models: ids.map(agyChatModelInfo),
      selected,
      active: settings.provider === 'agy',
    }
  })

  deps.ipcMain.handle(AGY_CHAT_CHANNELS.catalog, async (): Promise<AgyChatCatalog> => {
    const catalog = await listAgyModels(getCliPath())
    const enabledIds = await enabled(catalog.models)
    return {
      all: catalog.models.map(agyChatModelInfo),
      enabled: enabledIds,
      ...(catalog.error ? { error: catalog.error } : {}),
    }
  })

  deps.ipcMain.handle(AGY_CHAT_CHANNELS.setEnabled, (_event, ids: unknown): string[] => {
    const next = sanitizeEnabledChatModels(ids)
    writeAppSetting(deps.settingsPath(), AGY_CHAT_MODELS_KEY, next)
    const settings = aiSettings()
    const current = settings.providers?.agy?.model?.trim() || defaultSelectedChatModel()
    if (next.length > 0 && !next.includes(current)) {
      const providers = { ...(settings.providers ?? {}) }
      providers.agy = { ...(providers.agy ?? {}), model: next[0] }
      writeJsonAtomic(deps.aiSettingsPath(), { ...settings, providers })
      notifyAiSettingsChanged()
    }
    return next
  })

  deps.ipcMain.handle(AGY_CHAT_CHANNELS.select, async (_event, id: unknown): Promise<boolean> => {
    if (typeof id !== 'string') return false
    const currentEnabled = await enabled()
    if (!currentEnabled.includes(id)) return false
    const settings = aiSettings()
    const providers = { ...(settings.providers ?? {}) }
    providers.agy = { ...(providers.agy ?? {}), model: id }
    writeJsonAtomic(deps.aiSettingsPath(), { ...settings, providers })
    notifyAiSettingsChanged()
    return true
  })

  // live steps of every Antigravity chat turn go to the windows for the thinking strip
  let lastTurnCheck = 0
  subscribeAgyActivity((activity) => {
    if (activity.phase === 'error' && activity.errorKind === 'quota' && activity.model)
      usage.markExhausted(agyChatModelInfo(activity.model).group, activity.resetAt)
    // A finished or failed chat turn used quota: re-read it (at most once a minute) so the % stays honest.
    if ((activity.phase === 'done' || activity.phase === 'error') && Date.now() - lastTurnCheck > 60_000) {
      lastTurnCheck = Date.now()
      const timer = setTimeout(() => void usage.refresh(), 2000)
      timer.unref?.()
    }
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send(AGY_CHAT_CHANNELS.activity, activity)
  })

  deps.ipcMain.handle(AGY_CHAT_CHANNELS.usage, () => usage.get())
  deps.ipcMain.handle(AGY_CHAT_CHANNELS.refreshUsage, () => usage.refresh())

  // Sign-in from the app: the CLI's Google page opens in the browser, the person pastes the code.
  const login = new AgyLogin(
    (state) => {
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed()) window.webContents.send(AGY_CHAT_CHANNELS.loginState, state)
      if (state.phase === 'done') void usage.refresh()
    },
    (url) => void shell.openExternal(url),
  )
  deps.ipcMain.handle(AGY_CHAT_CHANNELS.loginStart, () => login.start())
  deps.ipcMain.handle(AGY_CHAT_CHANNELS.loginCode, (_event, code: unknown) =>
    typeof code === 'string' && code.length < 2000 ? login.submitCode(code) : false,
  )
  deps.ipcMain.handle(AGY_CHAT_CHANNELS.loginCancel, () => login.cancel())

  // No agy on this computer: Google's own installer is run for this user once the person asks, and
  // when it is done the usage is read again (which then asks to sign in).
  const installer = new AgyInstaller((state) => {
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send(AGY_CHAT_CHANNELS.installState, state)
    if (state.phase === 'done') void usage.refresh()
  })
  deps.ipcMain.handle(AGY_CHAT_CHANNELS.installStart, () => installer.start())

  // One check each time the app starts, but only for people who use Antigravity: a person who
  // never chose it must not have `agy` started behind their back (it boots a language server and
  // calls Google). Features the settings file does not decide follow the agy-first default, which
  // is decided by the cheap `agy models` probe.
  void app.whenReady().then(() => {
    const timer = setTimeout(() => {
      void shouldReadAgyUsageAtLaunch(aiSettings(), probeUsableOnce).then((yes) => {
        if (yes) void usage.refresh()
      })
    }, STARTUP_CHECK_DELAY_MS)
    timer.unref?.()
  })
}

/** The answer the startup probe already has, else one `agy models` run (joined if one is under way). */
function probeUsableOnce(cliPath: string | undefined): Promise<boolean> {
  return agyUsabilityKnown() ? Promise.resolve(agyDefaultsUsable()) : probeAgyUsable(cliPath)
}

/**
 * Whether the launch-time usage read is worth doing: Antigravity is chosen for some feature in the
 * stored settings, or (for features left undecided) it is the usable default. The probe runs only
 * when the answer depends on it.
 */
export async function shouldReadAgyUsageAtLaunch(
  settings: AiSettingsFile,
  probe: (cliPath: string | undefined) => Promise<boolean>,
): Promise<boolean> {
  try {
    const first = agyChoice(settings, null)
    if (first !== 'unknown') return first === 'yes'
    const cliPath = settings.providers?.agy?.cliPath
    const usable = await probe(typeof cliPath === 'string' && cliPath.trim() ? cliPath : undefined)
    return agyChoice(settings, usable) === 'yes'
  } catch {
    return false
  }
}
