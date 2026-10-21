import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { HomeApi, LegacyConvertState } from '../../../shared/home-api'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import { isRetryableReason, type IndexIssueReason } from '../../../main/document-memory/issues'
import { useI18n } from '../locale'
import { fill } from '../indexing-activity-copy'
import { IndexProblems } from './IndexProblems'
import { runIndexMutation } from './index-mutation'
import {
  buildIssueSections,
  narrowSummary,
  sectionOf,
  type IssueSection,
  type IssueSectionRow,
} from './index-issue-groups'
import { TEXT, EN as DASH_EN } from './index-dashboard-i18n'
import { isIndexIssueSummary, readIndexRequest } from './index-request'
import { buildTodo, isLegacyConvertState, type TodoCard } from './todo-model'
import type { IndexViewGroup, IndexViewSort } from './index-list-view'

const VIEW_KEY = 'genoffice.index.todo.view'
function savedView(): { sort: IndexViewSort; grouping: IndexViewGroup; descending: boolean } {
  const fallback = { sort: 'queue' as const, grouping: 'reason' as const, descending: false }
  try {
    const value = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null')
    if (
      !value ||
      !['queue', 'name', 'folder', 'type', 'progress', 'status', 'connection'].includes(
        value.sort,
      ) ||
      !['reason', 'folder', 'type', 'none'].includes(value.grouping) ||
      typeof value.descending !== 'boolean'
    )
      return fallback
    return value
  } catch {
    return fallback
  }
}

const EN = {
  heading: 'To do',
  sub: 'Choose what to handle. GenOffice continues the background work for you.',
  ready: '{n} searchable files',
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
  selectionHint: 'Select files with the checkboxes. Right-click or use ⋯ for more actions.',
}
type Dict = typeof EN
const VI: Dict = {
  heading: 'Cần xử lý',
  sub: 'Chọn việc cần làm. GenOffice tiếp tục xử lý các tác vụ nền giúp bạn.',
  ready: '{n} tệp sẵn sàng tìm kiếm',
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


function IssueRow({
  row,
  title,
  hint,
  num,
  open,
  onToggle,
  action,
  showLabel,
  hideLabel,
  muted,
  children,
}: {
  row: IssueSectionRow
  title: string
  hint: string
  num: (n: number) => string
  open: boolean
  onToggle: () => void
  action?: ReactNode
  showLabel: string
  hideLabel: string
  muted?: boolean
  children?: ReactNode
}) {
  return (
    <li
      className={`idx-issue${muted ? ' is-muted' : ''}${open ? ' is-open' : ''}`}
      data-section={row.id}
    >
      <div className="idx-issue-head">
        <button
          type="button"
          className="idx-issue-main"
          aria-expanded={open}
          title={open ? hideLabel : showLabel}
          onClick={onToggle}
        >
          <span className="idx-issue-chev" aria-hidden="true">
            ›
          </span>
          <span className="idx-issue-text">
            <strong>{title}</strong>
            <span>{hint}</span>
          </span>
          <span className="idx-issue-count">{num(row.count)}</span>
        </button>
        {action}
      </div>
      {open && <div className="idx-issue-body">{children}</div>}
    </li>
  )
}

export function TodoTab(props: TodoTabProps) {
  const { api, onChanged } = props
  const { lang, dateLocale } = useI18n()
  const d = lang === 'vi' ? VI : EN
  const g = (TEXT[lang] ?? DASH_EN).issues
  const num = (n: number) => n.toLocaleString(dateLocale)
  const [summary, setSummary] = useState<IndexIssueSummary | null>(null)
  const [legacy, setLegacy] = useState<LegacyConvertState | null>(null)
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<IssueSection | null>(() =>
    props.focus ? sectionOf(props.focus) : null,
  )
  const [retrying, setRetrying] = useState<IssueSection | null>(null)
  const retryInFlight = useRef(false)
  const [retryNote, setRetryNote] = useState('')
  const [sort, setSort] = useState<IndexViewSort>(() => savedView().sort)
  const [grouping, setGrouping] = useState<IndexViewGroup>(() => savedView().grouping)
  const [descending, setDescending] = useState(() => savedView().descending)
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ sort, grouping, descending }))
    } catch {
      /* View preferences are optional when storage is disabled. */
    }
  }, [sort, grouping, descending])
  const [loadFailed, setLoadFailed] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [working, setWorking] = useState(false)
  const [actionFailed, setActionFailed] = useState(false)

  useEffect(() => {
    if (props.focus) setOpenId(sectionOf(props.focus))
  }, [props.focus])

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      if (document.visibilityState === 'visible') {
        const [issues, conversion] = await Promise.allSettled([
          readIndexRequest(() => api.getDocumentIndexIssueSummary('*'), isIndexIssueSummary),
          readIndexRequest(
            () => api.getLegacyConvertState?.() ?? Promise.resolve(null),
            (value): value is LegacyConvertState | null =>
              value === null || isLegacyConvertState(value),
          ),
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
  const sections = buildIssueSections(summary?.groups ?? [])
  const total = (summary?.groups ?? []).reduce((n, group) => n + group.count, 0)
  // Searching, or grouping by something other than the reason, lists files across all groups at once.
  const flat = query.trim().length > 0 || grouping !== 'reason'

  const convert = async () => {
    if (working) return
    setWorking(true)
    setActionFailed(false)
    try {
      if (!api.startLegacyConvert) throw new Error('Legacy conversion is unavailable')
      const state = await api.startLegacyConvert()
      if (!isLegacyConvertState(state)) throw new Error('Invalid legacy conversion response')
      onChanged()
      setRefresh((n) => n + 1)
    } catch {
      setActionFailed(true)
    } finally {
      setWorking(false)
    }
  }

  const retryRow = async (row: IssueSectionRow) => {
    if (retryInFlight.current) return
    retryInFlight.current = true
    setRetrying(row.id)
    setRetryNote('')
    try {
      let queued = 0
      for (const reason of row.reasons.filter(isRetryableReason)) {
        const result = await runIndexMutation(() => api.retryDocumentIndexGroup('*', reason))
        if (!result.ok) throw new Error(result.error ?? 'retry failed')
        queued += result.retried
      }
      setRetryNote(fill(g.retried, { n: num(queued) }))
      onChanged()
      setRefresh((n) => n + 1)
    } catch {
      setRetryNote(g.retryFailed)
    } finally {
      retryInFlight.current = false
      setRetrying(null)
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

  const listFor = (row: IssueSectionRow) =>
    summary ? (
      <>
        <IndexProblems
          api={api}
          root="*"
          focus={props.focus && row.reasons.includes(props.focus) ? props.focus : null}
          onChanged={onChanged}
          hideEmpty
          summary={narrowSummary(summary, row.reasons)}
          bucket="all"
          sort={sort}
          grouping="reason"
          descending={descending}
        />
        <p className="todo-selection-hint">{d.selectionHint}</p>
      </>
    ) : null

  const toggle = (id: IssueSection) => setOpenId((current) => (current === id ? null : id))
  const rowView = (row: IssueSectionRow, title: string, hint: string, muted = false) => (
    <IssueRow
      key={row.id}
      row={row}
      title={title}
      hint={hint}
      num={num}
      open={openId === row.id}
      onToggle={() => toggle(row.id)}
      showLabel={g.show}
      hideLabel={g.hide}
      muted={muted}
      action={
        row.retryable ? (
          <button
            type="button"
            className="idx-btn idx-btn-sm"
            disabled={retrying !== null}
            onClick={() => void retryRow(row)}
          >
            {retrying === row.id ? g.retrying : g.retry}
          </button>
        ) : undefined
      }
    >
      {listFor(row)}
    </IssueRow>
  )

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
      {retryNote && (
        <p className="todo-status" role="status">
          {retryNote}
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
        <details className="idx-view-options">
          <summary>
            <span>{g.options}</span>
            <span className="idx-view-options-hint">{g.optionsHint}</span>
          </summary>
          <div className="todo-controls">
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
            </div>
            <div className="todo-view-controls">
              <select
                value={sort}
                aria-label={d.sort}
                onChange={(event) => setSort(event.target.value as IndexViewSort)}
              >
                <option value="queue">{d.queue}</option>
                <option value="name">{d.name}</option>
                <option value="folder">{lang === 'vi' ? 'Thư mục' : 'Folder'}</option>
                <option value="type">{lang === 'vi' ? 'Loại tệp' : 'File type'}</option>
                <option value="progress">{lang === 'vi' ? 'Tiến độ' : 'Progress'}</option>
                <option value="status">{lang === 'vi' ? 'Trạng thái' : 'Status'}</option>
                <option value="connection">
                  {lang === 'vi' ? 'Kết nối ổ' : 'Source connection'}
                </option>
              </select>
              <button
                type="button"
                className="idx-btn todo-sort-direction"
                aria-label={lang === 'vi' ? 'Đảo chiều sắp xếp' : 'Reverse sort direction'}
                aria-pressed={descending}
                title={
                  lang === 'vi'
                    ? descending
                      ? 'Giảm dần'
                      : 'Tăng dần'
                    : descending
                      ? 'Descending'
                      : 'Ascending'
                }
                onClick={() => setDescending((value) => !value)}
              >
                {descending ? '↓' : '↑'}
              </button>
              <select
                value={grouping}
                aria-label={lang === 'vi' ? 'Gom nhóm tệp' : 'Group files'}
                onChange={(event) => setGrouping(event.target.value as IndexViewGroup)}
              >
                <option value="reason">
                  {lang === 'vi' ? 'Nhóm theo vấn đề' : 'Group by issue'}
                </option>
                <option value="folder">
                  {lang === 'vi' ? 'Nhóm theo thư mục' : 'Group by folder'}
                </option>
                <option value="type">
                  {lang === 'vi' ? 'Nhóm theo loại tệp' : 'Group by file type'}
                </option>
                <option value="none">{lang === 'vi' ? 'Không gom nhóm' : 'No grouping'}</option>
              </select>
            </div>
          </div>
        </details>

        {summary && !loadFailed && total === 0 && (
          <section className="todo-empty">
            <span className="todo-empty-mark" aria-hidden="true">
              ✓
            </span>
            <strong>{d.healthyTitle}</strong>
            <p>{d.healthyBody}</p>
          </section>
        )}

        {summary && total > 0 && flat && (
          <>
            <IndexProblems
              api={api}
              root="*"
              focus={props.focus}
              onChanged={onChanged}
              query={query}
              hideEmpty
              summary={summary}
              bucket="all"
              sort={sort}
              grouping={grouping}
              descending={descending}
            />
            <p className="todo-selection-hint">{d.selectionHint}</p>
          </>
        )}

        {summary && total > 0 && !flat && (
          <div className="idx-issues">
            {sections.needs.length > 0 && (
              <section aria-label={g.needs}>
                <h3 className="idx-issues-title">{g.needs}</h3>
                <ul className="idx-issue-list">
                  {sections.needs.map((row) =>
                    rowView(
                      row,
                      g.cat[row.id as keyof typeof g.cat].title,
                      g.cat[row.id as keyof typeof g.cat].hint,
                    ),
                  )}
                </ul>
              </section>
            )}
            {sections.waiting && (
              <section aria-label={g.queue}>
                <h3 className="idx-issues-title">{g.queue}</h3>
                <ul className="idx-issue-list">
                  {rowView(sections.waiting, g.waitingTitle, g.waitingHint, true)}
                </ul>
              </section>
            )}
            {sections.auto && (
              <section aria-label={g.auto}>
                <h3 className="idx-issues-title">{g.auto}</h3>
                <ul className="idx-issue-list">
                  {rowView(sections.auto, g.autoTitle, g.autoHint, true)}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
