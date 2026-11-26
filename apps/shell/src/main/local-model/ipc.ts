import { app, ipcMain, shell, net } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { activeProvider, defaultAiSettings, resolveAiSettings } from '@genoffice/ai-provider'
import {
  preloadLocalChat,
  registerLocalChat,
  shutdownLocalChat,
} from '@genoffice/electron-utils/local-chat'
import { LFM_MANIFEST } from '@genoffice/local-llm/manifest'
import { LocalLlmError } from '@genoffice/local-llm/protocol'
import { LocalModelManager } from './manager'
import type { Lang } from '@genoffice/i18n'
import { localChatText } from '@genoffice/ai-provider/local-copy'
import { downloadNetwork, type DownloadNetwork } from './network'
import { readAppSettings, writeAppSetting } from '../app-settings'
import { showAppMessageBox } from '../app-message-box'
import { LOCAL_MODEL_EVENTS, type LocalModelStartup } from '../../shared/local-model'
import {
  LOCAL_MODEL_OFFER_KEY,
  asLocalModelOffer,
  withAnswered,
  withDeleted,
  withDownloaded,
  type LocalModelOffer,
} from './offer'

/** Called before the shared docs IPC registration; also owns first-run background download. */
export function registerLocalModel(
  language: () => Lang,
  /** delivers an event to the shell window, when there is one */
  send: (channel: string, payload?: unknown) => void = () => {},
): {
  /** asked before the provider changes; false ("Not now") keeps the previous one */
  confirmProviderChange(next: string, previous: string): Promise<boolean>
} {
  const manager = new LocalModelManager(app.getPath('userData'), shutdownLocalChat, () => {
    void announceDownload().catch((error) => console.warn('[local-model] offer failed:', error))
  })
  const initialize = manager.refresh()
  let stopping = false
  const quit = new AbortController()
  let cost: Promise<DownloadNetwork> | undefined
  const automaticDownload = async () => {
    if (stopping || manager.busy) return
    const network = !net.isOnline() ? 'offline' : await (cost ??= downloadNetwork(true))
    if (stopping || manager.busy) return
    if (network === 'offline' || network === 'metered') {
      manager.state = {
        status: 'paused',
        percent: manager.state.percent,
        error: localChatText()[network],
      }
      return
    }
    void manager.download()
  }
  /** Nothing of the model is here yet: only the user starts such a download. */
  const needsConsent = () => manager.state.status === 'missing' || manager.state.status === 'error'
  let asking: Promise<boolean> | undefined
  /** "Local AI requires downloading…": true when the user chose Download (one question at a time). */
  const confirmDownload = () =>
    (asking ??= (async () => {
      const c = localChatText()
      const { response } = await showAppMessageBox({
        type: 'question',
        title: c.title,
        message: c.downloadConfirm,
        detail: c.downloadQuestion,
        buttons: [c.download, c.notNow],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      return response === 0
    })().finally(() => {
      asking = undefined
    }))
  const storedSettings = (): Promise<unknown> =>
    readFile(join(app.getPath('userData'), 'ai-settings.json'), 'utf8').then(
      (s) => JSON.parse(s),
      () => undefined,
    )
  const settings = async () => resolveAiSettings(await storedSettings(), defaultAiSettings())
  /** Judged on the file: a resolved settings object says 'local' for someone who never chose. */
  const localIsSaved = async () => {
    const stored = await storedSettings().catch(() => undefined)
    return (stored as { provider?: unknown } | null | undefined)?.provider === 'local'
  }

  const appSettingsPath = join(app.getPath('userData'), 'app-settings.json')
  let offer = asLocalModelOffer(readAppSettings(appSettingsPath)[LOCAL_MODEL_OFFER_KEY])
  const saveOffer = (next: LocalModelOffer | undefined) => {
    const changed = next?.answered !== offer?.answered
    offer = next
    if (!changed) return
    try {
      writeAppSetting(appSettingsPath, LOCAL_MODEL_OFFER_KEY, next)
    } catch (error) {
      // still remembered for this session
      console.warn('[local-model] could not remember the offer:', error)
    }
    send(LOCAL_MODEL_EVENTS.offerChanged)
  }
  const announceDownload = async () => {
    if (stopping) return
    send(LOCAL_MODEL_EVENTS.downloaded)
    if (!(await localIsSaved()) && manager.state.status === 'ready')
      saveOffer(withDownloaded(offer))
  }
  const offerIsOpen = async () => {
    await initialize
    if (!offer || offer.answered || manager.state.status !== 'ready') return false
    if (!(await localIsSaved())) return true
    // Local was chosen in the picker or in Settings meanwhile: that is an answer.
    saveOffer(withAnswered())
    return false
  }
  /** Best effort: whatever goes wrong here, the first chat loads the model (or reports why not). */
  const preload = async () => {
    const report = (startup: LocalModelStartup) => {
      if (!stopping) send(LOCAL_MODEL_EVENTS.startup, startup)
    }
    if (stopping || manager.state.status !== 'ready') return report({ phase: 'skipped' })
    report({ phase: 'starting' })
    try {
      const local = (await settings()).providers.local
      const loaded = await preloadLocalChat(local, quit.signal, report)
      report({ phase: loaded ? 'ready' : 'skipped' })
    } catch (error) {
      // quitting cancels a load in progress; that is not a failure
      if (stopping) return
      console.warn('[local-model] preload failed:', error)
      report({ phase: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }
  registerLocalChat(
    async () => {
      await initialize
      const current = await settings()
      if (
        manager.state.status !== 'ready' &&
        current.providers.local?.local?.autoDownload !== false
      ) {
        // a download the user began goes on by itself; a new one waits for their Download
        if (!needsConsent()) await automaticDownload()
        else if (await confirmDownload()) void manager.download()
      }
      return manager.requireReady()
    },
    async (error) => {
      if (
        error instanceof LocalLlmError &&
        (error.code === 'MODEL_CHECKSUM' || error.code === 'MODEL_SIZE')
      ) {
        await manager.refresh()
        send(LOCAL_MODEL_EVENTS.offerChanged)
      }
    },
    language,
    (listener) => manager.watch(listener),
  )
  ipcMain.handle('local-model:license', () => shell.openExternal(LFM_MANIFEST.license.url))
  ipcMain.handle('local-model:status', () => ({ ...manager.state }))
  ipcMain.handle('local-model:action', async (_event, action: unknown) => {
    if (action === 'download') void manager.download()
    else if (action === 'cancel') await manager.cancel()
    else if (action === 'delete') {
      await manager.delete()
      if (manager.state.status === 'missing') saveOffer(withDeleted(offer))
    } else throw new Error('Unknown local model action')
    return { ...manager.state }
  })
  ipcMain.handle('local-model:offer', offerIsOpen)
  ipcMain.handle('local-model:answer-offer', async (_event, answer: unknown) => {
    if (answer !== 'use' && answer !== 'later') throw new Error('Unknown local model answer')
    // The provider is saved through the regular settings write first; without it nothing is in use.
    if (answer === 'use' && !(await localIsSaved()))
      throw new Error('Local is not the saved provider')
    saveOffer(withAnswered())
    if (answer === 'use') void preload()
  })
  void app
    .whenReady()
    .then(() => initialize)
    .then(async () => {
      const current = await settings()
      if (
        activeProvider(current) === 'local' &&
        current.providers.local?.local?.autoDownload !== false &&
        // only a download that was begun resumes at startup; a new one is the user's to start
        manager.state.status === 'paused'
      )
        await automaticDownload()
    })
    .catch(() => {})
  app.on('will-quit', () => {
    stopping = true
    quit.abort()
    void manager.cancel()
  })
  return {
    async confirmProviderChange(next, previous) {
      if (next !== 'local' || previous === 'local') return true
      await initialize
      if (!needsConsent()) return true
      if (!(await confirmDownload())) return false
      void manager.download()
      return true
    },
  }
}
