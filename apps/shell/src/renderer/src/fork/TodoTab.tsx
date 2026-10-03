import { useEffect, useState } from 'react'
import type { HomeApi, LegacyConvertState } from '../../../shared/home-api'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import type { IndexIssueReason } from '../../../main/document-memory/issues'
import { useI18n } from '../locale'
import { IndexProblems } from './IndexProblems'
import { issueBucket, type IssueBucket } from './index-issue-view'
import { buildTodo, type TodoCard } from './todo-model'

const EN = {
  heading: 'To do',
  sub: 'Choose what to handle. GenOffice continues the background work for you.',
  ready: '{n} searchable files',
  filters: {
    attention: 'Needs attention',
    background: 'In progress',
    skipped: 'Skipped',
    all: 'All',
  },
  search: 'Search by file name or folder',
  clear: 'Clear search',
  sort: 'Sort files',
  queue: 'Processing order',
  name: 'File name (loaded)',
  loading: 'Loading file status…',
  loadFailed: 'Could not refresh file status. The last available information is kept.',
  retry: 'Refresh',
  actionFailed: 'Could not start this action. Please try again.',
  cards: {
    off: ['Indexing is off', 'Turn it on to make new files searchable.'],
    held: ['Background work is paused', 'GenOffice continues when the computer is ready.'],
    errors: ['', ''],
    scans: ['', ''],
    indexing: ['', ''],
    quiet: ['', ''],
    legacy: [
      'Converting older Office files',
      'The originals are kept for 30 days after conversion.',
    ],
    scanning: ['Finding new files', 'You can keep working while folders are scanned.'],
  },
  legacyWaiting: '{n} older Office files are waiting to convert',
  legacyFailed: '{n} files could not be converted. Their originals are kept.',
  resume: 'Turn on indexing',
  convert: 'Convert files',
  working: 'Starting…',
  healthyTitle: 'Nothing needs your attention',
  healthyBody: 'Files that can be read are searchable. New files are picked up automatically.',
  empty: {
    attention: 'No files need your attention. Check In progress for background work.',
    background: 'No files are waiting to be read.',
    skipped: 'No files have been skipped.',
    all: 'No pending files. Your index is up to date.',
  },
  selectionHint: 'Select files with the checkboxes. Right-click or use ⋯ for more actions.',
}
type Dict = typeof EN
const VI: Dict = {
  heading: 'Cần xử lý',
  sub: 'Chọn việc cần làm. GenOffice tiếp tục xử lý các tác vụ nền giúp bạn.',
  ready: '{n} tệp sẵn sàng tìm kiếm',
  filters: {
    attention: 'Cần xử lý',
    background: 'Đang chạy',
    skipped: 'Đã bỏ qua',
    all: 'Tất cả',
  },
  search: 'Tìm theo tên tệp hoặc thư mục',
  clear: 'Xóa tìm kiếm',
  sort: 'Sắp xếp tệp',
  queue: 'Thứ tự xử lý',
  name: 'Tên tệp đã tải',
  loading: 'Đang tải trạng thái tệp…',
  loadFailed: 'Chưa cập nhật được trạng thái tệp. Thông tin gần nhất vẫn được giữ lại.',
  retry: 'Tải lại',
  actionFailed: 'Chưa bắt đầu được thao tác. Bạn thử lại nhé.',
  cards: {
    off: ['Đang tắt lập chỉ mục', 'Bật lại để có thể tìm kiếm trong các tệp mới.'],
    held: ['Đang tạm dừng tác vụ nền', 'GenOffice tự tiếp tục khi máy sẵn sàng.'],
    errors: ['', ''],
    scans: ['', ''],
    indexing: ['', ''],
    quiet: ['', ''],
    legacy: ['Đang chuyển tệp Office cũ', 'Bản gốc được giữ 30 ngày sau khi chuyển đổi.'],
    scanning: ['Đang tìm tệp mới', 'Bạn có thể tiếp tục làm việc trong lúc quét thư mục.'],
  },
  legacyWaiting: '{n} tệp Office cũ đang chờ chuyển đổi',
  legacyFailed: '{n} tệp chưa chuyển được. Bản gốc vẫn được giữ lại.',
  resume: 'Bật lập chỉ mục',
  convert: 'Chuyển đổi tệp',
  working: 'Đang bắt đầu…',
  healthyTitle: 'Không có việc cần bạn xử lý',
  healthyBody: 'Các tệp đọc được đã sẵn sàng tìm kiếm. Tệp mới sẽ được nhận tự động.',
  empty: {
    attention: 'Không có tệp cần bạn xử lý. Xem Đang chạy để theo dõi tác vụ nền.',
    background: 'Không có tệp đang chờ đọc.',
    skipped: 'Không có tệp nào bị bỏ qua.',
    all: 'Không còn tệp chờ xử lý. Chỉ mục đã cập nhật.',
  },
  selectionHint: 'Đánh dấu để chọn tệp. Bấm chuột phải hoặc ⋯ để xem thêm thao tác.',
}

export interface TodoTabProps {
  api: HomeApi
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
  const [bucket, setBucket] = useState<IssueBucket | 'all'>('attention')
  const [sort, setSort] = useState<'queue' | 'name'>('queue')
  const [loadFailed, setLoadFailed] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [working, setWorking] = useState(false)
  const [actionFailed, setActionFailed] = useState(false)

  useEffect(() => {
    if (props.focus) setBucket(issueBucket(props.focus))
  }, [props.focus])

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      if (document.visibilityState === 'visible') {
        const [issues, conversion] = await Promise.allSettled([
          api.getDocumentIndexIssueSummary('*'),
          api.getLegacyConvertState?.() ?? Promise.resolve(null),
        ])
        if (!alive) return
        if (issues.status === 'fulfilled') {
          setSummary(issues.value)
          setLoadFailed(false)
        } else setLoadFailed(true)
        if (conversion.status === 'fulfilled') setLegacy(conversion.value)
      }
      if (alive) timer = setTimeout(() => void read(), 3000)
    }
    void read()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [api, refresh])

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
  // File-related work is shown once, in the grouped list. Only global operations need a banner.
  const cards = todo.cards.filter((card) => ['off', 'held', 'legacy'].includes(card.id))
  const counts = { all: 0, attention: 0, background: 0, skipped: 0 }
  for (const group of summary?.groups ?? []) {
    counts.all += group.count
    counts[issueBucket(group.reason)] += group.count
  }
  const convert = async () => {
    if (working) return
    setWorking(true)
    setActionFailed(false)
    try {
      await api.startLegacyConvert?.()
      onChanged()
      setRefresh((n) => n + 1)
    } catch {
      setActionFailed(true)
    } finally {
      setWorking(false)
    }
  }
  const cardView = (card: TodoCard) => {
    const [title, hint] = d.cards[card.id]
    return (
      <li key={card.id} className={`todo-operation is-${card.id}`}>
        <span className="todo-operation-mark" aria-hidden="true">
          {card.id === 'off' || card.id === 'held' ? 'Ⅱ' : '↻'}
        </span>
        <div className="todo-card-text">
          <strong>
            {card.id === 'legacy' && !legacy?.running
              ? d.legacyWaiting.replace('{n}', num(card.count))
              : title}
          </strong>
          <span>{card.why ?? hint}</span>
          {card.failed ? <span>{d.legacyFailed.replace('{n}', num(card.failed))}</span> : null}
          {card.progress !== undefined && (
            <span
              className="ixp-bar"
              role="progressbar"
              aria-label={title}
              aria-valuenow={card.progress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span style={{ width: `${card.progress}%` }} />
            </span>
          )}
        </div>
        {card.id === 'off' && (
          <button type="button" className="idx-btn" onClick={props.onResume}>
            {d.resume}
          </button>
        )}
        {card.primary === 'convertNow' && (
          <button
            type="button"
            className="idx-btn"
            disabled={working}
            onClick={() => void convert()}
          >
            {working ? d.working : d.convert}
          </button>
        )}
      </li>
    )
  }
  return (
    <div className="todo">
      <header className="todo-head">
        <div>
          <h2>{d.heading}</h2>
          <p>{d.sub}</p>
        </div>
        <span className="todo-ready">
          {props.scanning ? d.cards.scanning[0] : d.ready.replace('{n}', num(props.ready))}
        </span>
      </header>
      {cards.length > 0 && <ul className="todo-operations">{cards.map(cardView)}</ul>}
      {actionFailed && (
        <p className="todo-status" role="status">
          {d.actionFailed}
        </p>
      )}
      {loadFailed && (
        <div className="todo-status" role="status">
          <span>{d.loadFailed}</span>
          <button type="button" className="idx-link" onClick={() => setRefresh((n) => n + 1)}>
            {d.retry}
          </button>
        </div>
      )}
      {!summary && !loadFailed && (
        <p className="todo-status" role="status">
          {d.loading}
        </p>
      )}
      <div className="todo-workspace">
        <div className="todo-controls">
          <div className="todo-filters" role="group" aria-label={d.heading}>
            {(['attention', 'background', 'skipped', 'all'] as const).map((key) => (
              <button
                type="button"
                key={key}
                aria-pressed={bucket === key}
                className={bucket === key ? 'is-active' : ''}
                onClick={() => setBucket(key)}
              >
                <span>{d.filters[key]}</span>
                <span className="todo-filter-count">{summary ? num(counts[key]) : '–'}</span>
              </button>
            ))}
          </div>
          <div className="todo-search">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="6.8" cy="6.8" r="4.3" stroke="currentColor" strokeWidth="1.4" />
              <path
                d="m10 10 3.5 3.5"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
            <input
              type="search"
              value={query}
              placeholder={d.search}
              aria-label={d.search}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
            />
            {query && (
              <button
                type="button"
                className="ixp-icon"
                aria-label={d.clear}
                onClick={() => setQuery('')}
              >
                ×
              </button>
            )}
            <select
              value={sort}
              aria-label={d.sort}
              onChange={(event) => setSort(event.target.value as 'queue' | 'name')}
            >
              <option value="queue">{d.queue}</option>
              <option value="name">{d.name}</option>
            </select>
          </div>
        </div>
        {summary && !loadFailed && counts[bucket] === 0 && (
          <section className="todo-empty">
            <span className="todo-empty-mark" aria-hidden="true">
              ✓
            </span>
            <strong>{counts.all === 0 && todo.healthy ? d.healthyTitle : d.filters[bucket]}</strong>
            <p>{counts.all === 0 && todo.healthy ? d.healthyBody : d.empty[bucket]}</p>
          </section>
        )}
        {summary && (
          <IndexProblems
            api={api}
            root="*"
            focus={props.focus}
            onChanged={onChanged}
            query={query}
            hideEmpty
            summary={summary}
            bucket={bucket}
            sort={sort}
          />
        )}
        {summary && counts[bucket] > 0 && <p className="todo-selection-hint">{d.selectionHint}</p>}
      </div>
    </div>
  )
}
