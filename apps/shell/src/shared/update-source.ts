export interface UpdateSource {
  kind: 'github' | 'manifest'
  value: string
}
export const DEFAULT_UPDATE_SOURCE: UpdateSource = { kind: 'github', value: 'HThanh-how/genoffice' }

export function secureUpdateUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid update URL')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('Update URLs must use HTTPS without credentials or fragments')
  return url.href
}

export function validateUpdateSource(input: unknown): UpdateSource {
  if (!input || typeof input !== 'object') throw new Error('Invalid update source')
  const { kind, value } = input as UpdateSource
  if (typeof value !== 'string') throw new Error('Invalid update source')
  if (kind === 'github') {
    const repo = value
      .trim()
      .replace(/^https:\/\/github\.com\//, '')
      .replace(/\/$/, '')
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo) || repo.length > 200)
      throw new Error('Enter a GitHub owner/repository')
    return { kind, value: repo }
  }
  if (kind === 'manifest') return { kind, value: secureUpdateUrl(value.trim()) }
  throw new Error('Invalid update source')
}

export interface InstallerRelease {
  version: string
  url: string
  sha256: string
  extension: '.dmg' | '.exe' | '.AppImage'
}

// SemVer comparison also prevents a beta -> stable channel switch from downgrading.
function versionParts(value: string): { core: number[]; pre: string[] } {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value)
  if (!match) throw new Error('Invalid release version')
  return { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] }
}
export function compareVersions(a: string, b: string): number {
  const av = versionParts(a),
    bv = versionParts(b)
  for (let i = 0; i < 3; i++) if (av.core[i] !== bv.core[i]) return av.core[i] > bv.core[i] ? 1 : -1
  if (!av.pre.length || !bv.pre.length) return av.pre.length ? -1 : bv.pre.length ? 1 : 0
  for (let i = 0; i < Math.max(av.pre.length, bv.pre.length); i++) {
    if (av.pre[i] === undefined) return -1
    if (bv.pre[i] === undefined) return 1
    if (av.pre[i] === bv.pre[i]) continue
    const an = /^\d+$/.test(av.pre[i]),
      bn = /^\d+$/.test(bv.pre[i])
    if (an && bn) return Number(av.pre[i]) > Number(bv.pre[i]) ? 1 : -1
    if (an !== bn) return an ? -1 : 1
    return av.pre[i] > bv.pre[i] ? 1 : -1
  }
  return 0
}

export function selectInstaller(
  data: unknown,
  kind: UpdateSource['kind'],
  platform: string,
  arch: string,
  channel: string,
): InstallerRelease | null {
  const extension =
    platform === 'darwin'
      ? '.dmg'
      : platform === 'win32'
        ? '.exe'
        : platform === 'linux'
          ? '.AppImage'
          : null
  if (!extension) throw new Error('This platform has no installer')
  const list = kind === 'github' ? (Array.isArray(data) ? data : [data]) : [data]
  const releases: InstallerRelease[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const release = item as Record<string, unknown>
    if (release.draft || (release.prerelease && channel !== 'beta')) continue
    const version = String(kind === 'github' ? release.tag_name : release.version).replace(/^v/, '')
    try {
      versionParts(version)
    } catch {
      continue
    }
    if (channel !== 'beta' && version.includes('-')) continue
    if (!Array.isArray(release.assets)) continue
    for (const raw of release.assets) {
      if (!raw || typeof raw !== 'object') continue
      const asset = raw as Record<string, unknown>
      if (kind === 'github') {
        const name = String(asset.name)
        // Fork CI filenames carry both platform and architecture. Universal Mac builds also work.
        const platformName =
          platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux'
        if (
          !name.endsWith(extension) ||
          !name.includes(`-${platformName}-`) ||
          (!name.includes(`-${arch}-`) && !(platform === 'darwin' && name.includes('-universal-')))
        )
          continue
      } else if (asset.platform !== platform || asset.arch !== arch) continue
      const sha256 = String(kind === 'github' ? asset.digest : asset.sha256).replace(/^sha256:/, '')
      if (!/^[a-f0-9]{64}$/i.test(sha256)) continue
      const url = secureUpdateUrl(kind === 'github' ? asset.browser_download_url : asset.url)
      if (!new URL(url).pathname.endsWith(extension)) continue
      releases.push({ version, url, sha256: sha256.toLowerCase(), extension })
    }
  }
  return releases.sort((a, b) => compareVersions(b.version, a.version))[0] ?? null
}
