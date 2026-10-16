/**
 * The containment rule for every file a renderer is allowed to write.
 *
 * A renderer may only write inside a directory it picked through a dialog. A
 * string prefix test is not containment: `/out/../elsewhere.pdf` starts with
 * `/out/` yet lands outside it, and a Windows path assembled with `/` is not
 * normalized by a POSIX separator comparison. Both sides are resolved with the
 * platform's own path rules first, then compared as absolute paths.
 *
 * `fs` and `realpath` are injected so the POSIX and Windows semantics can be
 * exercised without claiming to run on those platforms, and so a symlink that
 * points out of the authorized directory is caught rather than trusted.
 */
import { posix, win32 } from 'node:path'

export interface PathRules {
  resolve: (path: string) => string
  dirname: (path: string) => string
  sep: string
}

export const posixRules: PathRules = {
  resolve: posix.resolve,
  dirname: posix.dirname,
  sep: posix.sep,
}
export const windowsRules: PathRules = {
  resolve: win32.resolve,
  dirname: win32.dirname,
  sep: win32.sep,
}

/** `filePath` resolves to something strictly inside `dir`, after normalization. */
export function isInsideDirectory(dir: string, filePath: string, rules: PathRules): boolean {
  if (!dir || !filePath) return false
  const root = rules.resolve(dir)
  const target = rules.resolve(filePath)
  if (target === root) return false
  const prefix = root.endsWith(rules.sep) ? root : root + rules.sep
  return target.startsWith(prefix)
}

/**
 * The real path a write may use, or null when it would escape `dir`.
 *
 * A symlink inside the directory is resolved too: `out/link -> /elsewhere` is
 * not inside `out`, so writing through it is refused. `exists` and `realpath`
 * are the filesystem's own answers, not the renderer's claim.
 */
export function containedTarget(
  dir: string,
  filePath: string,
  rules: PathRules,
  exists: (path: string) => boolean,
  realpath: (path: string) => string,
): string | null {
  if (typeof dir !== 'string' || typeof filePath !== 'string') return null
  if (!isInsideDirectory(dir, filePath, rules)) return null
  const root = rules.resolve(dir)
  let existing = rules.resolve(filePath)
  const tail: string[] = []
  while (!exists(existing)) {
    const parent = rules.dirname(existing)
    if (!parent || parent === existing) return null
    tail.unshift(basenameOf(existing, rules))
    existing = parent
  }
  const real = realpath(existing)
  const realTarget = tail.length ? real + rules.sep + tail.join(rules.sep) : real
  return isInsideDirectory(root, realTarget, rules) ? realTarget : null
}

function basenameOf(path: string, rules: PathRules): string {
  const cut = path.lastIndexOf(rules.sep)
  return cut < 0 ? path : path.slice(cut + 1)
}
