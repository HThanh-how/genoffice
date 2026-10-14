import { existsSync } from 'node:fs'
import { join } from 'node:path'

function getElectronApp(): { getAppPath?: () => string } | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron')
    if (electron && typeof electron.app?.getAppPath === 'function') {
      return electron.app
    }
  } catch {
    // fallback
  }
  return undefined
}

/**
 * Resolves the native application icon for Windows BrowserWindow instances.
 * Guarded strictly by process.platform === 'win32'.
 */
export function resolveWindowIcon(): string | undefined {
  if (process.platform !== 'win32') return undefined

  const app = getElectronApp()
  const appPath = typeof app?.getAppPath === 'function' ? app.getAppPath() : undefined
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath

  const candidates = [
    // 1. Dev / source checkout: apps/shell/build/icon.ico
    join(__dirname, '../../build/icon.ico'),
    join(__dirname, '../build/icon.ico'),
    // 2. Packaged extraResources / app path: build/icon.ico
    ...(appPath ? [join(appPath, 'build/icon.ico')] : []),
    ...(resourcesPath ? [join(resourcesPath, 'build/icon.ico')] : []),
    // 3. Fallback to PNG in renderer assets
    join(__dirname, '../renderer/assets/app-icon.png'),
    join(__dirname, '../../renderer/assets/app-icon.png'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return undefined
}
