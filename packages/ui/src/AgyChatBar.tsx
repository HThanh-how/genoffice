import { useCallback, useEffect, useRef, useState } from 'react'
import './agy-chat-bar.css'

/* Structural copies of the types in @genoffice/ai-provider/agy-chat: this package stays free of
   that dependency, and the preload helper in electron-utils returns exactly these shapes. */
export interface AgyBarModel {
  id: string
  label: string
  group: string | null
  relativeCost: number
  speed: 'fast' | 'balanced' | 'slow'
}
export interface AgyBarState {
  models: AgyBarModel[]
  selected: string
  active: boolean
}
export interface AgyBarUsage {
  groups: Array<{
    name: string
    buckets: Array<{ window: '5h' | 'weekly'; remaining: number; resetAt?: number }>
  }> | null
  readAt: number
  refreshing: boolean
  failed: boolean
}
export interface AgyBarActivity {
  runId: string
  phase: 'start' | 'thinking' | 'tool' | 'writing' | 'done' | 'error'
  at: number
  tool?: string
  target?: string
  thinkingTokens?: number
  stepSeconds?: number
  message?: string
}
export interface AgyBarApi {
  getAgyChatState(): Promise<AgyBarState>
  selectAgyChatModel(id: string): Promise<boolean>
  getAgyChatUsage(): Promise<AgyBarUsage>
  refreshAgyChatUsage(): Promise<AgyBarUsage>
  onAgyChatUsage(handler: (state: AgyBarUsage) => void): () => void
  onAgyChatActivity?(handler: (activity: AgyBarActivity) => void): () => void
}

interface RunStep {
  kind: 'thinking' | 'tool' | 'writing'
  tool?: string
  target?: string
  tokens?: number
  seconds?: number
}
interface Run {
  id: string
  startedAt: number
  endedAt?: number
  steps: RunStep[]
  phase: 'thinking' | 'tool' | 'writing' | 'done' | 'error'
  tool?: string
  target?: string
  tokens: number
  error?: string
}

function reduceRun(run: Run | null, event: AgyBarActivity): Run | null {
  if (event.phase === 'start')
    return {
      id: event.runId,
      startedAt: event.at,
      steps: [],
      phase: 'thinking',
      tokens: 0,
    }
  if (!run || run.id !== event.runId) return run
  if (event.phase === 'thinking')
    return {
      ...run,
      phase: 'thinking',
      tokens: run.tokens + (event.thinkingTokens ?? 0),
      steps: [
        ...run.steps,
        {
          kind: 'thinking',
          ...(event.thinkingTokens ? { tokens: event.thinkingTokens } : {}),
          ...(event.stepSeconds !== undefined ? { seconds: event.stepSeconds } : {}),
        },
      ],
    }
  if (event.phase === 'tool') {
    const open = run.steps.findIndex(
      (step) =>
        step.kind === 'tool' &&
        step.tool === event.tool &&
        step.target === event.target &&
        step.seconds === undefined,
    )
    if (open >= 0 && event.stepSeconds !== undefined) {
      const steps = run.steps.slice()
      steps[open] = { ...steps[open]!, seconds: event.stepSeconds }
      return { ...run, steps }
    }
    return {
      ...run,
      phase: 'tool',
      ...(event.tool ? { tool: event.tool } : {}),
      ...(event.target ? { target: event.target } : {}),
      steps: [
        ...run.steps,
        {
          kind: 'tool',
          ...(event.tool ? { tool: event.tool } : {}),
          ...(event.target ? { target: event.target } : {}),
        },
      ],
    }
  }
  if (event.phase === 'writing')
    return run.phase === 'writing'
      ? run
      : { ...run, phase: 'writing', steps: [...run.steps, { kind: 'writing' }] }
  if (event.phase === 'done') return { ...run, phase: 'done', endedAt: event.at }
  return {
    ...run,
    phase: 'error',
    endedAt: event.at,
    ...(event.message ? { error: event.message } : {}),
  }
}

const MODEL_CHANGED = 'genoffice-agy-model-changed'
/** how long the readout stays open after a check, before it tucks itself away */
const PEEK_MS = 3500

const EN = {
  model: 'Chat model',
  fast: 'Fast',
  balanced: 'Balanced',
  slow: 'Slower',
  cost: 'Uses about {n}× the quota',
  costBase: 'Lightest on quota',
  more: 'More models can be turned on in Settings → AI model.',
  usage: 'Antigravity usage',
  fiveHour: '5-hour limit',
  weekly: 'Weekly limit',
  left: '{p}% left',
  resets: 'refills in {t}',
  checking: 'Checking…',
  checked: 'Checked {t}',
  justNow: 'just now',
  ago: '{t} ago',
  recheck: 'Check again',
  failed: 'Could not read the usage. Showing the last numbers.',
  none: 'No reading yet',
  d: 'd',
  h: 'h',
  m: 'min',
  thinkingNow: 'Thinking',
  usingTool: 'Using {tool}',
  stepTool: 'Used {tool}',
  writing: 'Writing the answer',
  doneIn: 'Done in {t}',
  thoughtTokens: '{n} thinking tokens',
  stepThinking: 'Thinking',
  stepWriting: 'Writing the answer',
  showSteps: 'Show steps',
  hideSteps: 'Hide steps',
  noText: 'The model does not share its reasoning text, only how long it thought.',
  runFailed: 'Stopped: {m}',
}
type Dict = Record<keyof typeof EN, string>

const TEXT: Record<'en' | 'vi' | 'zh', Dict> = {
  en: EN,
  vi: {
    model: 'Model trò chuyện',
    fast: 'Nhanh',
    balanced: 'Cân bằng',
    slow: 'Chậm hơn',
    cost: 'Tốn quota khoảng {n} lần',
    costBase: 'Tiết kiệm quota nhất',
    more: 'Có thể bật thêm model trong Cài đặt → Mô hình AI.',
    usage: 'Mức dùng Antigravity',
    fiveHour: 'Hạn mức 5 giờ',
    weekly: 'Hạn mức tuần',
    left: 'Còn {p}%',
    resets: 'làm mới sau {t}',
    checking: 'Đang kiểm tra…',
    checked: 'Kiểm tra {t}',
    justNow: 'vừa xong',
    ago: '{t} trước',
    recheck: 'Kiểm tra lại',
    failed: 'Không đọc được mức dùng. Đang hiện số liệu lần trước.',
    none: 'Chưa có số liệu',
    d: 'ngày',
    h: 'giờ',
    m: 'phút',
    thinkingNow: 'Đang suy nghĩ',
    usingTool: 'Đang dùng {tool}',
    stepTool: 'Dùng {tool}',
    writing: 'Đang viết câu trả lời',
    doneIn: 'Xong trong {t}',
    thoughtTokens: '{n} token suy nghĩ',
    stepThinking: 'Suy nghĩ',
    stepWriting: 'Viết câu trả lời',
    showSteps: 'Xem các bước',
    hideSteps: 'Ẩn các bước',
    noText: 'Model không chia sẻ nội dung suy nghĩ, chỉ cho biết nó đã nghĩ bao lâu.',
    runFailed: 'Đã dừng: {m}',
  },
  zh: {
    model: '聊天模型',
    fast: '快速',
    balanced: '均衡',
    slow: '较慢',
    cost: '约消耗 {n} 倍额度',
    costBase: '最省额度',
    more: '可在 设置 → AI 模型 中启用更多模型。',
    usage: 'Antigravity 用量',
    fiveHour: '5 小时额度',
    weekly: '每周额度',
    left: '剩余 {p}%',
    resets: '{t}后刷新',
    checking: '检查中…',
    checked: '{t}检查',
    justNow: '刚刚',
    ago: '{t}前',
    recheck: '重新检查',
    failed: '无法读取用量，显示上次的数据。',
    none: '暂无数据',
    d: '天',
    h: '小时',
    m: '分钟',
    thinkingNow: '思考中',
    usingTool: '正在使用 {tool}',
    stepTool: '使用 {tool}',
    writing: '正在撰写回答',
    doneIn: '用时 {t}',
    thoughtTokens: '{n} 个思考 token',
    stepThinking: '思考',
    stepWriting: '撰写回答',
    showSteps: '查看步骤',
    hideSteps: '隐藏步骤',
    noText: '模型不会公开思考内容，只显示思考了多久。',
    runFailed: '已停止：{m}',
  },
}

function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
}

function span(ms: number, d: Dict): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes >= 2880) return `${Math.round(minutes / 1440)} ${d.d}`
  if (minutes >= 90) return `${Math.floor(minutes / 60)} ${d.h} ${minutes % 60} ${d.m}`
  return `${minutes} ${d.m}`
}

function thinkTitle(run: Run, d: Dict): string {
  const seconds = Math.max(0, ((run.endedAt ?? Date.now()) - run.startedAt) / 1000)
  const time = seconds >= 60 ? span(seconds * 1000, d) : `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  if (run.phase === 'done') return fill(d.doneIn, { t: time })
  if (run.phase === 'error') return fill(d.runFailed, { m: run.error ?? '' })
  const label =
    run.phase === 'writing'
      ? d.writing
      : run.phase === 'tool'
        ? fill(d.usingTool, {
            tool: `${run.tool ?? ''}${run.target ? ` ${run.target}` : ''}`.trim(),
          })
        : d.thinkingNow
  return `${label}… ${time}`
}

function tone(remaining: number): 'ok' | 'warn' | 'low' {
  return remaining >= 0.5 ? 'ok' : remaining >= 0.2 ? 'warn' : 'low'
}

function bridge(): AgyBarApi | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window as unknown as { agyChat?: AgyBarApi }).agyChat
}

/**
 * Model chooser and quota readout shown right under an AI chat box when the Antigravity provider
 * is active (it renders nothing otherwise). The readout is stale-while-revalidate: it shows the
 * last numbers at once, the app re-reads them once at launch, and the details panel opens by
 * itself during that check and tucks away a few seconds after it finishes.
 */
export function AgyChatBar({
  lang,
  api,
  part = 'all',
}: {
  lang: string
  api?: AgyBarApi | undefined
  /** 'bar' = model + usage chips only, 'steps' = the live thinking strip only (placed by the host) */
  part?: 'all' | 'bar' | 'steps'
}) {
  const d: Dict = (TEXT as Record<string, Dict | undefined>)[lang] ?? EN
  const [state, setState] = useState<AgyBarState | null>(null)
  const [usage, setUsage] = useState<AgyBarUsage | null>(null)
  const [menu, setMenu] = useState(false)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(false)
  const hovering = useRef(false)
  const wasRefreshing = useRef(false)
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [, tick] = useState(0)
  const [run, setRun] = useState<Run | null>(null)
  const [steps, setSteps] = useState(false)

  const source = api ?? bridge()

  const loadState = useCallback(async () => {
    try {
      const next = await source?.getAgyChatState()
      if (next) setState(next)
    } catch {
      // keep what is shown
    }
  }, [source])

  const schedulePeekEnd = useCallback(() => {
    if (peekTimer.current) clearTimeout(peekTimer.current)
    peekTimer.current = setTimeout(() => {
      if (!pinned.current && !hovering.current) setOpen(false)
    }, PEEK_MS)
  }, [])

  const apply = useCallback(
    (next: AgyBarUsage) => {
      setUsage(next)
      if (next.refreshing) {
        wasRefreshing.current = true
        if (!pinned.current) setOpen(true)
      } else if (wasRefreshing.current) {
        wasRefreshing.current = false
        if (!pinned.current) {
          setOpen(true)
          schedulePeekEnd()
        }
      }
    },
    [schedulePeekEnd],
  )

  useEffect(() => {
    if (!source) return
    void loadState()
    void source
      .getAgyChatUsage()
      .then(apply)
      .catch(() => {})
    const off = source.onAgyChatUsage(apply)
    const offRun = source.onAgyChatActivity?.((event) =>
      setRun((current) => reduceRun(current, event)),
    )
    const onFocus = () => void loadState()
    window.addEventListener('focus', onFocus)
    window.addEventListener(MODEL_CHANGED, onFocus)
    const clock = setInterval(() => tick((n) => n + 1), 30_000)
    return () => {
      off()
      offRun?.()
      window.removeEventListener('focus', onFocus)
      window.removeEventListener(MODEL_CHANGED, onFocus)
      clearInterval(clock)
      if (peekTimer.current) clearTimeout(peekTimer.current)
    }
  }, [source, loadState, apply])

  const running = !!run && run.phase !== 'done' && run.phase !== 'error'
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [running])

  useEffect(() => {
    if (!menu && !open) return
    const hide = () => {
      setMenu(false)
      setOpen(false)
      pinned.current = false
    }
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) hide()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('keydown', key)
    }
  }, [menu, open])

  if (!source || !state?.active) return null
  const showBar = part !== 'steps'
  const showSteps = part !== 'bar'

  const current = state.models.find((model) => model.id === state.selected) ?? state.models[0]
  const group = current?.group
  const buckets = usage?.groups?.find((g) => g.name === group)?.buckets ?? []
  const five = buckets.find((b) => b.window === '5h')
  const week = buckets.find((b) => b.window === 'weekly')
  const worst = [five, week]
    .filter(Boolean)
    .reduce<number | null>(
      (min, b) => (min === null || b!.remaining < min ? b!.remaining : min),
      null,
    )

  const choose = async (id: string) => {
    setMenu(false)
    if (id === state.selected) return
    if (await source.selectAgyChatModel(id)) {
      await loadState()
      window.dispatchEvent(new Event(MODEL_CHANGED))
    }
  }

  const recheck = () => {
    pinned.current = false
    void source
      .refreshAgyChatUsage()
      .then(apply)
      .catch(() => {})
  }

  const speedLabel = (model: AgyBarModel) =>
    model.speed === 'fast' ? d.fast : model.speed === 'slow' ? d.slow : d.balanced

  const bucketRow = (
    label: string,
    bucket: AgyBarUsage['groups'] extends infer _ ? typeof five : never,
  ) =>
    bucket ? (
      <div className="agy-bar-row">
        <div className="agy-bar-row-head">
          <span>{label}</span>
          <strong>{fill(d.left, { p: Math.round(bucket.remaining * 100) })}</strong>
        </div>
        <div
          className={`agy-bar-track is-${tone(bucket.remaining)}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(bucket.remaining * 100)}
          aria-label={label}
        >
          <div
            className="agy-bar-fill"
            style={{ width: `${Math.max(2, bucket.remaining * 100)}%` }}
          />
        </div>
        {bucket.resetAt && (
          <span className="agy-bar-reset">
            {fill(d.resets, { t: span(Math.max(0, bucket.resetAt - Date.now()), d) })}
          </span>
        )}
      </div>
    ) : null

  const ago = usage?.readAt
    ? Date.now() - usage.readAt < 45_000
      ? d.justNow
      : fill(d.ago, { t: span(Date.now() - usage.readAt, d) })
    : ''

  return (
    <div
      className={`agy-bar${part === 'steps' ? ' is-steps' : ''}`}
      ref={rootRef}
      onMouseEnter={() => {
        hovering.current = true
      }}
      onMouseLeave={() => {
        hovering.current = false
        if (open && !usage?.refreshing) {
          pinned.current = false
          schedulePeekEnd()
        }
      }}
    >
      {showBar && open && (
        <section className="agy-bar-drawer" aria-label={d.usage} aria-live="polite">
          <header>
            <strong>{d.usage}</strong>
            <span className="agy-bar-when">
              {usage?.refreshing ? d.checking : ago ? fill(d.checked, { t: ago }) : d.none}
            </span>
          </header>
          {usage?.refreshing && !five && !week ? (
            <div className="agy-bar-skeleton" aria-hidden="true">
              <i />
              <i />
            </div>
          ) : (
            <>
              {bucketRow(d.fiveHour, five)}
              {bucketRow(d.weekly, week)}
            </>
          )}
          {usage?.failed && <p className="agy-bar-note">{d.failed}</p>}
          <footer>
            <button type="button" onClick={recheck} disabled={usage?.refreshing}>
              {d.recheck}
            </button>
          </footer>
        </section>
      )}
      {showBar && menu && (
        <div className="agy-bar-menu" role="listbox" aria-label={d.model}>
          {state.models.map((model) => (
            <button
              key={model.id}
              type="button"
              role="option"
              aria-selected={model.id === state.selected}
              className={model.id === state.selected ? 'is-selected' : ''}
              onClick={() => void choose(model.id)}
            >
              <span className="agy-bar-menu-main">
                <strong>{model.label}</strong>
                <span className={`agy-bar-pill is-${model.speed}`}>{speedLabel(model)}</span>
              </span>
              <span className="agy-bar-menu-sub">
                {model.relativeCost <= 1 ? d.costBase : fill(d.cost, { n: model.relativeCost })}
              </span>
            </button>
          ))}
          <p className="agy-bar-note">{d.more}</p>
        </div>
      )}
      {showSteps && run && (
        <section className={`agy-think is-${run.phase}`} aria-live="polite">
          <button
            type="button"
            className="agy-think-head"
            aria-expanded={steps}
            onClick={() => setSteps((value) => !value)}
          >
            <span className="agy-think-dot" aria-hidden="true" />
            <span className="agy-think-title">{thinkTitle(run, d)}</span>
            {run.tokens > 0 && (
              <span className="agy-think-meta">{fill(d.thoughtTokens, { n: run.tokens })}</span>
            )}
            <span className="agy-think-toggle">{steps ? d.hideSteps : d.showSteps}</span>
          </button>
          {steps && (
            <div className="agy-think-body">
              <ol>
                {run.steps.map((step, index) => (
                  <li key={index} className={`is-${step.kind}`}>
                    <span className="agy-think-step-name">
                      {step.kind === 'thinking'
                        ? d.stepThinking
                        : step.kind === 'writing'
                          ? d.stepWriting
                          : fill(d.stepTool, { tool: step.tool ?? '' })}
                      {step.target && <code>{step.target}</code>}
                    </span>
                    <span className="agy-think-step-meta">
                      {step.tokens ? fill(d.thoughtTokens, { n: step.tokens }) : ''}
                      {step.seconds !== undefined ? ` ${step.seconds.toFixed(1)}s` : ''}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="agy-bar-note">{d.noText}</p>
            </div>
          )}
        </section>
      )}
      {showBar && (
        <div className="agy-bar-row-main">
          <button
            type="button"
            className="agy-bar-chip agy-bar-model"
            aria-haspopup="listbox"
            aria-expanded={menu}
            title={d.model}
            onClick={() => {
              setMenu((value) => !value)
            }}
          >
            <span className="agy-bar-model-name">{current?.label ?? state.selected}</span>
            <span aria-hidden="true" className="agy-bar-caret">
              ▾
            </span>
          </button>
          <button
            type="button"
            className={`agy-bar-chip agy-bar-usage${worst === null ? '' : ` is-${tone(worst)}`}`}
            aria-expanded={open}
            title={d.usage}
            onClick={() => {
              pinned.current = !open
              setOpen((value) => !value)
            }}
          >
            <span
              className={`agy-bar-gauge${usage?.refreshing ? ' is-spinning' : ''}`}
              aria-hidden="true"
              style={{ ['--agy-fill' as string]: `${Math.round((worst ?? 0) * 100)}%` }}
            />
            <span>
              {usage?.refreshing && worst === null
                ? '…'
                : worst === null
                  ? '–'
                  : `${Math.round(worst * 100)}%`}
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
