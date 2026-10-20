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
  agyChatModelInfo,
  normalizeChatModel,
  resolveChatModels,
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
          needsLogin: false,
          cliMissing: false,
        }
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
 * Chat model chooser for the Antigravity provider: which models appear in the chat box, picking
 * one, and the quota readout shown beside it.
 */
export function registerAgyChat(deps: AgyChatDeps): void {
  const aiSettings = (): AiSettingsFile => readJson<AiSettingsFile>(deps.aiSettingsPath(), {})
  /** the CLI the person configured, or undefined for "auto-detect" (the same rule the chat uses) */
  const getCliPath = (): string | undefined => {
    const p = aiSettings().providers?.agy?.cliPath
    return typeof p === 'string' && p.trim() ? p.trim() : undefined
  }
  /** `agy models` for the configured executable; listAgyModels caches it and never throws. */
  const catalog = async (): Promise<{ models: string[]; error?: string }> => {
    const result = await listAgyModels(getCliPath())
    return { models: result.models, ...(result.error ? { error: result.error } : {}) }
  }
  /** the model chat requests use, read at the moment of a mutation so a newer choice wins */
  const selectedModel = (): string | undefined =>
    normalizeChatModel(aiSettings().providers?.agy?.model)

  const usage = new AgyUsageCache(
    readAgyUsage,
    deps.cachePath(),
    () => Date.now(),
    (state) => {
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed()) window.webContents.send(AGY_CHAT_CHANNELS.usageUpdated, state)
    },
  )

  // Reading the chat box must not change anything: the enabled list and the selection are
  // resolved from what is already stored, and a catalog failure is reported rather than
  // repaired by writing a fallback over the user's choice.
  deps.ipcMain.handle(AGY_CHAT_CHANNELS.state, async (): Promise<AgyChatState> => {
    // Resolve the catalog first, then read the settings, so a choice made while the catalog was
    // in flight is reported rather than an older snapshot.
    const models = await catalog()
    const settings = aiSettings()
    const resolved = resolveChatModels({
      savedEnabled: readAppSettings(deps.settingsPath())[AGY_CHAT_MODELS_KEY],
      savedModel: settings.providers?.agy?.model,
      catalog: models,
    })
    return {
      models: resolved.models,
      selected: resolved.selected,
      active: settings.provider === 'agy',
      available: resolved.available,
      selectedStatus: resolved.selectedStatus,
      ...(resolved.catalogError ? { catalogError: resolved.catalogError } : {}),
    }
  })

  // Every mutation carries a stamp taken when the person made it. A delayed request may only
  // write while it is still the newest one, so an older action can never undo a newer one.
  let mutationStamp = 0
  let lastModelStamp = 0

  /** Persist the chat model, unless a newer mutation already wrote one. Returns whether it landed. */
  function applySelectedModel(model: string, stamp: number): boolean {
    if (stamp < lastModelStamp) return false
    const settings = aiSettings()
    const providers = { ...(settings.providers ?? {}) }
    providers.agy = { ...(providers.agy ?? {}), model }
    writeJsonAtomic(deps.aiSettingsPath(), { ...settings, providers })
    lastModelStamp = stamp
    return true
  }

  /**
   * Tell every window that the chat model or the enabled list changed. `ai:settings-changed` is
   * sent as well whenever ai-settings.json itself moved, so the model pickers re-read it too.
   */
  function notifyModelChange(settingsAlsoChanged: boolean): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      window.webContents.send(AGY_CHAT_CHANNELS.modelChanged)
      if (settingsAlsoChanged) window.webContents.send('ai:settings-changed')
    }
  }

  deps.ipcMain.handle(AGY_CHAT_CHANNELS.catalog, async (): Promise<AgyChatCatalog> => {
    const models = await catalog()
    const resolved = resolveChatModels({
      savedEnabled: readAppSettings(deps.settingsPath())[AGY_CHAT_MODELS_KEY],
      savedModel: selectedModel(),
      catalog: models,
    })
    return {
      all: models.models.map(agyChatModelInfo),
      enabled: resolved.enabled,
      ...(models.error ? { error: models.error } : {}),
    }
  })

  deps.ipcMain.handle(AGY_CHAT_CHANNELS.setEnabled, (_event, ids: unknown): string[] | null => {
    const stamp = ++mutationStamp
    const next = sanitizeEnabledChatModels(ids)
    const previous = readAppSettings(deps.settingsPath())[AGY_CHAT_MODELS_KEY]
    try {
      writeAppSetting(deps.settingsPath(), AGY_CHAT_MODELS_KEY, next)
    } catch {
      // nothing was saved: report failure instead of a list the person did not get
      return null
    }
    // Turning off the model in use is an explicit choice, so the next one is decided here,
    // deterministically: the first model still switched on. A read-only state query never does
    // this, and a model the person left on is never switched off by a catalog change.
    const current = selectedModel()
    let settingsAlsoChanged = false
    if (current && !next.includes(current)) {
      try {
        settingsAlsoChanged = applySelectedModel(next[0], stamp)
      } catch {
        // The selection could not be moved, so the enabled list would point the chat box at a
        // model it is not allowed to use. Undo the list while the selection is still the one this
        // mutation was about to move, so the two files never disagree. A newer selection made in
        // another window is left alone: rolling it back would lose that newer choice.
        if (selectedModel() === current) {
          try {
            writeAppSetting(deps.settingsPath(), AGY_CHAT_MODELS_KEY, previous)
          } catch {
            // Recovery failed as well. The next state read reports the real persisted state, and
            // the selection is shown as unavailable rather than as a usable option.
          }
        }
        // Nothing was reported as changed: no notification, no list, no silent re-selection.
        return null
      }
    }
    // Enabling or disabling any model changes what the chat box offers in every window, even
    // when the selected model is untouched.
    notifyModelChange(settingsAlsoChanged)
    return next
  })

  deps.ipcMain.handle(AGY_CHAT_CHANNELS.select, async (_event, id: unknown): Promise<boolean> => {
    if (typeof id !== 'string' || !id.trim()) return false
    const model = id.trim()
    // the stamp is taken when the request arrives, before the catalog read
    const stamp = ++mutationStamp
    const models = await catalog()
    const resolved = resolveChatModels({
      savedEnabled: readAppSettings(deps.settingsPath())[AGY_CHAT_MODELS_KEY],
      savedModel: model,
      catalog: models,
    })
    // A new choice must be both switched on by the person and confirmed by the CLI that is
    // configured right now. A catalog that could not be read confirms nothing, so a new choice
    // is refused rather than written as if it were verified. A model already stored is never
    // rewritten by this handler: only an explicit selection changes it.
    if (!resolved.enabled.includes(model) || !resolved.available.includes(model)) return false
    try {
      // Re-read right before writing so a choice made while the catalog was pending is not lost.
      if (!applySelectedModel(model, stamp)) return false
    } catch {
      return false
    }
    notifyModelChange(true)
    return true
  })

  // live steps of every Antigravity chat turn go to the windows for the thinking strip
  let lastTurnCheck = 0
  subscribeAgyActivity((activity) => {
    // A finished chat turn used quota: re-read it (at most once a minute) so the % stays honest.
    if (activity.phase === 'done' && Date.now() - lastTurnCheck > 60_000) {
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
