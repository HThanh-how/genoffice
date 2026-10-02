/**
 * Whether `child` lies below `parent` (never the same folder). Windows paths (a drive letter or a
 * network share) compare without regard to case and accept either slash; others are exact.
 * Pure text, no disk access, so the main process and the tree can share it.
 */
export function isInsidePath(parent: string, child: string): boolean {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(parent) || /^[A-Za-z]:[\\/]|^\\\\/.test(child)
  const clean = (path: string): string => {
    const slashed = windows ? path.replace(/\\/g, '/') : path
    const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed
    return windows ? trimmed.toLocaleLowerCase() : trimmed
  }
  const base = clean(parent)
  const other = clean(child)
  if (!base || other === base) return false
  return other.startsWith(base.endsWith('/') ? base : `${base}/`)
}

/** The paths that are not inside another path of the list (a folder and the folder inside it: the first). */
export function outermostPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => !paths.some((other) => other !== path && isInsidePath(other, path)))
}
