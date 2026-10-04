import { showAppMessageBox } from './app-message-box'
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
  secureUpdateUrl,
  selectInstaller,
  type UpdateSource,
} from '../shared/update-source'
import type { UpdateChannel } from '../shared/update-api'
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
let checking = false
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
/** An explicit, checksum-verified installer flow for unsigned fork builds. It uses
 * the OS installer so macOS retains its normal trust checks and save prompts. */
export async function checkForkUpdates(
  source: UpdateSource,
  channel: UpdateChannel,
  getWindow: () => BrowserWindow | null,
  options: { background?: boolean } = {},
): Promise<void> {
  const background = options.background === true
  if (checking || downloading) return
  checking = true
  const vietnamese = getUiLang() === 'vi'
  const title = vietnamese ? 'Cập nhật GenOffice' : 'GenOffice update'
  try {
    const endpoint =
      source.kind === 'github'
        ? `https://api.github.com/repos/${source.value}/releases?per_page=30`
        : source.value
    const response = await net.fetch(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': 'GenOffice-update' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (response.url) secureUpdateUrl(response.url)
    if (!response.body || Number(response.headers.get('content-length')) > 2_000_000)
      throw new Error('Update metadata is too large or empty')
    const chunks: Buffer[] = []
    let metadataBytes = 0
    for await (const chunk of Readable.fromWeb(response.body as never)) {
      metadataBytes += chunk.length
      if (metadataBytes > 2_000_000) throw new Error('Update metadata is too large')
      chunks.push(Buffer.from(chunk))
    }
    const body = Buffer.concat(chunks).toString('utf8')
    const release = selectInstaller(
      JSON.parse(body),
      source.kind,
      process.platform,
      process.arch,
      channel,
    )
    if (!release) {
      if (background) return
      await showAppMessageBox({
        type: 'info',
        title,
        message: vietnamese
          ? 'Nguồn này chưa có bộ cài phù hợp cho máy của bạn. Hãy thử lại sau khi GitHub build xong.'
          : 'This source has no compatible installer yet. Try again once the GitHub build finishes.',
      })
      return
    }
    if (compareVersions(release.version, app.getVersion()) <= 0) {
      if (background) return
      await showAppMessageBox({
        type: 'info',
        title,
        message: vietnamese
          ? `Bạn đang dùng bản mới nhất (${app.getVersion()}).`
          : `You are up to date (${app.getVersion()}).`,
      })
      return
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
      let folder: string | undefined
      try {
        const root = join(app.getPath('userData'), 'updates')
        await mkdir(root, { recursive: true })
        folder = await mkdtemp(join(root, 'download-'))
        const target = join(folder, `GenOffice-${release.version}${release.extension}`)
        const res = await net.fetch(release.url, { signal: AbortSignal.timeout(15 * 60_000) })
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        if (res.url) secureUpdateUrl(res.url)
        const length = Number(res.headers.get('content-length'))
        if (length > MAX_INSTALLER) throw new Error('Installer is too large')
        const hash = createHash('sha256')
        let bytes = 0
        const meter = new Transform({
          transform(chunk, _encoding, callback) {
            bytes += chunk.length
            if (bytes > MAX_INSTALLER) return callback(new Error('Installer is too large'))
            hash.update(chunk)
            pushUpdateState({
              percent: length > 0 ? Math.min(99, Math.floor((bytes / length) * 100)) : 0,
            })
            callback(null, chunk)
          },
        })
        await pipeline(
          Readable.fromWeb(res.body as never),
          meter,
          createWriteStream(target, { flags: 'wx' }),
        )
        if (hash.digest('hex') !== release.sha256) throw new Error('Installer checksum mismatch')
        installer = target
        pushUpdateState({ phase: 'downloaded', percent: 100 })
      } catch {
        if (folder) await rm(folder, { recursive: true, force: true }).catch(() => {})
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
  } catch {
    if (background) return
    await showAppMessageBox({
      type: 'warning',
      title,
      message: vietnamese
        ? 'Không kiểm tra được cập nhật. Kiểm tra mạng và nguồn cập nhật rồi thử lại.'
        : 'Could not check for updates. Check your connection and update source, then try again.',
    })
  } finally {
    checking = false
  }
}
