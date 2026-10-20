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

/** Identity of the executable a quota reading belongs to; empty means "auto-detect". */
function cliKeyOf(cliPath: string | undefined): string {
  return cliPath?.trim() || ''
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
  private inflight: { key: string; promise: Promise<AgyChatUsageState> } | null = null
  /** bumped for every refresh so only the newest in-flight read may clear the record */
  private generation = 0
  private busy = false
  /** which executable the numbers in `state` belong to; undefined until a read is taken */
  private cliKey: string | undefined
  /** the executable a restored cache file was read from, when the file records one */
  private savedCliKey: string | undefined

  constructor(
    private readonly read: typeof readAgyUsage,
    private readonly cachePath: string,
    private readonly now: () => number,
    private readonly onChange: (state: AgyChatUsageState) => void,
    /** the CLI the person configured; quota is read from that executable, not from an auto-detected one */
    private readonly cliPath: () => string | undefined = () => undefined,
  ) {
    const saved = readJson<(Partial<AgyChatUsageState> & { cliKey?: string }) | null>(
      cachePath,
      null,
    )
    const key = cliKeyOf(cliPath())
    // A reading taken from a different executable is not this CLI's quota. A file written before
    // the cache recorded an identity is only trusted while the CLI is still auto-detected, which
    // is exactly how that file was produced.
    const sameCli = saved?.cliKey === key || (saved?.cliKey === undefined && key === '')
    if (saved && sameCli && Array.isArray(saved.groups) && typeof saved.readAt === 'number') {
      this.state = { groups: saved.groups, readAt: saved.readAt, refreshing: false, failed: false }
      this.savedCliKey = saved.cliKey ?? key
      this.cliKey = this.savedCliKey
    } else {
      this.cliKey = key
      this.savedCliKey = saved?.cliKey
    }
  }

  private ensureCurrentCli(): string {
    const key = cliKeyOf(this.cliPath())
    if (this.cliKey !== undefined && key !== this.cliKey) {
      this.state = { groups: null, readAt: 0, refreshing: false, failed: false }
      this.cliKey = key
      this.savedCliKey = key
    } else if (this.cliKey === undefined) {
      this.cliKey = key
    }
    return key
  }

  snapshot(): AgyChatUsageState {
    this.ensureCurrentCli()
    return { ...this.state, refreshing: this.busy }
  }

  /** Current numbers now; starts a refresh when they are older than the freshness window. */
  get(): AgyChatUsageState {
    const key = this.ensureCurrentCli()
    if (
      this.state.readAt === 0 ||
      this.now() - this.state.readAt > AGY_USAGE_FRESH_MS ||
      (this.savedCliKey !== undefined && this.savedCliKey !== key)
    )
      void this.refresh()
    return this.snapshot()
  }

  refresh(): Promise<AgyChatUsageState> {
    const key = this.ensureCurrentCli()
    if (this.inflight && this.inflight.key === key) return this.inflight.promise
    this.busy = true
    const cliPath = this.cliPath()
    const generation = ++this.generation
    const promise = (async (): Promise<AgyChatUsageState> => {
      this.onChange(this.snapshot())
      try {
        const reading = await this.read(cliPath)
        const isCurrent = generation === this.generation && cliKeyOf(this.cliPath()) === key
        if (!isCurrent) {
          return this.snapshot()
        }
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
            writeJsonAtomic(this.cachePath, { ...this.state, cliKey: key })
          } catch {
            // the cache only makes the next start faster
          }
        } else {
          this.state = {
            ...this.state,
            failed: true,
            needsLogin: agyUsageNeedsLogin(cliPath),
            cliMissing: agyUsageCliMissing(cliPath),
          }
        }
      } catch {
        const isCurrent = generation === this.generation && cliKeyOf(this.cliPath()) === key
        if (isCurrent) {
          this.state = {
            ...this.state,
            failed: true,
            needsLogin: false,
            cliMissing: false,
          }
        }
      } finally {
        if (generation === this.generation) {
          this.busy = false
          this.inflight = null
          this.onChange(this.snapshot())
        }
      }
      return this.snapshot()
    })()
    this.inflight = { key, promise }
    return promise
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
  /**
   * `agy models` for the configured executable; listAgyModels caches it and never throws.
   * The identity is part of the answer: if the person points Antigravity at a different
   * executable while a probe is in flight, the catalog is retaken for the executable that is
   * configured now, so an answer produced by one CLI can never authorize a model for another.
   */
  const catalog = async (): Promise<{
    models: string[]
    error?: string
    cliPath: string | undefined
  }> => {
    let cliPath = getCliPath()
    let result = await listAgyModels(cliPath)
    if (getCliPath() !== cliPath) {
      cliPath = getCliPath()
      result = await listAgyModels(cliPath)
    }
    return { models: result.models, ...(result.error ? { error: result.error } : {}), cliPath }
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
    getCliPath,
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

  // Every mutation carries a stamp taken when the person made it, and one shared commit stamp
  // records the newest mutation of *any* kind. A delayed request may only write - or roll back -
  // while it is still the newest one, so an older action can never undo a newer one, whether the
  // newer action changed the enabled list or the selected model.
  let mutationStamp = 0
  let lastCommittedStamp = 0

  /** undo an enabled-list write, but only while this mutation is still the newest one */
  function restoreEnabledList(stamp: number, previous: unknown): boolean {
    if (stamp < lastCommittedStamp) return false
    try {
      writeAppSetting(deps.settingsPath(), AGY_CHAT_MODELS_KEY, previous)
      lastCommittedStamp = stamp
      return true
    } catch {
      // recovery failed as well; the next state read reports the real persisted state
      return false
    }
  }

  /**
   * Persist the chat model - and, when the composer is switching providers, the provider itself -
   * in a single atomic write, unless a newer mutation already wrote one. A provider switch that
   * is committed in two writes can leave the model moved while the provider stayed put, so the
   * whole switch is written at once and a failed write leaves the previous file untouched.
   */
  function applySelectedModel(model: string, stamp: number, activateProvider = false): boolean {
    if (stamp < lastCommittedStamp) return false
    const settings = aiSettings()
    const providers = { ...(settings.providers ?? {}) }
    providers.agy = { ...(providers.agy ?? {}), model }
    writeJsonAtomic(deps.aiSettingsPath(), {
      ...settings,
      ...(activateProvider ? { provider: 'agy' } : {}),
      providers,
    })
    lastCommittedStamp = stamp
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

  deps.ipcMain.handle(
    AGY_CHAT_CHANNELS.setEnabled,
    async (_event, ids: unknown): Promise<string[] | null> => {
      const stamp = ++mutationStamp
      const next = sanitizeEnabledChatModels(ids)
      const previous = readAppSettings(deps.settingsPath())[AGY_CHAT_MODELS_KEY]
      try {
        writeAppSetting(deps.settingsPath(), AGY_CHAT_MODELS_KEY, next)
      } catch {
        // nothing was saved: report failure instead of a list the person did not get
        return null
      }
      lastCommittedStamp = stamp
      // deterministically: the first model still switched on *and* confirmed by the configured
      // CLI. A read-only state query never does this, and a model the person left on is never
      // switched off by a catalog change.
      const current = selectedModel()
      let settingsAlsoChanged = false
      if (current && !next.includes(current)) {
        const models = await catalog()
        // another window committed a newer mutation (enabled list or selection) while this
        // catalog read was in flight; rolling back now would undo that newer choice, so this
        // request gives up and reports failure rather than a half-applied change
        if (stamp < lastCommittedStamp) return null
        const replacement = next.find((id) => !models.error && models.models.includes(id))
        if (!replacement) {
          // The selection cannot be moved to a model the CLI has not confirmed, and leaving it
          // on a list that no longer contains it would make the two files disagree. Undo the
          // list so the two files never disagree. A newer selection made in another window is
          // never rolled back: applySelectedModel refuses an older stamp, so this branch is
          // only reached while this mutation is still the newest one.
          restoreEnabledList(stamp, previous)
          // Nothing was reported as changed: no notification, no list, no silent re-selection.
          return null
        }
        try {
          settingsAlsoChanged = applySelectedModel(replacement, stamp)
        } catch {
          settingsAlsoChanged = false
        }
        if (!settingsAlsoChanged) {
          // The selection could not be moved, so the enabled list would point the chat box at a
          // model it is not allowed to use. Undo the list so the two files never disagree. A
          // newer mutation is left alone: restoreEnabledList returns false for an older stamp,
          // and this mutation then reports failure instead of a partial success.
          restoreEnabledList(stamp, previous)
          // Nothing was reported as changed: no notification, no list, no silent re-selection.
          return null
        }
      }
      // Enabling or disabling any model changes what the chat box offers in every window, even
      // when the selected model is untouched.
      notifyModelChange(settingsAlsoChanged)
      return next
    },
  )

  deps.ipcMain.handle(
    AGY_CHAT_CHANNELS.select,
    async (_event, id: unknown, activateProvider: unknown): Promise<boolean> => {
      if (typeof id !== 'string' || !id.trim()) return false
      const model = id.trim()
      // the stamp is taken when the request arrives, before the catalog read
      const stamp = ++mutationStamp
      const models = await catalog()
      // The CLI path may have moved while the catalog was in flight. A model confirmed by the
      // executable that is no longer configured is not a valid choice for the one that is, so
      // the request is refused rather than retried forever.
      if (getCliPath() !== models.cliPath) return false
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
        if (!applySelectedModel(model, stamp, activateProvider === true)) return false
      } catch {
        return false
      }
      notifyModelChange(true)
      return true
    },
  )

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
  // The sign-in runs against the executable the person configured, the same one the catalog and
  // the quota read use, so a login never belongs to a different Antigravity install.
  const login = new AgyLogin(
    (state) => {
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed()) window.webContents.send(AGY_CHAT_CHANNELS.loginState, state)
      if (state.phase === 'done') void usage.refresh()
    },
    (url) => void shell.openExternal(url),
    getCliPath,
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
