import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  IndexedFolder,
  IndexedFolderRun,
  KnownSearchSource,
  KnownSearchSourceEntry,
  KnownSearchSourceStatus,
} from '../../../shared/fork/document-index-api'
import type { HomeApi } from '../../../shared/home-api'
import { useI18n } from '../locale'
import { readIndexRequest } from './index-request'

export interface IndexedFoldersProps {
  api?: HomeApi
}

const EN = {
  title: 'Indexed folders',
  desc: 'When each folder was last read, what is waiting, and which folder goes first.',
  commonTitle: 'Common locations',
  commonDesc: 'Quickly enable indexing for standard folders on this computer.',
  locDocuments: 'Documents',
  locDocumentsDesc: 'Personal documents',
  locDownloads: 'Downloads',
  locDownloadsDesc: 'Watching for new downloads',
  locDesktop: 'Desktop',
  locDesktopDesc: 'Desktop files',
  empty: 'No folder has been scanned yet. Use "Choose folder and scan" above.',
  never: 'Never finished',
  last: 'Last scan {when}',
  refreshed: 'checked {when}',
  running: 'Scanning now',
  stopped: 'Stopped',
  offline: 'Folder not reachable',
  files: '{n} files',
  waiting: '{n} waiting',
  errors: '{n} problems',
  priority: 'Index first',
  priorityOn: 'Goes first',
  rescan: 'Scan again',
  forget: 'Remove',
  forgetTip: 'Stop watching this folder. Files already indexed stay searchable.',
  history: 'History',
  hideHistory: 'Hide history',
  kindScan: 'Full scan',
  kindRefresh: 'Quick check',
  runDetail: '{discovered} files · {enrolled} new · {errors} problems',
  runStopped: 'stopped',
  runUnavailable: 'not reachable',
  noHistory: 'No history yet.',
  now: 'just now',
  statusWatching: 'Watching',
  statusScanning: 'Scanning',
  statusQueued: 'Queued',
  statusUnavailable: 'Unavailable',
  statusError: 'Error',
  statusDisabled: 'Disabled',
  sourceToggleFailed: 'Failed to update folder setting.',
}

type Dict = Record<keyof typeof EN, string>

const STRINGS: Record<'en' | 'vi' | 'zh', Dict> = {
  en: EN,
  vi: {
    title: 'Thư mục đã lập chỉ mục',
    desc: 'Mỗi thư mục được đọc lần cuối khi nào, còn gì đang chờ và thư mục nào được ưu tiên.',
    commonTitle: 'Vị trí phổ biến',
    commonDesc: 'Tự động quét và lập chỉ mục các thư mục người dùng tiêu chuẩn trên máy.',
    locDocuments: 'Tài liệu (Documents)',
    locDocumentsDesc: 'Tài liệu cá nhân',
    locDownloads: 'Tải về (Downloads)',
    locDownloadsDesc: 'Tự động theo dõi tệp tải về mới',
    locDesktop: 'Màn hình chính (Desktop)',
    locDesktopDesc: 'Màn hình chính',
    empty: 'Chưa quét thư mục nào. Hãy dùng "Chọn thư mục và quét" ở trên.',
    never: 'Chưa quét xong',
    last: 'Quét lần cuối {when}',
    refreshed: 'kiểm tra {when}',
    running: 'Đang quét',
    stopped: 'Đã dừng',
    offline: 'Không truy cập được thư mục',
    files: '{n} tệp',
    waiting: '{n} đang chờ',
    errors: '{n} lỗi',
    priority: 'Ưu tiên index trước',
    priorityOn: 'Đang ưu tiên',
    rescan: 'Quét lại',
    forget: 'Gỡ',
    forgetTip: 'Ngừng theo dõi thư mục này. Tệp đã index vẫn tìm được.',
    history: 'Lịch sử',
    hideHistory: 'Ẩn lịch sử',
    kindScan: 'Quét đầy đủ',
    kindRefresh: 'Kiểm tra nhanh',
    runDetail: '{discovered} tệp · {enrolled} mới · {errors} lỗi',
    runStopped: 'đã dừng',
    runUnavailable: 'không truy cập được',
    noHistory: 'Chưa có lịch sử.',
    now: 'vừa xong',
    statusWatching: 'Đang theo dõi',
    statusScanning: 'Đang quét',
    statusQueued: 'Đang chờ',
    statusUnavailable: 'Không khả dụng',
    statusError: 'Lỗi',
    statusDisabled: 'Đã tắt',
    sourceToggleFailed: 'Không thể cập nhật thiết lập thư mục.',
  },
  zh: {
    title: '已索引的文件夹',
    desc: '每个文件夹上次读取的时间、待处理的内容，以及哪个文件夹优先。',
    commonTitle: '常用位置',
    commonDesc: '快速启用此计算机上常用文件夹的自动索引。',
    locDocuments: '文档',
    locDocumentsDesc: '个人文档',
    locDownloads: '下载',
    locDownloadsDesc: '自动监视新下载的文件',
    locDesktop: '桌面',
    locDesktopDesc: '桌面文件',
    empty: '尚未扫描任何文件夹。请使用上方的“选择文件夹并扫描”。',
    never: '尚未完成',
    last: '上次扫描 {when}',
    refreshed: '检查于 {when}',
    running: '正在扫描',
    stopped: '已停止',
    offline: '无法访问该文件夹',
    files: '{n} 个文件',
    waiting: '{n} 个待处理',
    errors: '{n} 个问题',
    priority: '优先索引',
    priorityOn: '优先中',
    rescan: '重新扫描',
    forget: '移除',
    forgetTip: '不再监视此文件夹。已索引的文件仍可搜索。',
    history: '历史',
    hideHistory: '隐藏历史',
    kindScan: '完整扫描',
    kindRefresh: '快速检查',
    runDetail: '{discovered} 个文件 · {enrolled} 个新增 · {errors} 个问题',
    runStopped: '已停止',
    runUnavailable: '无法访问',
    noHistory: '暂无历史。',
    now: '刚刚',
    statusWatching: '正在监视',
    statusScanning: '正在扫描',
    statusQueued: '等待扫描',
    statusUnavailable: '无法访问',
    statusError: '错误',
    statusDisabled: '已禁用',
    sourceToggleFailed: '无法更新文件夹设置。',
  },
}

function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
}

function folderName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).at(-1) ?? root
}

function useWhen(lang: string, dict: Dict) {
  return useCallback(
    (at: number): string => {
      const diff = at - Date.now()
      const abs = Math.abs(diff)
      if (abs < 45_000) return dict.now
      const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
      const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
        ['day', 86_400_000],
        ['hour', 3_600_000],
        ['minute', 60_000],
      ]
      for (const [unit, ms] of units)
        if (abs >= ms || unit === 'minute') return rtf.format(Math.round(diff / ms), unit)
      return ''
    },
    [lang, dict],
  )
}

function RunRow({
  run,
  dict,
  when,
}: {
  run: IndexedFolderRun
  dict: Dict
  when: (at: number) => string
}) {
  const outcome =
    run.state === 'stopped'
      ? ` · ${dict.runStopped}`
      : run.state === 'unavailable'
        ? ` · ${dict.runUnavailable}`
        : ''
  return (
    <li className="set-folder-run">
      <span className="set-folder-run-when" title={new Date(run.endedAt).toLocaleString()}>
        {when(run.endedAt)}
      </span>
      <span className="set-folder-run-kind">
        {run.kind === 'scan' ? dict.kindScan : dict.kindRefresh}
      </span>
      <span className="set-field-desc">
        {fill(dict.runDetail, {
          discovered: run.discovered,
          enrolled: run.enrolled,
          errors: run.errors,
        })}
        {outcome}
      </span>
    </li>
  )
}

interface CommonLocationItem {
  id: KnownSearchSource
  name: string
  desc: string
  icon: 'documents' | 'downloads' | 'desktop'
}

function getStatusLabel(status: KnownSearchSourceStatus | undefined, d: Dict): string {
  switch (status) {
    case 'watching':
      return d.statusWatching
    case 'scanning':
      return d.statusScanning
    case 'queued':
      return d.statusQueued
    case 'unavailable':
      return d.statusUnavailable
    case 'error':
      return d.statusError
    case 'disabled':
    default:
      return d.statusDisabled
  }
}

export function IndexedFolders({ api }: IndexedFoldersProps = {}) {
  const effectiveApi =
    api ?? (typeof window !== 'undefined' ? (window as unknown as { aiOffice?: HomeApi }).aiOffice : undefined)

  const { lang } = useI18n()
  const dict: Dict = (STRINGS as Record<string, Dict | undefined>)[lang] ?? STRINGS.en
  const when = useWhen(lang, dict)
  const [folders, setFolders] = useState<IndexedFolder[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const mounted = useRef(false)
  const loading = useRef(false)

  // Canonical state for known search sources directly from backend
  const [knownSources, setKnownSources] = useState<KnownSearchSourceEntry[]>([])
  const [busySources, setBusySources] = useState<Record<string, boolean>>({})
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({})

  // Sync known sources from API (Single source of truth)
  const fetchKnown = useCallback(async () => {
    try {
      const getFn = (effectiveApi as Record<string, unknown> | undefined)?.getKnownSearchSources
      if (typeof getFn === 'function') {
        const res = await (getFn as () => Promise<unknown>).call(effectiveApi)
        if (Array.isArray(res)) {
          setKnownSources(res as KnownSearchSourceEntry[])
        }
      }
    } catch (err) {
      console.warn('api.getKnownSearchSources error:', err)
    }
  }, [effectiveApi])

  useEffect(() => {
    void fetchKnown()
  }, [fetchKnown])

  const toggleKnownSource = async (id: KnownSearchSource, enabled: boolean) => {
    if (busySources[id]) return

    setBusySources((prev) => ({ ...prev, [id]: true }))
    setSourceErrors((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })

    const previousSources = knownSources
    // Optimistic UI update
    setKnownSources((prev) => {
      const exists = prev.some((s) => s.id === id)
      if (exists) {
        return prev.map((s) => (s.id === id ? { ...s, enabled } : s))
      }
      return [...prev, { id, path: '', enabled, status: enabled ? 'queued' : 'disabled' }]
    })

    try {
      const setFn = (effectiveApi as Record<string, unknown> | undefined)?.setKnownSearchSource
      if (typeof setFn === 'function') {
        const res = await (setFn as (sourceId: string, isEnabled: boolean) => Promise<unknown>).call(
          effectiveApi,
          id,
          enabled,
        )
        if (res && typeof res === 'object' && 'id' in res) {
          const updated = res as KnownSearchSourceEntry
          setKnownSources((prev) => prev.map((s) => (s.id === id ? updated : s)))
        } else {
          await fetchKnown()
        }
      }
    } catch (err) {
      console.warn(`api.setKnownSearchSource(${id}, ${enabled}) failed:`, err)
      // Rollback optimistic update
      setKnownSources(previousSources)
      const errorMsg =
        err instanceof Error && err.message ? err.message : dict.sourceToggleFailed
      setSourceErrors((prev) => ({ ...prev, [id]: errorMsg }))
      await fetchKnown()
    } finally {
      setBusySources((prev) => ({ ...prev, [id]: false }))
    }
  }

  const commonLocations: CommonLocationItem[] = [
    {
      id: 'documents',
      name: dict.locDocuments,
      desc: dict.locDocumentsDesc,
      icon: 'documents',
    },
    {
      id: 'downloads',
      name: dict.locDownloads,
      desc: dict.locDownloadsDesc,
      icon: 'downloads',
    },
    {
      id: 'desktop',
      name: dict.locDesktop,
      desc: dict.locDesktopDesc,
      icon: 'desktop',
    },
  ]

  const refresh = useCallback(async () => {
    if (loading.current || document.visibilityState !== 'visible' || !effectiveApi?.listIndexedFolders) return
    loading.current = true
    try {
      const next = await readIndexRequest(
        () => effectiveApi.listIndexedFolders(),
        (value): value is IndexedFolder[] =>
          Array.isArray(value) &&
          value.every(
            (folder) =>
              typeof folder.root === 'string' &&
              Number.isFinite(folder.totalFiles) &&
              Array.isArray(folder.history),
          ),
      )
      if (mounted.current) {
        setFolders(next)
        setFailed(false)
      }
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      loading.current = false
    }
  }, [effectiveApi])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = setInterval(() => void refresh(), 5_000)
    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [refresh])

  const act = async (root: string, run: () => Promise<unknown>) => {
    setBusy(root)
    try {
      await readIndexRequest(run, (_value): _value is unknown => true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  const renderLocationIcon = (icon: 'documents' | 'downloads' | 'desktop') => {
    if (icon === 'documents') {
      return (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      )
    }
    if (icon === 'downloads') {
      return (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      )
    }
    return (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    )
  }

  if (folders === null && !failed)
    return (
      <p role="status">
        {lang === 'vi' ? 'Đang lấy tiến độ thư mục…' : 'Loading folder progress…'}
      </p>
    )
  return (
    <div className="set-folders">
      {/* Vị trí phổ biến / Common locations */}
      <section className="idx-common-sources-section" aria-label={dict.commonTitle}>
        <div className="idx-common-sources-header">
          <h4 className="set-field-label">{dict.commonTitle}</h4>
          <p className="set-field-desc">{dict.commonDesc}</p>
        </div>
        <div className="idx-common-sources-grid">
          {commonLocations.map((loc) => {
            const entry = knownSources.find((s) => s.id === loc.id)
            const isChecked = !!entry?.enabled
            const isBusy = !!busySources[loc.id]
            const status: KnownSearchSourceStatus = entry?.status ?? (isChecked ? 'queued' : 'disabled')
            const statusText = getStatusLabel(status, dict)
            const inlineError = sourceErrors[loc.id] || entry?.error
            const isUnavailable = status === 'unavailable'

            return (
              <div
                key={loc.id}
                className={`idx-common-source-card${isChecked ? ' is-active' : ''}${isUnavailable ? ' is-unavailable' : ''}`}
              >
                <div className="idx-common-source-icon">{renderLocationIcon(loc.icon)}</div>
                <div className="idx-common-source-info">
                  <div className="idx-common-source-row">
                    <span className="idx-common-source-name">{loc.name}</span>
                    <span
                      className={`idx-common-source-chip status-${status}`}
                      data-status={status}
                    >
                      {statusText}
                    </span>
                  </div>
                  <span className="idx-common-source-desc">{loc.desc}</span>
                  {entry?.path && (
                    <span className="idx-common-source-path" title={entry.path}>
                      {entry.path}
                    </span>
                  )}
                  {inlineError && (
                    <span className="idx-common-source-error" role="alert">
                      {inlineError}
                    </span>
                  )}
                </div>
                <label className="idx-switch" aria-label={loc.name}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    disabled={isBusy}
                    onChange={(e) => void toggleKnownSource(loc.id, e.target.checked)}
                  />
                  <span className="idx-switch-slider" />
                </label>
              </div>
            )
          })}
        </div>
      </section>

      <div className="idx-custom-sources-header" style={{ marginTop: 14 }}>
        <h4 className="set-field-label">{dict.title}</h4>
        <p className="set-field-desc">{dict.desc}</p>
      </div>
      {failed && (
        <p role="status" className="set-field-desc">
          {lang === 'vi'
            ? 'Chưa xác nhận được tiến độ hoặc thao tác. Kiểm tra lại trước khi thử tiếp.'
            : 'Progress or the action could not be confirmed. Refresh before trying again.'}{' '}
          <button type="button" className="set-btn" onClick={() => void refresh()}>
            {lang === 'vi' ? 'Tải lại' : 'Refresh'}
          </button>
        </p>
      )}
      {folders?.length === 0 && <p className="set-field-desc">{dict.empty}</p>}
      {folders?.map((folder) => {
        const isOpen = open === folder.root
        const status = folder.unavailable
          ? dict.offline
          : folder.state === 'running'
            ? dict.running
            : folder.state === 'stopped'
              ? dict.stopped
              : null
        const last = folder.completedAt
          ? fill(dict.last, { when: when(folder.completedAt) })
          : dict.never
        return (
          <div className={`set-folder${folder.unavailable ? ' is-offline' : ''}`} key={folder.root}>
            <div className="set-folder-head">
              <div className="set-folder-title">
                <strong>{folderName(folder.root)}</strong>
                <span title={folder.root}>{folder.root}</span>
              </div>
              {status && <span className="set-folder-chip">{status}</span>}
            </div>
            <div className="set-field-desc">
              {last}
              {folder.reconciledAt
                ? ` · ${fill(dict.refreshed, { when: when(folder.reconciledAt) })}`
                : ''}
            </div>
            <div className="set-field-desc">
              {fill(dict.files, { n: folder.totalFiles })}
              {` · ${folder.readyFiles.toLocaleString(lang)} ${lang === 'vi' ? 'đã xử lý' : 'processed'}`}
              {!!folder.emptyFiles &&
                ` (${folder.emptyFiles.toLocaleString(lang)} ${lang === 'vi' ? 'chưa có chữ' : 'without text'})`}
              {folder.pendingFiles > 0
                ? ` · ${fill(dict.waiting, { n: folder.pendingFiles })}`
                : ''}
              {folder.errorFiles > 0 ? ` · ${fill(dict.errors, { n: folder.errorFiles })}` : ''}
            </div>
            {folder.totalFiles > 0 && (
              <progress
                style={{ width: '100%', height: 6, margin: '10px 0' }}
                max={folder.totalFiles}
                value={folder.readyFiles + folder.errorFiles}
                aria-label={lang === 'vi' ? 'Tiến độ tệp' : 'File progress'}
              />
            )}
            {!!folder.totalChunks && (
              <p className="set-field-desc">
                {(folder.completedChunks ?? 0).toLocaleString(lang)} /{' '}
                {folder.totalChunks.toLocaleString(lang)}{' '}
                {lang === 'vi'
                  ? 'đoạn đã sẵn sàng tìm theo nội dung'
                  : 'passages ready for content search'}
              </p>
            )}
            {folder.lastError && (
              <p className="set-field-desc" role="status">
                {folder.lastError}
              </p>
            )}
            <div className="set-folder-actions">
              <button
                type="button"
                className={`set-btn${folder.priority ? ' primary' : ''}`}
                aria-pressed={folder.priority}
                disabled={busy === folder.root}
                onClick={() =>
                  void act(folder.root, () =>
                    window.aiOffice.setIndexedFolderPriority(folder.root, !folder.priority),
                  )
                }
              >
                {folder.priority ? `★ ${dict.priorityOn}` : `☆ ${dict.priority}`}
              </button>
              <button
                type="button"
                className="set-btn"
                disabled={busy === folder.root || folder.state === 'running' || folder.unavailable}
                onClick={() =>
                  void act(folder.root, () => window.aiOffice.rescanIndexedFolder(folder.root))
                }
              >
                {dict.rescan}
              </button>
              <button
                type="button"
                className="set-btn"
                onClick={() => setOpen(isOpen ? null : folder.root)}
              >
                {isOpen ? dict.hideHistory : dict.history}
              </button>
              <button
                type="button"
                className="set-btn"
                title={dict.forgetTip}
                disabled={busy === folder.root || folder.state === 'running'}
                onClick={() =>
                  void act(folder.root, () => window.aiOffice.forgetIndexedFolder(folder.root))
                }
              >
                {dict.forget}
              </button>
            </div>
            {isOpen &&
              (folder.history.length === 0 ? (
                <p className="set-field-desc">{dict.noHistory}</p>
              ) : (
                <ul className="set-folder-runs">
                  {folder.history.map((run) => (
                    <RunRow key={`${run.kind}-${run.endedAt}`} run={run} dict={dict} when={when} />
                  ))}
                </ul>
              ))}
          </div>
        )
      })}
    </div>
  )
}
