/**
 * The containment rule for every file a renderer is allowed to write.
 *
 * A renderer may only write inside a directory it picked through a dialog. A
 * string prefix test is not containment: `/out/../elsewhere.pdf` starts with
 * `/out/` yet lands outside it, and a Windows path assembled with `/` is not
 * normalized by a POSIX separator comparison. Both sides are resolved with the
 * platform's own path rules first, then compared as absolute paths.
 *
 * `exists` and `realpath` are injected so the POSIX and Windows semantics can be
 * exercised without claiming to run on those platforms. The authorized directory
 * itself is canonicalized as well: a user who picks a symlinked folder is still
 * picking a real folder, and the grant must follow that real folder rather than
 * reject it. Symlinks *inside* the grant are still refused, because writing
 * through them lands somewhere the user never authorized.
 */
import { posix, win32 } from 'node:path'

export interface PathRules {
  resolve: (path: string) => string
  dirname: (path: string) => string
  sep: string
  /** Windows filesystems match names case-insensitively; POSIX ones do not. */
  caseInsensitive: boolean
}

export const posixRules: PathRules = {
  resolve: posix.resolve,
  dirname: posix.dirname,
  sep: posix.sep,
  caseInsensitive: false,
}
export const windowsRules: PathRules = {
  resolve: win32.resolve,
  dirname: win32.dirname,
  sep: win32.sep,
  caseInsensitive: true,
}

/** Names on a case-insensitive filesystem are the same name whatever their case. */
function fold(path: string, rules: PathRules): string {
  return rules.caseInsensitive ? path.toLowerCase() : path
}

/** `filePath` resolves to something strictly inside `dir`, after normalization. */
export function isInsideDirectory(dir: string, filePath: string, rules: PathRules): boolean {
  if (!dir || !filePath) return false
  const root = rules.resolve(dir)
  const target = rules.resolve(filePath)
  if (fold(target, rules) === fold(root, rules)) return false
  const prefix = root.endsWith(rules.sep) ? root : root + rules.sep
  return fold(target, rules).startsWith(fold(prefix, rules))
}

/**
 * The real path a write may use, or null when it would escape `dir`.
 *
 * The grant is canonicalized first, so a chosen symlink directory works: the
 * user picked `/out` which is really `/real/out`, and `/real/out/x.pdf` is
 * exactly what they authorized. A symlink *under* the grant is resolved too:
 * `out/link -> /elsewhere` is not inside the grant, so writing through it is
 * refused. `exists` and `realpath` are the filesystem's own answers, not the
 * renderer's claim.
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
  const logicalRoot = rules.resolve(dir)
  // the authorized directory may itself be a symlink; the grant follows the real
  // directory the user pointed at, and every target is compared against it
  const root = exists(logicalRoot) ? realpath(logicalRoot) : logicalRoot
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
