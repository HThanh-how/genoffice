import { app, ipcMain, shell, net } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { activeProvider, defaultAiSettings, resolveAiSettings } from '@genoffice/ai-provider'
import { registerLocalChat, shutdownLocalChat } from '@genoffice/electron-utils/local-chat'
import { LFM_MANIFEST } from '@genoffice/local-llm/manifest'
import { LocalLlmError } from '@genoffice/local-llm/protocol'
import { LocalModelManager } from './manager'
import type { Lang } from '@genoffice/i18n'
import { localChatText } from '@genoffice/ai-provider/local-copy'
import { downloadNetwork, type DownloadNetwork } from './network'

/** Called before the shared docs IPC registration; also owns first-run background download. */
export function registerLocalModel(language: () => Lang): void {
  const manager = new LocalModelManager(app.getPath('userData'), shutdownLocalChat)
  const initialize = manager.refresh()
  let stopping = false
  let cost: Promise<DownloadNetwork> | undefined
  const automaticDownload = async () => {
    if (stopping) return
    const network = !net.isOnline() ? 'offline' : await (cost ??= downloadNetwork(true))
    if (stopping) return
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
  const settings = async () =>
    resolveAiSettings(
      await readFile(join(app.getPath('userData'), 'ai-settings.json'), 'utf8').then(
        (s) => JSON.parse(s),
        () => undefined,
      ),
      defaultAiSettings(),
    )
  registerLocalChat(
    async () => {
      await initialize
      const current = await settings()
      if (
        manager.state.status !== 'ready' &&
        current.providers.local?.local?.autoDownload !== false &&
        manager.state.status !== 'downloading'
      )
        await automaticDownload()
      return manager.requireReady()
    },
    async (error) => {
      if (
        error instanceof LocalLlmError &&
        (error.code === 'MODEL_CHECKSUM' || error.code === 'MODEL_SIZE')
      )
        await manager.refresh()
    },
    language,
  )
  ipcMain.handle('local-model:license', () => shell.openExternal(LFM_MANIFEST.license.url))
  ipcMain.handle('local-model:status', () => ({ ...manager.state }))
  ipcMain.handle('local-model:action', async (_event, action: unknown) => {
    if (action === 'download') void manager.download()
    else if (action === 'cancel') await manager.cancel()
    else if (action === 'delete') await manager.delete()
    else throw new Error('Unknown local model action')
    return { ...manager.state }
  })
  void app
    .whenReady()
    .then(() => initialize)
    .then(async () => {
      const current = await settings()
      if (
        activeProvider(current) === 'local' &&
        current.providers.local?.local?.autoDownload !== false &&
        (manager.state.status === 'missing' || manager.state.status === 'paused')
      )
        await automaticDownload()
    })
    .catch(() => {})
  app.on('will-quit', () => {
    stopping = true
    void manager.cancel()
  })
}
