import { showAppMessageBox, showUpdateStatusMessageBox } from './app-message-box'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app, net, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { getUiLang } from '@genoffice/i18n'
import {
  compareVersions,
  createUpdateCoordinator,
  selectInstaller,
  UpdateSourceError,
  validateOriginalInstallerUrl,
  validateResolvedInstallerUrl,
  validateResolvedMetadataUrl,
  type UpdateSource,
} from '../shared/update-source'
import type { UpdateChannel } from '../shared/update-api'
import type { UpdateCheckResult } from '../shared/home-api'
import { initialState } from './updater'
import { closeUpdateWindow, pushUpdateState, showUpdateWindow } from './update-window'
import { startUpdateProgress } from './fork/update-progress'

const MAX_INSTALLER = 2 * 1024 * 1024 * 1024
const INSTALL_LABEL: Record<string, string> = {
  vi: 'Mở bộ cài cập nhật',
  en: 'Open update installer',
  zh: '打开更新安装程序',
  'zh-TW': '開啟更新安裝程式',
  ja: '更新インストーラーを開く',
  ko: '업데이트 설치 프로그램 열기',
  fr: 'Ouvrir le programme d’installation',
  de: 'Update-Installer öffnen',
  es: 'Abrir instalador',
  th: 'เปิดตัวติดตั้ง',
  id: 'Buka penginstal',
  ru: 'Открыть установщик',
  ar: 'فتح برنامج التثبيت',
  pt: 'Abrir instalador',
  it: 'Apri programma di installazione',
  pl: 'Otwórz instalator',
  cs: 'Otevřít instalátor',
  nl: 'Installatieprogramma openen',
  ms: 'Buka pemasang',
  he: 'פתיחת תוכנית ההתקנה',
  hi: 'अपडेट इंस्टॉलर खोलें',
}
const RESTART_LABEL: Record<string, string> = {
  vi: 'Khởi động lại để cập nhật',
  en: 'Restart to update',
}
export const forkUpdateCoordinator = createUpdateCoordinator()
let downloading = false
let installer: string | null = null
let activeSource = ''
/** the version the "update ready" card was last shown for: the background check shows it once */
let promptedVersion = ''

export interface RestartInstallDeps {
  platform?: NodeJS.Platform
  spawnInstaller?: typeof spawn
  quit?: () => void
  /** shows the "Updating…" card from a separate process; false when it could not */
  showProgress?: (installerPid: number) => boolean
}

/**
 * Windows: run the downloaded, checksum-verified installer silently and let it start the new
 * version when it is done, so an update is just a restart (no wizard, no folder to choose: the
 * installer keeps the place and mode of the current install). The app quits once the installer
 * is running. False when that could not be done; the caller then falls back to opening it.
 */
export function installAndRestart(
  installerPath: string,
  deps: RestartInstallDeps = {},
): Promise<boolean> {
  if ((deps.platform ?? process.platform) !== 'win32') return Promise.resolve(false)
  const run = deps.spawnInstaller ?? spawn
  const quit = deps.quit ?? ((): void => app.quit())
  return new Promise((resolve) => {
    try {
      const child = run(installerPath, ['/S', '--updated', '--force-run'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.once('error', () => resolve(false))
      child.once('spawn', () => {
        child.unref()
        // the installer runs with no window: say that the update is under way
        if (typeof child.pid === 'number') {
          try {
            ;(
              deps.showProgress ??
              ((pid: number) =>
                startUpdateProgress({
                  installerPid: pid,
                  exePath: process.execPath,
                  lang: getUiLang(),
                }))
            )(child.pid)
          } catch {
            // the update itself must not depend on its progress card
          }
        }
        resolve(true)
        // the installer replaces files the running app holds open: let go of them
        quit()
      })
    } catch {
      resolve(false)
    }
  })
}

export interface DownloadInstallerRelease {
  url: string
  version: string
  extension: string
  sha256: string
}

export interface ElectronClientRequestMock {
  on(event: string, listener: (...args: any[]) => void): void
  followRedirect(): void
  abort(): void
  end(): void
}

export interface DownloadInstallerDeps {
  netRequest?: (options: {
    method?: string
    url: string
    redirect?: 'follow' | 'error' | 'manual'
  }) => ElectronClientRequestMock
  netFetch?: typeof net.fetch
  userDataPath?: string
  timeoutMs?: number
  onProgress?: (percent: number) => void
}

/**
 * Orchestrates explicit manual-redirect download of the native installer:
 * - Constructs net.request with redirect: 'manual'
 * - Validates each redirect hop synchronously before calling followRedirect()
 * - Aborts the request immediately on untrusted destinations
 * - Keeps download timeout active throughout response data streaming
 * - Destroys active streams and cleans up temporary files on failure
 * - Validates SHA-256 and bounds maximum installer size
 */
export async function downloadInstaller(
  release: DownloadInstallerRelease,
  source: UpdateSource,
  deps: DownloadInstallerDeps = {},
): Promise<string> {
  // 1. Validate original URL before issuing any network hop
  validateOriginalInstallerUrl(release.url, source)

  const timeoutMs = deps.timeoutMs ?? 15 * 60_000
  const root = join(deps.userDataPath ?? app.getPath('userData'), 'updates')
  await mkdir(root, { recursive: true })
  const folder = await mkdtemp(join(root, 'download-'))
  const target = join(folder, `GenOffice-${release.version}${release.extension}`)

  let activeStream: { destroy?: (err?: Error) => void } | null = null
  let activeFileStream: {
    destroy: (err?: Error) => void
    closed: boolean
    once: (event: string, cb: () => void) => void
  } | null = null

  try {
    const hash = createHash('sha256')
    let bytes = 0
    const createMeter = (length: number) =>
      new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length
          if (bytes > MAX_INSTALLER) return callback(new Error('Installer is too large'))
          hash.update(chunk)
          if (deps.onProgress) {
            deps.onProgress(length > 0 ? Math.min(99, Math.floor((bytes / length) * 100)) : 0)
          }
          callback(null, chunk)
        },
      })

    const electronNet = net as unknown as {
      request?: (options: {
        method?: string
        url: string
        redirect?: 'follow' | 'error' | 'manual'
      }) => ElectronClientRequestMock
    }

    const electronRequest = deps.netRequest ?? electronNet?.request

    if (typeof electronRequest === 'function') {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        let timer: NodeJS.Timeout | null = null
        let req: ElectronClientRequestMock | null = null
        let currentUrl = release.url

        const cleanupAndSettle = (err?: Error | unknown) => {
          if (settled) return
          settled = true
          if (timer) {
            clearTimeout(timer)
            timer = null
          }
          if (err) {
            if (activeStream && typeof activeStream.destroy === 'function') {
              try {
                activeStream.destroy(err instanceof Error ? err : new Error(String(err)))
              } catch {
                // ignore stream destruction error
              }
            }
            if (activeFileStream && typeof activeFileStream.destroy === 'function') {
              try {
                activeFileStream.destroy(err instanceof Error ? err : new Error(String(err)))
              } catch {
                // ignore file stream destruction error
              }
            }
            if (req && typeof req.abort === 'function') {
              try {
                req.abort()
              } catch {
                // ignore request abort error
              }
            }
            reject(err)
          } else {
            resolve()
          }
        }

        timer = setTimeout(() => {
          cleanupAndSettle(new Error('Download timeout'))
        }, timeoutMs)

        try {
          req = electronRequest({
            method: 'GET',
            url: release.url,
            redirect: 'manual',
          })
        } catch (createErr) {
          cleanupAndSettle(createErr)
          return
        }

        req.on('redirect', (_statusCode: number, _method: string, redirectUrl: string) => {
          if (settled) return
          try {
            validateResolvedInstallerUrl(release.url, redirectUrl, source)
            currentUrl = redirectUrl
            req.followRedirect()
          } catch (err) {
            cleanupAndSettle(err)
          }
        })

        req.on('response', (res: any) => {
          if (settled) return
          activeStream = res

          res.on('aborted', () => {
            cleanupAndSettle(new Error('Download aborted'))
          })

          if (res.statusCode < 200 || res.statusCode >= 300) {
            return cleanupAndSettle(new Error(`HTTP ${res.statusCode}`))
          }

          try {
            validateResolvedInstallerUrl(release.url, currentUrl, source)
          } catch (err) {
            return cleanupAndSettle(err)
          }

          const length = Number(res.headers?.['content-length'] || 0)
          if (length > MAX_INSTALLER) {
            return cleanupAndSettle(new Error('Installer is too large'))
          }

          const meter = createMeter(length)
          const fileStream = createWriteStream(target, { flags: 'wx' })
          activeFileStream = fileStream as any

          pipeline(res, meter, fileStream)
            .then(() => {
              if (hash.digest('hex') !== release.sha256.toLowerCase()) {
                throw new Error('Installer checksum mismatch')
              }
              cleanupAndSettle()
            })
            .catch((err) => {
              cleanupAndSettle(err)
            })
        })

        req.on('error', (err: unknown) => {
          cleanupAndSettle(err)
        })

        req.end()
      })
    } else {
      // Fallback for environments where net.request is not available (e.g. test runner)
      const fetchFn = deps.netFetch ?? net.fetch
      const res = await fetchFn(release.url, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      if (res.url) {
        validateResolvedInstallerUrl(release.url, res.url, source)
      }
      const length = Number(res.headers.get('content-length'))
      if (length > MAX_INSTALLER) throw new Error('Installer is too large')
      const meter = createMeter(length)
      const fileStream = createWriteStream(target, { flags: 'wx' })
      activeFileStream = fileStream as any
      await pipeline(Readable.fromWeb(res.body as never), meter, fileStream)
      if (hash.digest('hex') !== release.sha256.toLowerCase()) {
        throw new Error('Installer checksum mismatch')
      }
    }

    return target
  } catch (err) {
    if (activeFileStream && !activeFileStream.closed) {
      await new Promise<void>((r) => {
        activeFileStream!.once('close', () => r())
        activeFileStream!.destroy()
      })
    }
    await rm(folder, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

/** An explicit, checksum-verified installer flow for unsigned fork builds. It uses
 * the OS installer so macOS retains its normal trust checks and save prompts. */
export async function checkForkUpdates(
  source: UpdateSource,
  channel: UpdateChannel,
  getWindow: () => BrowserWindow | null,
  options: { background?: boolean } = {},
): Promise<UpdateCheckResult | void> {
  const background = options.background === true
  if (downloading) return
  return await forkUpdateCoordinator.run(async () => {
    const vietnamese = getUiLang() === 'vi'
    const title = vietnamese ? 'Cập nhật GenOffice' : 'GenOffice update'
    try {
      const endpoint =
        source.kind === 'github'
          ? `https://api.github.com/repos/${source.value}/releases?per_page=30`
          : source.value
      let response: Response
      try {
        response = await net.fetch(endpoint, {
          headers: { Accept: 'application/json', 'User-Agent': 'GenOffice-update' },
          signal: AbortSignal.timeout(30_000),
        })
      } catch (fetchErr: unknown) {
        const err = fetchErr as Error
        if (err?.name === 'TimeoutError' || String(err).toLowerCase().includes('timeout')) {
          throw new UpdateSourceError('TIMEOUT', 'Connection timed out')
        }
        throw new UpdateSourceError('NETWORK_ERROR', 'Network connection failed')
      }
      if (!response.ok) {
        if (response.status === 404) {
          throw new UpdateSourceError('GITHUB_NOT_FOUND', 'Repository not found on GitHub')
        }
        if (response.status === 403) {
          const remaining = response.headers.get('x-ratelimit-remaining')
          const retryAfter = response.headers.get('retry-after')
          if (remaining === '0' || retryAfter !== null) {
            throw new UpdateSourceError('GITHUB_RATE_LIMITED', 'GitHub API rate limit reached')
          }
          throw new UpdateSourceError('ACCESS_DENIED', 'Access denied to repository')
        }
        if (response.status === 401) {
          throw new UpdateSourceError('ACCESS_DENIED', 'Access denied to repository')
        }
        throw new UpdateSourceError('NETWORK_ERROR', `HTTP ${response.status}`)
      }
      if (response.url) {
        validateResolvedMetadataUrl(endpoint, response.url, source)
      }
      if (!response.body || Number(response.headers.get('content-length')) > 2_000_000)
        throw new UpdateSourceError(
          'INVALID_RELEASE_METADATA',
          'Update metadata is too large or empty',
        )
      const chunks: Buffer[] = []
      let metadataBytes = 0
      for await (const chunk of Readable.fromWeb(response.body as never)) {
        metadataBytes += chunk.length
        if (metadataBytes > 2_000_000)
          throw new UpdateSourceError('INVALID_RELEASE_METADATA', 'Update metadata is too large')
        chunks.push(Buffer.from(chunk))
      }
      const body = Buffer.concat(chunks).toString('utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        throw new UpdateSourceError('INVALID_RELEASE_METADATA', 'Invalid JSON metadata')
      }
      const release = selectInstaller(parsed, source.kind, process.platform, process.arch, channel)
      if (!release) {
        if (background) return
        await showAppMessageBox({
          type: 'info',
          title,
          message: vietnamese
            ? 'Nguồn này hợp lệ nhưng chưa có bộ cài phù hợp cho thiết bị này. Hãy thử lại sau khi bản build hoàn tất.'
            : 'The repository is valid, but no compatible installer is available for this device.',
        })
        return
      }
      if (compareVersions(release.version, app.getVersion()) <= 0) {
        if (background) return { upToDate: true }
        await showUpdateStatusMessageBox({
          type: 'info',
          title,
          message: vietnamese
            ? `Bạn đang dùng bản mới nhất (${app.getVersion()}).`
            : `You are up to date (${app.getVersion()}).`,
        })
        return { upToDate: true }
      }
      const identity = `${source.kind}:${source.value}:${release.version}:${release.sha256}`
      if (identity !== activeSource) installer = null
      activeSource = identity
      const state = initialState(release.version)
      state.phase = installer ? 'downloaded' : 'available'
      state.strings.install = INSTALL_LABEL[getUiLang()] ?? INSTALL_LABEL.en
      // Downloading an unsigned build does not promise a silent restart/install, except on Windows,
      // where the verified installer is run silently by a restart.
      state.strings.desc = vietnamese
        ? 'Tải bản mới từ nguồn bạn đã chọn. Khi tải xong, mở bộ cài để cập nhật ứng dụng.'
        : 'Download from your selected source, then open the installer to update the app.'
      if (process.platform === 'win32') {
        state.strings.install = RESTART_LABEL[getUiLang()] ?? RESTART_LABEL.en
        state.strings.desc = vietnamese
          ? 'Bản mới đã được tải về nền. Khởi động lại GenOffice là cập nhật xong, không cần cài lại.'
          : 'The update is downloaded in the background. Restart GenOffice to finish; nothing to reinstall.'
      }
      const download = async (): Promise<void> => {
        if (downloading) return
        downloading = true
        installer = null
        pushUpdateState({ phase: 'downloading', percent: 0 })
        try {
          installer = await downloadInstaller(release, source, {
            onProgress: (percent) => pushUpdateState({ percent }),
          })
          pushUpdateState({ phase: 'downloaded', percent: 100 })
        } catch {
          installer = null
          pushUpdateState({ phase: 'error' })
        } finally {
          downloading = false
        }
      }
      const actions = {
        onDownload: () => {
          void download()
        },
        onLater: () => closeUpdateWindow(),
        onInstall: () => {
          const ready = installer
          if (!ready) return
          void installAndRestart(ready).then((restarting) => {
            if (restarting) return
            void shell
              .openPath(ready)
              .then((error) => {
                if (error) pushUpdateState({ phase: 'error' })
                else closeUpdateWindow()
              })
              .catch(() => pushUpdateState({ phase: 'error' }))
          })
        },
        onOpenDownload: () => {
          void shell.openExternal(release.url)
        },
      }
      if (background) {
        // quiet: nothing is shown until the update is downloaded and verified, and then once per
        // version. Only Windows can apply it by a restart; elsewhere the person asks for it.
        if (process.platform !== 'win32' || promptedVersion === release.version) return
        if (!installer) await download()
        if (!installer) return
        promptedVersion = release.version
        state.phase = 'downloaded'
      }
      showUpdateWindow(getWindow(), state, actions)
      return { upToDate: false }
    } catch (err: unknown) {
      if (background) return
      const error = err as UpdateSourceError
      const code = error?.code
      let message: string
      if (code === 'GITHUB_NOT_FOUND') {
        message = vietnamese
          ? 'Không tìm thấy kho mã nguồn trên GitHub. Kiểm tra lại tên owner/repository.'
          : 'Repository not found on GitHub. Check the owner/repository name.'
      } else if (code === 'GITHUB_RATE_LIMITED') {
        message = vietnamese
          ? 'Đã đạt giới hạn yêu cầu của GitHub API. Vui lòng thử lại sau.'
          : 'GitHub API rate limit reached. Please try again later.'
      } else if (code === 'ACCESS_DENIED') {
        message = vietnamese
          ? 'Không có quyền truy cập vào kho mã nguồn này.'
          : 'Access denied to repository.'
      } else if (code === 'TIMEOUT' || code === 'NETWORK_ERROR') {
        message = vietnamese
          ? 'Không thể kết nối đến GitHub. Nguồn cập nhật đã lưu không bị thay đổi.'
          : 'Unable to contact GitHub. Your saved update source has not changed.'
      } else if (code === 'INVALID_RELEASE_METADATA') {
        message = vietnamese
          ? 'Dữ liệu phiên bản phát hành từ nguồn cập nhật không hợp lệ.'
          : 'Invalid release metadata from update source.'
      } else {
        message = vietnamese
          ? 'Không kiểm tra được cập nhật. Kiểm tra mạng và nguồn cập nhật rồi thử lại.'
          : 'Could not check for updates. Check your connection and update source, then try again.'
      }
      await showAppMessageBox({
        type: 'warning',
        title,
        message,
      })
      return
    }
  })
}
