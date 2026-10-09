import { posix, win32 } from 'node:path'

const activePdfDestinations = new Set<string>()

export interface PdfDestinationLease {
  readonly key: string
  release(): void
}

export function pdfDestinationKey(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
  cwd: string = process.cwd(),
): string {
  if (filePath.trim().length === 0) {
    throw new Error('PDF destination path is empty.')
  }

  if (platform === 'win32') {
    const base = /^[A-Za-z]:[\\/]/.test(cwd) ? cwd : 'C:\\'
    const absolute = win32.isAbsolute(filePath)
      ? win32.normalize(filePath)
      : win32.resolve(base, filePath)
    return win32.normalize(absolute).toLowerCase()
  }

  const absolute = posix.isAbsolute(filePath)
    ? posix.normalize(filePath)
    : posix.resolve(cwd, filePath)

  return platform === 'darwin' ? absolute.toLowerCase() : absolute
}

export function tryAcquirePdfDestination(filePath: string): PdfDestinationLease | null {
  const key = pdfDestinationKey(filePath)
  if (activePdfDestinations.has(key)) {
    return null
  }
  activePdfDestinations.add(key)
  let released = false
  return {
    key,
    release() {
      if (released) return
      released = true
      activePdfDestinations.delete(key)
    },
  }
}
