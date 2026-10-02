import { useCallback, useEffect, useState } from 'react'
import type { IndexedFolder, IndexedFolderRun } from '../../../shared/fork/document-index-api'
import { useI18n } from '../locale'

const EN = {
  title: 'Indexed folders',
  desc: 'When each folder was last read, what is waiting, and which folder goes first.',
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
}

type Dict = Record<keyof typeof EN, string>

const STRINGS: Record<'en' | 'vi' | 'zh', Dict> = {
  en: EN,
  vi: {
    title: 'Thư mục đã lập chỉ mục',
    desc: 'Mỗi thư mục được đọc lần cuối khi nào, còn gì đang chờ và thư mục nào được ưu tiên.',
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
  },
  zh: {
    title: '已索引的文件夹',
    desc: '每个文件夹上次读取的时间、待处理的内容，以及哪个文件夹优先。',
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

export function IndexedFolders() {
  const { lang } = useI18n()
  const dict: Dict = (STRINGS as Record<string, Dict | undefined>)[lang] ?? STRINGS.en
  const when = useWhen(lang, dict)
  const [folders, setFolders] = useState<IndexedFolder[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await window.aiOffice.listIndexedFolders?.()
      if (next) setFolders(next)
    } catch {
      // keep what is on screen
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 5_000)
    return () => clearInterval(timer)
  }, [refresh])

  const act = async (root: string, run: () => Promise<unknown>) => {
    setBusy(root)
    try {
      await run()
    } catch {
      // the next refresh shows the real state
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  if (folders === null) return null
  return (
    <div className="set-folders">
      <h4 className="set-field-label">{dict.title}</h4>
      <p className="set-field-desc">{dict.desc}</p>
      {folders.length === 0 && <p className="set-field-desc">{dict.empty}</p>}
      {folders.map((folder) => {
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
              {folder.pendingFiles > 0
                ? ` · ${fill(dict.waiting, { n: folder.pendingFiles })}`
                : ''}
              {folder.errorFiles > 0 ? ` · ${fill(dict.errors, { n: folder.errorFiles })}` : ''}
            </div>
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
