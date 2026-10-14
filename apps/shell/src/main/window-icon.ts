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

function isValidImage(filePath: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron')
    if (electron && typeof electron.nativeImage?.createFromPath === 'function') {
      const img = electron.nativeImage.createFromPath(filePath)
      if (typeof img.isEmpty === 'function') {
        return !img.isEmpty()
      }
    }
  } catch {
    // fallback
  }
  return true
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
    // 1. Packaged extraResources in resources directory (production packaged path)
    ...(resourcesPath ? [join(resourcesPath, 'build/icon.ico')] : []),
    ...(resourcesPath ? [join(resourcesPath, 'app.asar.unpacked/build/icon.ico')] : []),
    // 2. Packaged app path
    ...(appPath ? [join(appPath, 'build/icon.ico')] : []),
    // 3. Dev / source checkout: apps/shell/build/icon.ico
    join(__dirname, '../../build/icon.ico'),
    join(__dirname, '../build/icon.ico'),
    // 4. Fallback to PNG in renderer assets
    join(__dirname, '../renderer/assets/app-icon.png'),
    join(__dirname, '../../renderer/assets/app-icon.png'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate) && isValidImage(candidate)) {
      return candidate
    }
  }

  return undefined
}
