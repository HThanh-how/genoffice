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

export interface WindowIconResolverOptions {
  platform?: string
  resourcesPath?: string
  appPath?: string
  baseDir?: string
  fileExists?: (path: string) => boolean
  validateImage?: (path: string) => boolean
}

/**
 * Resolves the native application icon for Windows BrowserWindow instances with injectable options.
 */
export function resolveWindowIconPath(options: WindowIconResolverOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return undefined

  const app = getElectronApp()
  const appPath =
    options.appPath ?? (typeof app?.getAppPath === 'function' ? app.getAppPath() : undefined)
  const resourcesPath =
    options.resourcesPath ?? (process as unknown as { resourcesPath?: string }).resourcesPath
  const baseDir = options.baseDir ?? __dirname
  const exists = options.fileExists ?? existsSync
  const isImageValid = options.validateImage ?? isValidImage

  const candidates = [
    // 1. Packaged extraResources in resources directory (production packaged path)
    ...(resourcesPath ? [join(resourcesPath, 'build/icon.ico')] : []),
    ...(resourcesPath ? [join(resourcesPath, 'app.asar.unpacked/build/icon.ico')] : []),
    // 2. Packaged app path
    ...(appPath ? [join(appPath, 'build/icon.ico')] : []),
    // 3. Dev / source checkout: apps/shell/build/icon.ico
    join(baseDir, '../../build/icon.ico'),
    join(baseDir, '../build/icon.ico'),
    // 4. Fallback to PNG in renderer assets
    join(baseDir, '../renderer/assets/app-icon.png'),
    join(baseDir, '../../renderer/assets/app-icon.png'),
  ]

  for (const candidate of candidates) {
    if (exists(candidate) && isImageValid(candidate)) {
      return candidate
    }
  }

  return undefined
}

/**
 * Resolves the native application icon for Windows BrowserWindow instances.
 * Guarded strictly by process.platform === 'win32'.
 */
export function resolveWindowIcon(): string | undefined {
  return resolveWindowIconPath()
}
