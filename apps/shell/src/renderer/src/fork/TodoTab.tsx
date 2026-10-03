import { useCallback, useEffect, useRef, useState } from 'react'
import type { HomeApi, LegacyConvertState } from '../../../shared/home-api'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import type { IndexIssueReason } from '../../../main/document-memory/issues'
import { useI18n } from '../locale'
import { IndexProblems, type ProblemCommands } from './IndexProblems'
import { buildTodo, type TodoAction, type TodoCard, type TodoTile } from './todo-model'

const EN = {
  heading: 'To do',
  sub: 'What needs you, what GenOffice is doing on its own, and shortcuts for both.',
  rescan: 'Scan again',
  addFolder: 'Add folder',
  tiles: {
    indexing: 'Being read',
    scans: 'Scans to read',
    errors: 'Errors',
    legacy: 'Old files to convert',
    ready: 'Ready to search',
  },
  cards: {
    off: ['Indexing is off', 'Nothing new is read until you turn it on.'],
    held: ['Waiting for the computer', 'Work continues by itself when this passes.'],
    errors: ['{n} files could not be read', 'Most of these work on a second try.'],
    scans: ['{n} scanned files have no text yet', 'Antigravity can read them; it uses its quota.'],
    legacy: [
      '{n} old files are being converted',
      'The conversion service does it; originals are kept 30 days.',
    ],
    indexing: ['{n} files are being read', 'You do not need to do anything.'],
    scanning: ['Looking for new files', 'Folders are being scanned.'],
    quiet: [
      '{n} files skipped on purpose',
      'Passwords, unsupported formats and the like. Nothing to do.',
    ],
  },
  failedConvert: '{n} could not be converted',
  actions: {
    resume: 'Turn on',
    retryAll: 'Try all again',
    readScans: 'Read all scans',
    convertNow: 'Convert now',
    viewErrors: 'Show errors',
    viewScans: 'Show scans',
    viewIndexing: 'Show list',
    viewQuiet: 'Show list',
  },
  healthyTitle: 'All done',
  healthyBody: '{n} files are indexed and searchable. Nothing needs you.',
  tips: [
    'Ctrl/Shift+click picks several files at once.',
    'New files in your folders are picked up by themselves.',
    'Scans can be read in bulk with Antigravity from here.',
  ],
  search: 'Find a file in these lists…',
  clear: 'Clear',
  filterAll: 'All',
}
type Dict = typeof EN
const VI: Dict = {
  heading: 'Cần xử lý',
  sub: 'Việc cần bạn, việc GenOffice đang tự làm, và lối tắt cho cả hai.',
  rescan: 'Quét lại',
  addFolder: 'Thêm thư mục',
  tiles: {
    indexing: 'Đang đọc',
    scans: 'Tệp quét chưa đọc',
    errors: 'Lỗi',
    legacy: 'Tệp cũ chờ chuyển',
    ready: 'Sẵn sàng tìm kiếm',
  },
  cards: {
    off: ['Đang tắt index', 'Sẽ không đọc thêm tệp nào cho tới khi bạn bật lại.'],
    held: ['Đang chờ máy', 'Tự chạy tiếp khi hết lý do này.'],
    errors: ['{n} tệp chưa đọc được', 'Phần lớn sẽ được ở lần thử thứ hai.'],
    scans: ['{n} tệp quét chưa có chữ', 'Antigravity đọc được; sẽ tốn quota của nó.'],
    legacy: ['Đang chuyển {n} tệp cũ', 'Server chuyển đổi làm giúp; bản gốc giữ 30 ngày.'],
    indexing: ['Đang đọc {n} tệp', 'Bạn không cần làm gì.'],
    scanning: ['Đang tìm tệp mới', 'Đang quét các thư mục.'],
    quiet: ['{n} tệp bỏ qua có chủ đích', 'Có mật khẩu, định dạng không hỗ trợ… Không cần làm gì.'],
  },
  failedConvert: '{n} tệp không chuyển được',
  actions: {
    resume: 'Bật lại',
    retryAll: 'Thử lại tất cả',
    readScans: 'Đọc hết tệp quét',
    convertNow: 'Chuyển ngay',
    viewErrors: 'Xem lỗi',
    viewScans: 'Xem tệp quét',
    viewIndexing: 'Xem danh sách',
    viewQuiet: 'Xem danh sách',
  },
  healthyTitle: 'Xong hết rồi',
  healthyBody: '{n} tệp đã được index và tìm được. Không có gì cần bạn.',
  tips: [
    'Ctrl/Shift+bấm để chọn nhiều tệp cùng lúc.',
    'Tệp mới trong thư mục của bạn tự được nhận.',
    'Có thể đọc hàng loạt tệp quét bằng Antigravity ngay tại đây.',
  ],
  search: 'Tìm tệp trong các danh sách…',
  clear: 'Xoá',
  filterAll: 'Tất cả',
}

const REASON_OF: Partial<Record<TodoAction, IndexIssueReason>> = {
  viewScans: 'no-text',
  viewIndexing: 'waiting',
}

export interface TodoTabProps {
  api: HomeApi
  /** from the dashboard: how far indexing is and why it may be held */
  ready: number
  pending: number
  switchedOff: boolean
  held: boolean
  heldWhy: string
  scanning: boolean
  focus: IndexIssueReason | null
  onAddFolder(): void
  onRescan(): void
  onResume(): void
  onChanged(): void
}

export function TodoTab(props: TodoTabProps) {
  const { api, onChanged } = props
  const { lang, dateLocale } = useI18n()
  const d = lang === 'vi' ? VI : EN
  const num = (n: number) => n.toLocaleString(dateLocale)
  const [summary, setSummary] = useState<IndexIssueSummary | null>(null)
  const [legacy, setLegacy] = useState<LegacyConvertState | null>(null)
  const [query, setQuery] = useState('')
  const commands = useRef<ProblemCommands | null>(null)
  const lists = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const read = () => {
      if (document.visibilityState !== 'visible') return
      void api
        .getDocumentIndexIssueSummary('*')
        .then((next) => alive && setSummary(next))
        .catch(() => undefined)
      void api
        .getLegacyConvertState?.()
        .then((next) => alive && next && setLegacy(next))
        .catch(() => undefined)
    }
    read()
    const timer = setInterval(read, 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [api])

  const todo = buildTodo({
    groups: summary?.groups ?? [],
    pending: props.pending,
    ready: props.ready,
    switchedOff: props.switchedOff,
    held: props.held,
    ...(props.heldWhy ? { heldReason: props.heldWhy } : {}),
    scanning: props.scanning,
    legacy,
  })

  const show = useCallback((reason: IndexIssueReason) => {
    commands.current?.openReason(reason)
    // the list is drawn a moment later; scroll after it exists
    window.setTimeout(
      () => lists.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      50,
    )
  }, [])

  const run = (action: TodoAction) => {
    if (action === 'resume') props.onResume()
    else if (action === 'retryAll') void commands.current?.retryAll()
    else if (action === 'readScans') void commands.current?.readAllScans()
    else if (action === 'convertNow') void api.startLegacyConvert?.().then(onChanged)
    else if (action === 'viewErrors') {
      const first = summary?.groups.find(
        (g) => g.reason !== 'no-text' && g.reason !== 'waiting' && g.count > 0,
      )
      if (first) show(first.reason)
    } else if (action === 'viewQuiet') {
      const first = summary?.groups.find(
        (g) => g.reason === 'unsupported' || g.reason === 'password',
      )
      if (first) show(first.reason)
    } else {
      const reason = REASON_OF[action]
      if (reason) show(reason)
    }
  }

  const tileButton = (tile: TodoTile) => {
    const body = (
      <>
        <strong>{num(tile.value)}</strong>
        <span>{d.tiles[tile.id]}</span>
      </>
    )
    const cls = `todo-tile${tile.attention ? ' is-attention' : ''}`
    return tile.opens ? (
      <button type="button" key={tile.id} className={cls} onClick={() => run(tile.opens!)}>
        {body}
      </button>
    ) : (
      <div key={tile.id} className={cls}>
        {body}
      </div>
    )
  }

  const cardView = (card: TodoCard) => {
    const [title, hint] = d.cards[card.id]
    const detail =
      card.why ?? (card.failed ? d.failedConvert.replace('{n}', num(card.failed)) : hint)
    return (
      <li key={card.id} className={`todo-card is-${card.tone}`}>
        <div className="todo-card-text">
          <strong>{title.replace('{n}', num(card.count))}</strong>
          <span>{detail}</span>
          {card.progress !== undefined && (
            <span
              className="ixp-bar"
              role="progressbar"
              aria-valuenow={card.progress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span style={{ width: `${card.progress}%` }} />
            </span>
          )}
        </div>
        <div className="todo-card-actions">
          {card.primary && (
            <button type="button" className="idx-btn primary" onClick={() => run(card.primary!)}>
              {d.actions[card.primary]}
            </button>
          )}
          {card.secondary && (
            <button type="button" className="idx-btn" onClick={() => run(card.secondary!)}>
              {d.actions[card.secondary]}
            </button>
          )}
        </div>
      </li>
    )
  }

  const tip = d.tips[Math.floor(Date.now() / 86_400_000) % d.tips.length]
  return (
    <div className="todo">
      <header className="todo-head">
        <div>
          <h2>{d.heading}</h2>
          <p>{d.sub}</p>
        </div>
        <div className="todo-head-actions">
          <button type="button" className="idx-btn" onClick={props.onRescan}>
            {d.rescan}
          </button>
          <button type="button" className="idx-btn" onClick={props.onAddFolder}>
            {d.addFolder}
          </button>
        </div>
      </header>

      <div className="todo-tiles">{todo.tiles.map(tileButton)}</div>

      {todo.cards.length > 0 && <ul className="todo-cards">{todo.cards.map(cardView)}</ul>}

      {todo.healthy && (
        <section className="todo-healthy" aria-live="polite">
          <span className="todo-healthy-mark" aria-hidden="true">
            ✓
          </span>
          <div>
            <strong>{d.healthyTitle}</strong>
            <p>{d.healthyBody.replace('{n}', num(props.ready))}</p>
            <small>{tip}</small>
          </div>
        </section>
      )}

      {(summary?.groups.length ?? 0) > 0 && (
        <div ref={lists} className="todo-lists">
          <div className="todo-search" role="search">
            <input
              type="search"
              value={query}
              placeholder={d.search}
              aria-label={d.search}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
            />
            {query && (
              <button type="button" className="idx-link" onClick={() => setQuery('')}>
                {d.clear}
              </button>
            )}
          </div>
          <IndexProblems
            api={api}
            root="*"
            focus={props.focus}
            onChanged={onChanged}
            query={query}
            hideEmpty
            hideToolbar
            commandRef={commands}
          />
        </div>
      )}
    </div>
  )
}
