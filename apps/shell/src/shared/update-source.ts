export interface UpdateSource {
  kind: 'github' | 'manifest'
  value: string
}
export const DEFAULT_UPDATE_SOURCE: UpdateSource = { kind: 'github', value: 'HThanh-how/genoffice' }

export type UpdateSourceErrorCode =
  | 'INVALID_FORMAT'
  | 'SETTINGS_WRITE_FAILED'
  | 'IPC_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'GITHUB_NOT_FOUND'
  | 'GITHUB_RATE_LIMITED'
  | 'ACCESS_DENIED'
  | 'INVALID_RELEASE_METADATA'
  | 'NO_COMPATIBLE_INSTALLER'

export class UpdateSourceError extends Error {
  code: UpdateSourceErrorCode
  constructor(code: UpdateSourceErrorCode, message: string) {
    super(`[${code}] ${message}`)
    this.name = 'UpdateSourceError'
    this.code = code
  }
}

export type UpdateCheckResult = { upToDate: boolean }

export function validateConfiguredUpdateUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new UpdateSourceError('INVALID_FORMAT', 'Invalid update URL')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new UpdateSourceError('INVALID_FORMAT', 'Invalid update URL format')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw new UpdateSourceError(
      'INVALID_FORMAT',
      'Update URLs must use HTTPS without credentials, query parameters, or fragments',
    )
  }
  return url.href
}

export const secureUpdateUrl = validateConfiguredUpdateUrl

export function isOfficialGithubHost(hostname: string): boolean {
  if (!hostname || typeof hostname !== 'string') return false
  const lower = hostname.toLowerCase()
  if (lower === 'github.com' || lower.endsWith('.github.com')) return true
  if (lower === 'githubusercontent.com' || lower.endsWith('.githubusercontent.com')) return true
  if (
    /^github-production-release-asset-[a-z0-9]+\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com$/i.test(lower)
  ) {
    return true
  }
  return false
}

export function validateResolvedInstallerUrl(
  originalUrl: string,
  finalUrl: string,
  source: UpdateSource,
): string {
  if (typeof finalUrl !== 'string' || finalUrl.length > 4096) {
    throw new UpdateSourceError('INVALID_FORMAT', 'Invalid resolved installer URL')
  }
  let parsedFinal: URL
  try {
    parsedFinal = new URL(finalUrl)
  } catch {
    throw new UpdateSourceError('INVALID_FORMAT', 'Invalid resolved installer URL format')
  }
  if (parsedFinal.protocol !== 'https:') {
    throw new UpdateSourceError(
      'INVALID_FORMAT',
      'Installer download redirect cannot downgrade to insecure HTTP',
    )
  }
  if (parsedFinal.username || parsedFinal.password) {
    throw new UpdateSourceError(
      'INVALID_FORMAT',
      'Credentials in installer download URL are forbidden',
    )
  }
  if (parsedFinal.hash) {
    throw new UpdateSourceError(
      'INVALID_FORMAT',
      'Fragments in installer download URL are forbidden',
    )
  }

  let parsedOriginal: URL
  try {
    parsedOriginal = new URL(originalUrl)
  } catch {
    throw new UpdateSourceError('INVALID_FORMAT', 'Invalid original installer URL format')
  }
  if (parsedOriginal.protocol !== 'https:') {
    throw new UpdateSourceError('INVALID_FORMAT', 'Original installer URL must use HTTPS')
  }
  if (parsedOriginal.username || parsedOriginal.password) {
    throw new UpdateSourceError(
      'INVALID_FORMAT',
      'Original installer URL cannot contain credentials',
    )
  }

  if (source.kind === 'github') {
    if (!isOfficialGithubHost(parsedOriginal.hostname)) {
      throw new UpdateSourceError(
        'ACCESS_DENIED',
        `Original release asset host is not an official GitHub host: ${parsedOriginal.hostname}`,
      )
    }
    if (!isOfficialGithubHost(parsedFinal.hostname)) {
      throw new UpdateSourceError(
        'ACCESS_DENIED',
        `Disallowed GitHub asset redirect destination: ${parsedFinal.hostname}`,
      )
    }
  }

  return parsedFinal.href
}

export function validateResolvedMetadataUrl(
  originalUrl: string,
  finalUrl: string,
  source: UpdateSource,
): string {
  if (typeof finalUrl !== 'string' || finalUrl.length > 2048) {
    throw new UpdateSourceError('INVALID_FORMAT', 'Invalid resolved metadata URL')
  }
  let parsedFinal: URL
  try {
    parsedFinal = new URL(finalUrl)
  } catch {
    throw new UpdateSourceError('INVALID_FORMAT', 'Invalid resolved metadata URL format')
  }
  if (parsedFinal.protocol !== 'https:') {
    throw new UpdateSourceError(
      'INVALID_FORMAT',
      'Update metadata URL cannot downgrade to insecure HTTP',
    )
  }
  if (parsedFinal.username || parsedFinal.password) {
    throw new UpdateSourceError('INVALID_FORMAT', 'Credentials in metadata URL are forbidden')
  }
  if (parsedFinal.hash) {
    throw new UpdateSourceError('INVALID_FORMAT', 'Fragments in metadata URL are forbidden')
  }

  if (source.kind === 'github') {
    if (!isOfficialGithubHost(parsedFinal.hostname)) {
      throw new UpdateSourceError(
        'ACCESS_DENIED',
        `Disallowed metadata redirect destination: ${parsedFinal.hostname}`,
      )
    }
  }
  return parsedFinal.href
}

export function resolveUpdateNotice(
  result: UpdateCheckResult | void,
  error: unknown,
  lang: string,
): string | null {
  if (error) {
    const errCode = (error as { code?: string })?.code || (error as Error)?.message || String(error)
    return getUpdateErrorMessage(errCode, lang)
  }
  if (result?.upToDate === true) {
    return lang === 'vi'
      ? 'Bạn đang dùng phiên bản phát hành Stable mới nhất.'
      : 'You are using the latest published Stable version.'
  }
  return null
}

export interface UpdateCoordinator {
  run<T>(task: () => Promise<T>): Promise<T | undefined>
  isBusy(): boolean
}

export function createUpdateCoordinator(): UpdateCoordinator {
  let busy = false
  return {
    async run<T>(task: () => Promise<T>): Promise<T | undefined> {
      if (busy) return undefined
      busy = true
      try {
        return await task()
      } finally {
        busy = false
      }
    },
    isBusy() {
      return busy
    },
  }
}

export function validateUpdateSource(input: unknown): UpdateSource {
  if (!input || typeof input !== 'object') {
    throw new UpdateSourceError('INVALID_FORMAT', 'Invalid update source')
  }
  const { kind, value } = input as UpdateSource
  if (typeof value !== 'string') {
    throw new UpdateSourceError('INVALID_FORMAT', 'Invalid update source')
  }
  if (kind === 'github') {
    let repo = value.trim()
    repo = repo
      .replace(/^(?:git\+)?https?:\/\/(?:www\.)?github\.com\//i, '')
      .replace(/^(?:www\.)?github\.com\//i, '')
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '')
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo) ||
      repo.length > 200
    ) {
      throw new UpdateSourceError('INVALID_FORMAT', 'Enter a GitHub owner/repository')
    }
    return { kind, value: repo }
  }
  if (kind === 'manifest') return { kind, value: secureUpdateUrl(value.trim()) }
  throw new UpdateSourceError('INVALID_FORMAT', 'Invalid update source')
}

export function applyUpdateSourceChange(
  input: unknown,
  current: UpdateSource,
  persist: (source: UpdateSource) => void,
): UpdateSource {
  const source = validateUpdateSource(input)
  if (current.kind === source.kind && current.value === source.value) {
    return source
  }
  try {
    persist(source)
    return source
  } catch (err) {
    throw new UpdateSourceError(
      'SETTINGS_WRITE_FAILED',
      `Unable to save update settings: ${(err as Error)?.message ?? 'write failed'}`,
    )
  }
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

export function getUpdateErrorMessage(code: string, lang: string): string {
  const isVi = lang === 'vi'
  const c = code.toUpperCase()
  if (
    c.includes('INVALID_FORMAT') ||
    c.includes('OWNER/REPOSITORY') ||
    c.includes('INVALID UPDATE SOURCE') ||
    c.includes('HTTPS WITHOUT CREDENTIALS')
  ) {
    return isVi
      ? 'Định dạng kho mã nguồn không hợp lệ. Hãy dùng owner/repository.'
      : 'Invalid repository format. Use owner/repository.'
  }
  if (
    c.includes('SETTINGS_WRITE_FAILED') ||
    c.includes('STORAGE') ||
    c.includes('EACCES') ||
    c.includes('EPERM')
  ) {
    return isVi
      ? 'Không thể lưu cài đặt cập nhật. Kiểm tra quyền ghi bộ nhớ của ứng dụng.'
      : 'Unable to save update settings. Check application storage permissions.'
  }
  if (c.includes('GITHUB_NOT_FOUND') || c.includes('404') || c.includes('NOT FOUND')) {
    return isVi
      ? 'Không tìm thấy kho mã nguồn trên GitHub. Kiểm tra lại tên owner/repository.'
      : 'Repository not found on GitHub. Check the owner/repository name.'
  }
  if (c.includes('GITHUB_RATE_LIMITED') || c.includes('403') || c.includes('RATE LIMIT')) {
    return isVi
      ? 'Đã đạt giới hạn yêu cầu của GitHub API. Vui lòng thử lại sau.'
      : 'GitHub API rate limit reached. Please try again later.'
  }
  if (c.includes('ACCESS_DENIED') || c.includes('FORBIDDEN') || c.includes('UNAUTHORIZED')) {
    return isVi ? 'Không có quyền truy cập vào kho mã nguồn này.' : 'Access denied to repository.'
  }
  if (
    c.includes('TIMEOUT') ||
    c.includes('NETWORK_ERROR') ||
    c.includes('FETCH FAILED') ||
    c.includes('ENOTFOUND') ||
    c.includes('ECONNREFUSED') ||
    c.includes('ECONNRESET') ||
    c.includes('ETIMEDOUT')
  ) {
    return isVi
      ? 'Không thể kết nối đến GitHub. Nguồn cập nhật đã lưu không bị thay đổi.'
      : 'Unable to contact GitHub. Your saved update source has not changed.'
  }
  if (c.includes('NO_COMPATIBLE_INSTALLER') || c.includes('COMPATIBLE INSTALLER')) {
    return isVi
      ? 'Kho mã nguồn hợp lệ nhưng chưa có bộ cài phù hợp cho thiết bị này.'
      : 'The repository is valid, but no compatible installer is available for this device.'
  }
  if (c.includes('INVALID_RELEASE_METADATA') || c.includes('RELEASE METADATA')) {
    return isVi
      ? 'Dữ liệu phiên bản phát hành từ nguồn cập nhật không hợp lệ.'
      : 'Invalid release metadata from update source.'
  }
  return isVi
    ? 'Không thể hoàn thành thao tác cập nhật. Vui lòng thử lại.'
    : 'Unable to complete update operation. Please try again.'
}
