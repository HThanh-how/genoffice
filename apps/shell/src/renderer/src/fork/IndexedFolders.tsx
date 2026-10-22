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
import { nextPollDelay } from './index-poll'
import { readIndexRequest } from './index-request'
import { folderChips, folderDone, type FolderChip } from './index-folder-status'

export interface IndexedFoldersProps {
  api?: HomeApi
  /** a folder with problems offers a way to the list of problem files */
  onOpenIssues?: () => void
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
  empty: 'No folder has been scanned yet. Use "Add folder" at the top of the page.',
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
  quickAdd: 'Quick add',
  quickAddTitle: 'Add a common folder',
  filesOf: '{done} / {total} files',
  chipIndexing: 'Indexing',
  chipReady: 'Ready',
  chipErrors: 'Has problems',
  chipErrorsTip: 'Open the files that need attention',
  moreActions: 'More actions',
  loadingFolders: 'Loading folder progress…',
  refreshFailed: 'Progress or the action could not be confirmed. Refresh before trying again.',
  refreshButton: 'Refresh',
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
    empty: 'Chưa quét thư mục nào. Hãy bấm "Thêm thư mục" ở đầu trang.',
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
    quickAdd: 'Thêm nhanh',
    quickAddTitle: 'Thêm một thư mục phổ biến',
    filesOf: '{done} / {total} tệp',
    chipIndexing: 'Đang index',
    chipReady: 'Sẵn sàng',
    chipErrors: 'Có lỗi',
    chipErrorsTip: 'Mở các tệp cần xử lý',
    moreActions: 'Thêm thao tác',
    loadingFolders: 'Đang lấy tiến độ thư mục…',
    refreshFailed: 'Chưa xác nhận được tiến độ hoặc thao tác. Kiểm tra lại trước khi thử tiếp.',
    refreshButton: 'Tải lại',
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
    empty: '尚未扫描任何文件夹。请使用页面顶部的“添加文件夹”。',
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
    quickAdd: '快速添加',
    quickAddTitle: '添加常用文件夹',
    filesOf: '{done} / {total} 个文件',
    chipIndexing: '正在索引',
    chipReady: '已就绪',
    chipErrors: '有问题',
    chipErrorsTip: '打开需要处理的文件',
    moreActions: '更多操作',
    loadingFolders: '正在获取文件夹进度…',
    refreshFailed: '无法确认进度或操作。请刷新后再试。',
    refreshButton: '刷新',
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

export function IndexedFolders({ api, onOpenIssues }: IndexedFoldersProps = {}) {
  const effectiveApi =
    api ??
    (typeof window !== 'undefined'
      ? (window as unknown as { aiOffice?: HomeApi }).aiOffice
      : undefined)

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

  const busySourcesRef = useRef<Record<string, boolean>>({})
  busySourcesRef.current = busySources
  const sourceActionSeqRef = useRef<Record<string, number>>({})

  // Sync known sources from API (Single source of truth)
  const fetchKnown = useCallback(async () => {
    try {
      const getFn = (effectiveApi as Record<string, unknown> | undefined)?.getKnownSearchSources
      if (typeof getFn === 'function') {
        const capturedSeqs = { ...sourceActionSeqRef.current }
        const res = await (getFn as () => Promise<unknown>).call(effectiveApi)
        if (mounted.current && Array.isArray(res)) {
          setKnownSources((prev) => {
            return (res as KnownSearchSourceEntry[]).map((entry) => {
              const isBusy = busySourcesRef.current[entry.id]
              const seqChanged =
                (sourceActionSeqRef.current[entry.id] ?? 0) !== (capturedSeqs[entry.id] ?? 0)
              if (isBusy || seqChanged) {
                const existing = prev.find((s) => s.id === entry.id)
                if (existing) return existing
              }
              return entry
            })
          })
        }
      }
    } catch (err) {
      console.warn('api.getKnownSearchSources error:', err)
    }
  }, [effectiveApi])

  const toggleKnownSource = async (id: KnownSearchSource, enabled: boolean) => {
    if (busySourcesRef.current[id]) return
    busySourcesRef.current[id] = true
    setBusySources((prev) => ({ ...prev, [id]: true }))

    sourceActionSeqRef.current[id] = (sourceActionSeqRef.current[id] ?? 0) + 1
    setSourceErrors((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })

    const previousEntry = knownSources.find((s) => s.id === id)
    // Optimistic UI update
    setKnownSources((prev) => {
      const exists = prev.some((s) => s.id === id)
      if (exists) {
        return prev.map((s) => (s.id === id ? { ...s, enabled } : s))
      }
      return [...prev, { id, path: '', enabled, status: enabled ? 'queued' : 'disabled' }]
    })

    let refreshAfterFailure = false
    try {
      const setFn = (effectiveApi as Record<string, unknown> | undefined)?.setKnownSearchSource
      if (typeof setFn === 'function') {
        const res = await (
          setFn as (sourceId: string, isEnabled: boolean) => Promise<unknown>
        ).call(effectiveApi, id, enabled)
        if (res && typeof res === 'object' && 'id' in res) {
          const updated = res as KnownSearchSourceEntry
          setKnownSources((prev) => prev.map((s) => (s.id === id ? updated : s)))
        } else {
          await fetchKnown()
        }
      }
    } catch (err) {
      console.warn(`api.setKnownSearchSource(${id}, ${enabled}) failed:`, err)
      refreshAfterFailure = true
      // Rollback optimistic update
      setKnownSources((prev) =>
        prev.map((s) =>
          s.id === id ? (previousEntry ? { ...previousEntry } : { ...s, enabled: !enabled }) : s,
        ),
      )
      const errorMsg = err instanceof Error && err.message ? err.message : dict.sourceToggleFailed
      setSourceErrors((prev) => ({ ...prev, [id]: errorMsg }))
    } finally {
      busySourcesRef.current[id] = false
      setBusySources((prev) => ({ ...prev, [id]: false }))
    }

    if (refreshAfterFailure) {
      await fetchKnown()
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
    // No visibility gate: a window reported hidden must still get its first read (index-poll.ts).
    if (loading.current || !effectiveApi) return
    loading.current = true
    try {
      await Promise.allSettled([
        (async () => {
          if (!effectiveApi.listIndexedFolders) return
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
          }
        })(),
        fetchKnown(),
      ])
    } finally {
      loading.current = false
    }
  }, [effectiveApi, fetchKnown])

  useEffect(() => {
    mounted.current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      await refresh()
      if (mounted.current) timer = setTimeout(() => void tick(), nextPollDelay(5_000))
    }
    void tick()
    return () => {
      mounted.current = false
      clearTimeout(timer)
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

  // Placeholder rows with the real rows' footprint while the first answer is on its way.
  if (folders === null && !failed)
    return (
      <div className="set-folders" role="status" aria-busy="true" aria-label={dict.loadingFolders}>
        {[0, 1].map((i) => (
          <div className="set-folder idx-src is-placeholder" key={i} aria-hidden="true">
            <div className="idx-src-row">
              <div className="idx-src-title">
                <span className="idx-skel idx-skel-name" />
                <span className="idx-skel idx-skel-path" />
              </div>
            </div>
            <span className="idx-skel idx-skel-bar" />
          </div>
        ))}
      </div>
    )

  const customFolders =
    folders?.filter((folder) => {
      if (!folder.owners || folder.owners.length === 0) return true
      return folder.owners.includes('manual')
    }) ?? null

  const chipLabel = (chip: FolderChip): string => {
    switch (chip) {
      case 'offline':
        return dict.offline
      case 'scanning':
        return dict.running
      case 'stopped':
        return dict.stopped
      case 'indexing':
        return dict.chipIndexing
      case 'errors':
        return dict.chipErrors
      default:
        return dict.chipReady
    }
  }
  const closeMenu = (target: HTMLElement) => target.closest('details')?.removeAttribute('open')

  return (
    <div className="set-folders">
      <div className="idx-sources-head">
        <div className="idx-custom-sources-header">
          <h4 className="set-field-label">{dict.title}</h4>
          <p className="set-field-desc">{dict.desc}</p>
        </div>
        {/* Common locations are a shortcut, not a section of their own. */}
        <details className="idx-quick-add idx-common-sources-section">
          <summary className="idx-btn" title={dict.quickAddTitle}>
            {dict.quickAdd}
          </summary>
          <div className="idx-quick-add-panel" aria-label={dict.commonTitle}>
            <p className="set-field-desc">{dict.commonDesc}</p>
            <div className="idx-common-sources-grid">
              {commonLocations.map((loc) => {
                const entry = knownSources.find((s) => s.id === loc.id)
                const isChecked = !!entry?.enabled
                const isBusy = !!busySources[loc.id]
                const status: KnownSearchSourceStatus =
                  entry?.status ?? (isChecked ? 'queued' : 'disabled')
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
          </div>
        </details>
      </div>
      {failed && (
        <p role="status" className="set-field-desc">
          {dict.refreshFailed}{' '}
          <button type="button" className="set-btn" onClick={() => void refresh()}>
            {dict.refreshButton}
          </button>
        </p>
      )}
      {customFolders?.length === 0 && <p className="set-field-desc">{dict.empty}</p>}
      {customFolders?.map((folder) => {
        const isOpen = open === folder.root
        const chips = folderChips(folder)
        const { done, total } = folderDone(folder)
        const last = folder.completedAt
          ? fill(dict.last, { when: when(folder.completedAt) })
          : dict.never
        const lastCheck = folder.reconciledAt
          ? ` · ${fill(dict.refreshed, { when: when(folder.reconciledAt) })}`
          : ''
        const rowBusy = busy === folder.root
        return (
          <div
            className={`set-folder idx-src${folder.unavailable ? ' is-offline' : ''}`}
            key={folder.root}
          >
            <div className="idx-src-row">
              <div className="idx-src-title">
                <strong>{folderName(folder.root)}</strong>
                <span title={folder.root}>{folder.root}</span>
              </div>
              <span className="idx-src-count" title={`${last}${lastCheck}`}>
                {fill(dict.filesOf, {
                  done: done.toLocaleString(lang),
                  total: total.toLocaleString(lang),
                })}
              </span>
              <span className="idx-src-chips">
                {chips.map((chip) =>
                  chip === 'errors' && onOpenIssues ? (
                    <button
                      key={chip}
                      type="button"
                      className={`idx-src-chip is-${chip}`}
                      title={dict.chipErrorsTip}
                      onClick={onOpenIssues}
                    >
                      {chipLabel(chip)} · {folder.errorFiles.toLocaleString(lang)}
                    </button>
                  ) : (
                    <span key={chip} className={`idx-src-chip is-${chip}`}>
                      {chipLabel(chip)}
                    </span>
                  ),
                )}
              </span>
              <details className="idx-more idx-src-more">
                <summary
                  className="idx-btn idx-more-btn"
                  aria-label={dict.moreActions}
                  title={dict.moreActions}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <circle cx="3.5" cy="8" r="1.3" />
                    <circle cx="8" cy="8" r="1.3" />
                    <circle cx="12.5" cy="8" r="1.3" />
                  </svg>
                </summary>
                <div className="idx-more-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    disabled={rowBusy || folder.state === 'running' || folder.unavailable}
                    onClick={(event) => {
                      closeMenu(event.currentTarget)
                      void act(folder.root, () => window.aiOffice.rescanIndexedFolder(folder.root))
                    }}
                  >
                    {dict.rescan}
                  </button>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={folder.priority}
                    disabled={rowBusy}
                    onClick={(event) => {
                      closeMenu(event.currentTarget)
                      void act(folder.root, () =>
                        window.aiOffice.setIndexedFolderPriority(folder.root, !folder.priority),
                      )
                    }}
                  >
                    {folder.priority ? `★ ${dict.priorityOn}` : `☆ ${dict.priority}`}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={(event) => {
                      closeMenu(event.currentTarget)
                      setOpen(isOpen ? null : folder.root)
                    }}
                  >
                    {isOpen ? dict.hideHistory : dict.history}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    title={dict.forgetTip}
                    disabled={rowBusy || folder.state === 'running'}
                    onClick={(event) => {
                      closeMenu(event.currentTarget)
                      void act(folder.root, () => window.aiOffice.forgetIndexedFolder(folder.root))
                    }}
                  >
                    {dict.forget}
                  </button>
                </div>
              </details>
            </div>
            {total > 0 && done < total && !folder.unavailable && (
              <progress
                className="idx-src-progress"
                max={total}
                value={done}
                aria-label={lang === 'vi' ? 'Tiến độ tệp' : 'File progress'}
              />
            )}
            {folder.lastError && (
              <p className="set-field-desc" role="status">
                {folder.lastError}
              </p>
            )}
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
