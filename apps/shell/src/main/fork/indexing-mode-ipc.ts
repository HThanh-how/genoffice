import { app, powerMonitor } from 'electron'
import type { IpcMain } from 'electron'
import { availableParallelism, freemem } from 'node:os'
import { readBattery, realBatteryDeps } from './indexing-battery'
import { registerIndexingModeIpc } from './indexing-mode-controller'
import { IndexingMonitor, electronFreeMemMB } from './indexing-monitor'

export interface IndexingModeDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  /** absolute path of app-settings.json */
  settingsPath: () => string
}

/**
 * Registers the indexing-mode settings IPC and starts the power / idle monitor that drives the
 * document-index job's priority (see indexing-policy.ts). Call once, before the app is ready.
 */
export function registerIndexingMode(deps: IndexingModeDeps): void {
  let monitor: IndexingMonitor | null = null
  const controller = registerIndexingModeIpc({
    ipcMain: deps.ipcMain,
    settingsPath: deps.settingsPath,
    onSettingsChanged: () => monitor?.tick(),
  })
  void app.whenReady().then(() => {
    const batteryDeps = realBatteryDeps()
    monitor = new IndexingMonitor({
      power: powerMonitor,
      cores: availableParallelism(),
      // Electron's figure counts reclaimable memory as available (os.freemem() does not on macOS).
      freeMemMB: () => electronFreeMemMB(() => process.getSystemMemoryInfo(), freemem),
      readBattery: () => readBattery(batteryDeps),
      settings: controller.settings,
    })
    monitor.start()
  })
  app.once('will-quit', () => monitor?.stop())
}
