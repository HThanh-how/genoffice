import { posix, win32 } from 'node:path'

/**
 * The mount point that must be reachable before a missing file can be called deleted.
 * On Windows that is the drive or share root. On macOS and Linux "/" is always reachable, so an
 * unplugged external disk would look like mass deletion; use the mount folder instead
 * (`/Volumes/<name>`, `/media/<user>/<name>`, `/run/media/<user>/<name>`, `/mnt/<name>`).
 */
export function volumeRootOf(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return win32.parse(path).root
  const parts = posix.normalize(path).split('/').filter(Boolean)
  const mount = (count: number): string | null =>
    parts.length > count ? `/${parts.slice(0, count).join('/')}` : null
  if (parts[0] === 'Volumes') return mount(2) ?? '/'
  if (parts[0] === 'media') return mount(3) ?? '/'
  if (parts[0] === 'run' && parts[1] === 'media') return mount(4) ?? '/'
  if (parts[0] === 'mnt') return mount(2) ?? '/'
  return '/'
}
