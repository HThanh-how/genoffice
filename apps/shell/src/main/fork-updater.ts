import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app, dialog, net, shell } from 'electron'
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
let checking = false
let downloading = false
let installer: string | null = null
let activeSource = ''

/** An explicit, checksum-verified installer flow for unsigned fork builds. It uses
 * the OS installer so macOS retains its normal trust checks and save prompts. */
export async function checkForkUpdates(
  source: UpdateSource,
  channel: UpdateChannel,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
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
      await dialog.showMessageBox({
        type: 'info',
        title,
        message: vietnamese
          ? 'Nguồn này chưa có bộ cài phù hợp cho máy của bạn. Hãy thử lại sau khi GitHub build xong.'
          : 'This source has no compatible installer yet. Try again once the GitHub build finishes.',
      })
      return
    }
    if (compareVersions(release.version, app.getVersion()) <= 0) {
      await dialog.showMessageBox({
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
    // Downloading an unsigned build does not promise a silent restart/install.
    state.strings.desc = vietnamese
      ? 'Tải bản mới từ nguồn bạn đã chọn. Khi tải xong, mở bộ cài để cập nhật ứng dụng.'
      : 'Download from your selected source, then open the installer to update the app.'
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
    showUpdateWindow(getWindow(), state, {
      onDownload: () => {
        void download()
      },
      onLater: () => closeUpdateWindow(),
      onInstall: () => {
        if (!installer) return
        void shell
          .openPath(installer)
          .then((error) => {
            if (error) pushUpdateState({ phase: 'error' })
            else closeUpdateWindow()
          })
          .catch(() => pushUpdateState({ phase: 'error' }))
      },
      onOpenDownload: () => {
        void shell.openExternal(release.url)
      },
    })
  } catch {
    await dialog.showMessageBox({
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
