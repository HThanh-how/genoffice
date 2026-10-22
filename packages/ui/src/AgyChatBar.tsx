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
  /** false when the person switched this model off in the AGY model settings */
  enabled?: boolean
}
export interface AgyBarState {
  models: AgyBarModel[]
  selected: string
  active: boolean
  /** ids the installed CLI confirmed it can serve (empty when the catalog could not be read) */
  available?: string[]
  /** how well the selected model is supported by the CLI configured now */
  selectedStatus?: 'verified' | 'unavailable' | 'unverified' | 'none'
  /** set when `agy models` could not be read, so the list is unverified */
  catalogError?: string
}
export interface AgyBarUsage {
  groups: Array<{
    name: string
    buckets: Array<{ window: '5h' | 'weekly'; remaining: number; resetAt?: number }>
  }> | null
  readAt: number
  refreshing: boolean
  failed: boolean
  needsLogin?: boolean
  cliMissing?: boolean
}
export interface AgyBarActivity {
  runId: string
  requestId?: string
  sessionId?: string
  phase: 'start' | 'thinking' | 'tool' | 'writing' | 'done' | 'error'
  at: number
  model?: string
  tool?: string
  target?: string
  thinkingTokens?: number
  stepSeconds?: number
  message?: string
}
export interface AgyBarLogin {
  phase: 'idle' | 'starting' | 'waiting' | 'checking' | 'done' | 'failed'
  url?: string
  error?: 'cli-missing' | 'rejected' | 'timeout' | 'failed'
}
export interface AgyBarInstall {
  phase: 'idle' | 'installing' | 'done' | 'failed'
  output?: string
  error?: 'script-failed' | 'not-found-after' | 'timeout' | 'unsupported' | 'busy'
}
export interface AgyBarApi {
  startAgyInstall?(): Promise<AgyBarInstall>
  onAgyInstall?(handler: (state: AgyBarInstall) => void): () => void
  startAgyLogin?(): Promise<AgyBarLogin>
  submitAgyLoginCode?(code: string): Promise<boolean>
  cancelAgyLogin?(): Promise<void>
  onAgyLogin?(handler: (state: AgyBarLogin) => void): () => void
  getAgyChatState(): Promise<AgyBarState>
  selectAgyChatModel(id: string, activateProvider?: boolean): Promise<boolean>
  getAgyChatUsage(): Promise<AgyBarUsage>
  refreshAgyChatUsage(): Promise<AgyBarUsage>
  onAgyChatUsage(handler: (state: AgyBarUsage) => void): () => void
  onAgyChatActivity?(handler: (activity: AgyBarActivity) => void): () => void
  onAgyChatModelChanged?(handler: () => void): () => void
}

interface RunStep {
  kind: 'thinking' | 'tool' | 'writing'
  tool?: string
  target?: string
  tokens?: number
  seconds?: number
}
export interface Run {
  id: string
  requestId?: string
  sessionId?: string
  model?: string
  startedAt: number
  endedAt?: number
  steps: RunStep[]
  phase: 'thinking' | 'tool' | 'writing' | 'done' | 'error'
  /** epoch ms of the latest event of this run */
  lastAt?: number
  tool?: string
  target?: string
  tokens: number
  error?: string
}

export function reduceRun(run: Run | null, event: AgyBarActivity): Run | null {
  const next = reduceRunStep(run, event)
  return next && next !== run ? { ...next, lastAt: event.at } : next
}

function reduceRunStep(run: Run | null, event: AgyBarActivity): Run | null {
  if (event.phase === 'start')
    return {
      id: event.runId,
      ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
      ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
      ...(event.model !== undefined ? { model: event.model } : {}),
      startedAt: event.at,
      steps: [],
      phase: 'thinking',
      tokens: 0,
    }
  if (!run || run.id !== event.runId) {
    if (event.phase === 'thinking' || event.phase === 'tool' || event.phase === 'writing') {
      return {
        id: event.runId,
        ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
        ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
        ...(event.model !== undefined ? { model: event.model } : {}),
        startedAt: event.at,
        steps: [],
        phase: event.phase,
        tokens: event.thinkingTokens ?? 0,
        ...(event.tool !== undefined ? { tool: event.tool } : {}),
        ...(event.target !== undefined ? { target: event.target } : {}),
      }
    }
    return run
  }
  const model = event.model ?? run.model
  if (event.phase === 'thinking')
    return {
      ...run,
      ...(model !== undefined ? { model } : {}),
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
      return { ...run, ...(model !== undefined ? { model } : {}), steps }
    }
    return {
      ...run,
      ...(model !== undefined ? { model } : {}),
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
    return run.phase === 'writing' && (!model || run.model === model)
      ? run
      : {
          ...run,
          ...(model !== undefined ? { model } : {}),
          phase: 'writing',
          steps: [...run.steps, { kind: 'writing' }],
        }
  if (event.phase === 'done')
    return { ...run, ...(model !== undefined ? { model } : {}), phase: 'done', endedAt: event.at }
  return {
    ...run,
    ...(model !== undefined ? { model } : {}),
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
  unverified:
    'The Antigravity CLI did not return a model list, so these models are not confirmed as available.',
  unavailableModel:
    'The model you chose is not in the Antigravity CLI list any more. Pick one below.',
  noModel: 'No chat model available',
  noModelHint:
    'The Antigravity CLI reported no chat model it can serve. Check the Antigravity connection in Settings, or choose another chat provider.',
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
  needsLogin:
    'Antigravity is not signed in on this computer. Run `agy` once in a terminal and log in.',
  none: 'No reading yet',
  unavailable: 'Usage unavailable',
  d: 'd',
  h: 'h',
  m: 'min',
  thinkingNow: 'Thinking',
  thinkingHome: 'Thinking…',
  searchingFiles: 'Searching files…',
  readingDocs: 'Reading documents…',
  writingAnswer: 'Writing answer…',
  starting: 'Starting Antigravity',
  usingTool: 'Using {tool}',
  stepTool: 'Used {tool}',
  actRead: 'Reading {t}',
  actReadAny: 'Reading a file',
  actWrite: 'Writing {t}',
  actWriteAny: 'Writing a file',
  actCommand: 'Running a command',
  actSearch: 'Searching {t}',
  actSearchAny: 'Searching',
  actBrowse: 'Browsing',
  actWork: 'Working',
  actDocCreate: 'Creating the document',
  actDocCreateNamed: 'Creating “{t}”',
  actDocSection: 'Writing the next section',
  actDocSectionNamed: 'Writing section: {t}',
  actDocSectionOf: 'Writing section {k} of {n}: {t}',
  stillWorking: 'Still working… ({n}s)',
  stageRead: 'Reading your request…',
  stageThink: 'Thinking it through…',
  stageDraft: 'Drafting the answer — long documents can take 2-3 minutes',
  stageLate: 'Taking longer than usual… still working; you can stop and try again',
  writing: 'Writing the answer',
  doneIn: 'Done in {t}',
  thoughtTokens: '{n} thinking tokens',
  stepThinking: 'Thinking',
  stepWriting: 'Writing the answer',
  showSteps: 'Show steps',
  hideSteps: 'Hide steps',
  noText: 'The model does not share its reasoning text, only how long it thought.',
  runFailed: 'Stopped: {m}',
  loginTitle: 'Sign in to Antigravity',
  loginIntro:
    'This computer is not signed in yet. Sign in with your Google account to use Antigravity here.',
  loginStart: 'Sign in with Google',
  loginStarting: 'Opening the browser…',
  loginWaiting:
    'Sign in in the browser. If the page shows a code, paste it here; otherwise just wait a moment.',
  loginPlaceholder: 'Paste the code',
  loginSend: 'Continue',
  loginChecking: 'Checking the code…',
  loginDone: 'Signed in.',
  loginRejected: 'That code was not accepted. Try again.',
  loginTimeout: 'The sign-in timed out. Try again.',
  loginMissing: 'Antigravity is not installed on this computer.',
  installTitle: 'Install Antigravity',
  installIntro:
    'Antigravity is not installed on this computer. GenOffice can download and run Google’s own installer (antigravity.google) for your account only. No administrator rights are needed.',
  installStart: 'Install Antigravity',
  installing: 'Installing… this takes about a minute.',
  installDone: 'Installed. Next, sign in with Google.',
  installFailed: 'The installation did not finish. Check the internet connection and try again.',
  installRetry: 'Try again',
  loginReopen: 'Open the page again',
  loginCancel: 'Cancel',
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
    unverified: 'Antigravity CLI không trả danh sách model, nên chưa xác nhận được model khả dụng.',
    unavailableModel:
      'Model bạn đã chọn không còn trong danh sách của Antigravity CLI. Hãy chọn model bên dưới.',
    noModel: 'Không có model chat khả dụng',
    noModelHint:
      'Antigravity CLI không báo model chat nào có thể dùng. Hãy kiểm tra kết nối Antigravity trong Cài đặt, hoặc chọn provider chat khác.',
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
    needsLogin:
      'Antigravity chưa đăng nhập trên máy này. Hãy chạy `agy` một lần trong terminal và đăng nhập.',
    none: 'Chưa có số liệu',
    unavailable: 'Không đọc được mức dùng',
    d: 'ngày',
    h: 'giờ',
    m: 'phút',
    thinkingNow: 'Đang suy nghĩ',
    thinkingHome: 'Đang suy nghĩ…',
    searchingFiles: 'Đang tìm kiếm tệp…',
    readingDocs: 'Đang đọc tài liệu…',
    writingAnswer: 'Đang viết câu trả lời…',
    starting: 'Đang khởi động Antigravity',
    usingTool: 'Đang dùng {tool}',
    stepTool: 'Dùng {tool}',
    actRead: 'Đang đọc {t}',
    actReadAny: 'Đang đọc một tệp',
    actWrite: 'Đang ghi {t}',
    actWriteAny: 'Đang ghi một tệp',
    actCommand: 'Đang chạy một lệnh',
    actSearch: 'Đang tìm {t}',
    actSearchAny: 'Đang tìm kiếm',
    actBrowse: 'Đang duyệt web',
    actWork: 'Đang xử lý',
    actDocCreate: 'Đang tạo tài liệu',
    actDocCreateNamed: 'Đang tạo “{t}”',
    actDocSection: 'Đang viết phần tiếp theo',
    actDocSectionNamed: 'Đang viết phần: {t}',
    actDocSectionOf: 'Đang viết phần {k}/{n}: {t}',
    stillWorking: 'Vẫn đang xử lý… ({n}s)',
    stageRead: 'Đang đọc yêu cầu của bạn…',
    stageThink: 'Đang suy nghĩ…',
    stageDraft: 'Đang soạn câu trả lời — tài liệu dài có thể mất 2-3 phút',
    stageLate: 'Lâu hơn bình thường… vẫn đang làm; bạn có thể dừng và thử lại',
    writing: 'Đang viết câu trả lời',
    doneIn: 'Xong trong {t}',
    thoughtTokens: '{n} token suy nghĩ',
    stepThinking: 'Suy nghĩ',
    stepWriting: 'Viết câu trả lời',
    showSteps: 'Xem các bước',
    hideSteps: 'Ẩn các bước',
    noText: 'Model không chia sẻ nội dung suy nghĩ, chỉ cho biết nó đã nghĩ bao lâu.',
    runFailed: 'Đã dừng: {m}',
    loginTitle: 'Đăng nhập Antigravity',
    loginIntro:
      'Máy này chưa đăng nhập. Hãy đăng nhập bằng tài khoản Google để dùng Antigravity ở đây.',
    loginStart: 'Đăng nhập bằng Google',
    loginStarting: 'Đang mở trình duyệt…',
    loginWaiting:
      'Đăng nhập trong trình duyệt. Nếu trang hiện mã thì dán vào đây, không thì chỉ cần đợi một lúc.',
    loginPlaceholder: 'Dán mã vào đây',
    loginSend: 'Tiếp tục',
    loginChecking: 'Đang kiểm tra mã…',
    loginDone: 'Đã đăng nhập.',
    loginRejected: 'Mã không được chấp nhận. Hãy thử lại.',
    loginTimeout: 'Hết thời gian đăng nhập. Hãy thử lại.',
    loginMissing: 'Máy này chưa cài Antigravity.',
    installTitle: 'Cài Antigravity',
    installIntro:
      'Máy này chưa cài Antigravity. GenOffice có thể tải và chạy bộ cài chính thức của Google (antigravity.google) chỉ cho tài khoản của bạn, không cần quyền quản trị.',
    installStart: 'Cài Antigravity',
    installing: 'Đang cài… khoảng một phút.',
    installDone: 'Đã cài xong. Tiếp theo hãy đăng nhập bằng Google.',
    installFailed: 'Cài chưa xong. Kiểm tra mạng rồi thử lại.',
    installRetry: 'Thử lại',
    loginReopen: 'Mở lại trang đăng nhập',
    loginCancel: 'Huỷ',
  },
  zh: {
    model: '聊天模型',
    fast: '快速',
    balanced: '均衡',
    slow: '较慢',
    cost: '约消耗 {n} 倍额度',
    costBase: '最省额度',
    more: '可在 设置 → AI 模型 中启用更多模型。',
    unverified: 'Antigravity CLI 未返回模型列表，因此这些模型未被确认可用。',
    unavailableModel: '你选择的模型已不在 Antigravity CLI 列表中。请在下方选择另一个模型。',
    noModel: '无可用聊天模型',
    noModelHint:
      'Antigravity CLI 未报告可使用的聊天模型。请在设置中检查 Antigravity 连接，或选择其他聊天提供商。',
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
    needsLogin: '此电脑上的 Antigravity 尚未登录。请在终端运行一次 `agy` 并登录。',
    none: '暂无数据',
    unavailable: '无法读取用量',
    d: '天',
    h: '小时',
    m: '分钟',
    thinkingNow: '思考中',
    thinkingHome: '思考中…',
    searchingFiles: '正在搜索文件…',
    readingDocs: '正在阅读文档…',
    writingAnswer: '正在撰写回答…',
    starting: '正在启动 Antigravity',
    usingTool: '正在使用 {tool}',
    stepTool: '使用 {tool}',
    actRead: '正在阅读 {t}',
    actReadAny: '正在阅读文件',
    actWrite: '正在写入 {t}',
    actWriteAny: '正在写入文件',
    actCommand: '正在运行命令',
    actSearch: '正在搜索 {t}',
    actSearchAny: '正在搜索',
    actBrowse: '正在浏览网页',
    actWork: '正在处理',
    actDocCreate: '正在创建文档',
    actDocCreateNamed: '正在创建“{t}”',
    actDocSection: '正在撰写下一部分',
    actDocSectionNamed: '正在撰写：{t}',
    actDocSectionOf: '正在撰写第 {k}/{n} 部分：{t}',
    stillWorking: '仍在处理…（{n} 秒）',
    stageRead: '正在阅读你的请求…',
    stageThink: '正在思考…',
    stageDraft: '正在撰写回答，长文档可能需要 2-3 分钟',
    stageLate: '耗时比平时长…仍在处理；你可以停止后重试',
    writing: '正在撰写回答',
    doneIn: '用时 {t}',
    thoughtTokens: '{n} 个思考 token',
    stepThinking: '思考',
    stepWriting: '撰写回答',
    showSteps: '查看步骤',
    hideSteps: '隐藏步骤',
    noText: '模型不会公开思考内容，只显示思考了多久。',
    runFailed: '已停止：{m}',
    loginTitle: '登录 Antigravity',
    loginIntro: '此电脑尚未登录。请使用 Google 账号登录以在此使用 Antigravity。',
    loginStart: '使用 Google 登录',
    loginStarting: '正在打开浏览器…',
    loginWaiting: '在浏览器中登录。如果页面显示代码，请粘贴到这里；否则稍等片刻即可。',
    loginPlaceholder: '粘贴代码',
    loginSend: '继续',
    loginChecking: '正在验证代码…',
    loginDone: '已登录。',
    loginRejected: '代码未被接受，请重试。',
    loginTimeout: '登录超时，请重试。',
    loginMissing: '此电脑未安装 Antigravity。',
    installTitle: '安装 Antigravity',
    installIntro:
      '此电脑尚未安装 Antigravity。GenOffice 可以仅为您的账户下载并运行 Google 官方安装程序（antigravity.google），无需管理员权限。',
    installStart: '安装 Antigravity',
    installing: '正在安装……大约需要一分钟。',
    installDone: '已安装。接下来请使用 Google 登录。',
    installFailed: '安装未完成。请检查网络后重试。',
    installRetry: '重试',
    loginReopen: '重新打开登录页面',
    loginCancel: '取消',
  },
}

function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
}

/** running clock for the home chat: `45s`, `1:05`, `1:02:03` (no unit words, so no locale keys) */
export function clockTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** `812`, `1.2k`, `15.4k`: keeps the token chip short */
export function compactTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.floor(n)))
  return `${(n / 1000).toFixed(1)}k`
}

function span(ms: number, d: Dict): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes >= 2880) return `${Math.round(minutes / 1440)} ${d.d}`
  if (minutes >= 90) return `${Math.floor(minutes / 60)} ${d.h} ${minutes % 60} ${d.m}`
  return `${minutes} ${d.m}`
}

/** What the agent is doing, in plain words: `read_file` + `a.docx` becomes "Reading a.docx". */
export function toolActivityLabel(
  tool: string | undefined,
  target: string | undefined,
  d: Pick<
    Dict,
    | 'actRead'
    | 'actReadAny'
    | 'actWrite'
    | 'actWriteAny'
    | 'actCommand'
    | 'actSearch'
    | 'actSearchAny'
    | 'actBrowse'
    | 'actWork'
    | 'actDocCreate'
    | 'actDocCreateNamed'
    | 'actDocSection'
    | 'actDocSectionNamed'
    | 'actDocSectionOf'
  >,
): string {
  const name = (tool ?? '').toLowerCase()
  const t = target?.trim()
  // the app's own document tools (run by the chat between agy turns): a plan-style progress line
  if (name === 'create_document') return t ? fill(d.actDocCreateNamed, { t }) : d.actDocCreate
  if (name === 'append_to_document') {
    // target `3/6 Heading` = section 3 of the 6 the outline announced
    const step = t ? /^(\d+)\/(\d+)(?:\s+(.*))?$/.exec(t) : null
    if (step && step[3]) return fill(d.actDocSectionOf, { k: step[1]!, n: step[2]!, t: step[3] })
    if (step)
      return fill(d.actDocSectionOf, { k: step[1]!, n: step[2]!, t: '' }).replace(/[:：]\s*$/, '')
    return t ? fill(d.actDocSectionNamed, { t }) : d.actDocSection
  }
  if (/browser|web|navigate|url/.test(name)) return d.actBrowse
  if (/search|find|grep|glob|list_dir|ls$/.test(name)) {
    return t ? fill(d.actSearch, { t }) : d.actSearchAny
  }
  if (/run_command|command|shell|bash|terminal|exec/.test(name)) return d.actCommand
  if (/write|edit|create|replace|update|delete|save/.test(name)) {
    return t ? fill(d.actWrite, { t }) : d.actWriteAny
  }
  if (/read|view|open|cat/.test(name)) return t ? fill(d.actRead, { t }) : d.actReadAny
  return d.actWork
}

/** seconds since the run last reported a step, once that is long enough to need a word of reassurance */
export const QUIET_AFTER_MS = 60_000
export function quietSeconds(run: Run, now: number): number {
  const idle = now - (run.lastAt ?? run.startedAt)
  return idle >= QUIET_AFTER_MS ? Math.floor(idle / 1000) : 0
}

export const STAGE_THINK_MS = 10_000
export const STAGE_DRAFT_MS = 45_000
export const STAGE_LATE_MS = 240_000
export type WaitStage = 'stageRead' | 'stageThink' | 'stageDraft' | 'stageLate'

/**
 * Honest text for a run that reports no steps (agy writes one long answer silently): which stage a
 * silence of `silentMs` is in. After a real step the "reading" stage is skipped (`afterStep`).
 */
export function waitStage(silentMs: number, afterStep = false): WaitStage {
  if (silentMs >= STAGE_LATE_MS) return 'stageLate'
  if (silentMs >= STAGE_DRAFT_MS) return 'stageDraft'
  if (silentMs >= STAGE_THINK_MS || afterStep) return 'stageThink'
  return 'stageRead'
}

function thinkTitle(run: Run, d: Dict, mode: 'default' | 'home-chat' = 'default'): string {
  const seconds = Math.max(0, ((run.endedAt ?? Date.now()) - run.startedAt) / 1000)
  if (run.phase === 'done') {
    const time = seconds >= 60 ? span(seconds * 1000, d) : `${Math.round(seconds)}s`
    return fill(d.doneIn, { t: time })
  }
  if (run.phase === 'error') return fill(d.runFailed, { m: run.error ?? '' })

  if (mode === 'home-chat') {
    const time = clockTime(seconds * 1000)
    const silent = Date.now() - (run.lastAt ?? run.startedAt)
    const afterStep = run.steps.length > 0
    let label: string
    if (run.phase === 'writing') {
      label = d.writingAnswer
    } else if (run.phase === 'tool') {
      // a tool step names what is happening; only a very long one gets the reassurance line
      label =
        silent >= QUIET_AFTER_MS
          ? fill(d.stillWorking, { n: Math.floor(silent / 1000) })
          : `${toolActivityLabel(run.tool, run.target, d)}…`
    } else if (afterStep && silent < STAGE_THINK_MS) {
      label = d.thinkingHome
    } else {
      label = d[waitStage(silent, afterStep)]
    }
    return `${label} · ${time}`
  }

  const defaultTime =
    seconds >= 60 ? span(seconds * 1000, d) : `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const quiet = quietSeconds(run, Date.now())
  if (quiet > 0 && run.phase !== 'writing') {
    return `${fill(d.stillWorking, { n: quiet })} ${defaultTime}`
  }
  const label =
    run.phase === 'writing'
      ? d.writing
      : run.phase === 'tool'
        ? toolActivityLabel(run.tool, run.target, d)
        : run.steps.length === 0
          ? d.starting
          : d.thinkingNow
  return `${label}… ${defaultTime}`
}

/** tone is decided on the same rounded percent the label prints, so `20% left` is never red */
function tone(remaining: number): 'ok' | 'warn' | 'low' {
  const percent = Math.round(remaining * 100)
  return percent >= 50 ? 'ok' : percent >= 20 ? 'warn' : 'low'
}

function bridge(): AgyBarApi | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window as unknown as { agyChat?: AgyBarApi }).agyChat
}

const MAX_SUPERSEDED_IDS = 200

function addBoundedId(set: Set<string>, id: string | undefined | null): void {
  if (!id) return
  if (set.has(id)) {
    set.delete(id)
  } else if (set.size >= MAX_SUPERSEDED_IDS) {
    const oldest = set.values().next().value
    if (oldest !== undefined) set.delete(oldest)
  }
  set.add(id)
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
  mode = 'default',
  showModel = true,
  activeRunId,
  activeRequestId,
  getActiveRequestId,
  sessionId,
  busy,
}: {
  lang: string
  api?: AgyBarApi | undefined
  /** 'bar' = model + usage chips only, 'steps' = the live thinking strip only (placed by the host) */
  part?: 'all' | 'bar' | 'steps'
  /** 'home-chat' uses calm single-line indicator, subtle timing, and unified activity states */
  mode?: 'default' | 'home-chat'
  /** whether to render the model button; true by default, false when an external picker (AiModelPicker) owns selection */
  showModel?: boolean
  activeRunId?: string
  activeRequestId?: string | null
  getActiveRequestId?: () => string | null | undefined
  sessionId?: string
  busy?: boolean
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
  const [login, setLogin] = useState<AgyBarLogin>({ phase: 'idle' })
  const [install, setInstall] = useState<AgyBarInstall>({ phase: 'idle' })
  const [code, setCode] = useState('')
  const loginActive = useRef(false)
  loginActive.current = login.phase !== 'idle' || !!usage?.needsLogin
  const modeRef = useRef(mode)
  modeRef.current = mode
  const stateRef = useRef<AgyBarState | null>(state)
  stateRef.current = state
  const activeRunIdRef = useRef(activeRunId)
  activeRunIdRef.current = activeRunId
  const activeRequestIdRef = useRef(activeRequestId)
  const getActiveRequestIdRef = useRef(getActiveRequestId)
  getActiveRequestIdRef.current = getActiveRequestId
  const prevActiveRequestIdRef = useRef(activeRequestId)
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const busyRef = useRef(busy)
  busyRef.current = busy
  const supersededRunIds = useRef(new Set<string>())
  const supersededRequestIds = useRef(new Set<string>())
  /** generation of the last state read, and whether this component is still mounted */
  const loadSeq = useRef(0)
  const alive = useRef(true)
  // the mount flag is tied to the component, not to the bridge: swapping the api (or re-rendering
  // with a different source) must not mark a still-mounted bar as gone
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  if (prevActiveRequestIdRef.current !== activeRequestId) {
    if (prevActiveRequestIdRef.current) {
      addBoundedId(supersededRequestIds.current, prevActiveRequestIdRef.current)
    }
    prevActiveRequestIdRef.current = activeRequestId
  }
  activeRequestIdRef.current = activeRequestId

  const resolveCurrentRequestId = (): string | null | undefined =>
    getActiveRequestIdRef.current ? getActiveRequestIdRef.current() : activeRequestIdRef.current

  const source = api ?? bridge()

  const loadState = useCallback(async () => {
    // generation token: when two reads overlap (focus + model change + another window), the
    // answer of an older request must never overwrite the state a newer one already produced
    const mine = ++loadSeq.current
    try {
      const next = await source?.getAgyChatState()
      if (mine !== loadSeq.current || !alive.current) return
      if (next) {
        stateRef.current = next
        setState(next)
      } else {
        setState((previous) => {
          if (!previous) return previous
          const updated: AgyBarState = {
            ...previous,
            selectedStatus: 'unverified',
            catalogError: previous.catalogError ?? 'unavailable',
          }
          stateRef.current = updated
          return updated
        })
      }
    } catch {
      if (mine !== loadSeq.current || !alive.current) return
      setState((previous) => {
        if (!previous) return previous
        const updated: AgyBarState = {
          ...previous,
          selectedStatus: 'unverified',
          catalogError: previous.catalogError ?? 'unavailable',
        }
        stateRef.current = updated
        return updated
      })
    }
  }, [source])

  const schedulePeekEnd = useCallback(() => {
    if (peekTimer.current) clearTimeout(peekTimer.current)
    peekTimer.current = setTimeout(() => {
      if (!pinned.current && !hovering.current) setOpen(false)
    }, PEEK_MS)
  }, [])

  const apply = useCallback((next: AgyBarUsage) => {
    setUsage(next)
    if (next.refreshing) {
      wasRefreshing.current = true
    } else if (wasRefreshing.current) {
      wasRefreshing.current = false
      if (next.needsLogin || next.cliMissing) {
        pinned.current = true
        setOpen(true)
      }
    }
  }, [])

  useEffect(() => {
    if (!source) return
    const runIds = supersededRunIds.current
    const reqIds = supersededRequestIds.current
    void loadState()
    void source
      .getAgyChatUsage()
      .then(apply)
      .catch(() => {})
    const off = source.onAgyChatUsage(apply)
    const offLogin = source.onAgyLogin?.((next) => {
      setLogin(next)
      if (next.phase === 'done') {
        setCode('')
        setTimeout(() => setLogin({ phase: 'idle' }), 3000)
      }
    })
    const offInstall = source.onAgyInstall?.((next) => {
      setInstall(next)
      if (next.phase === 'done') setTimeout(() => setInstall({ phase: 'idle' }), 3000)
    })
    // the usage chip never shows a run: only the thinking strip listens for activity
    const subscribeRun = part === 'bar' ? undefined : source.onAgyChatActivity?.bind(source)
    const offRun = subscribeRun?.((event) => {
      if (modeRef.current === 'home-chat' ? !busyRef.current : busyRef.current === false) return
      if (stateRef.current && !stateRef.current.active) return
      if (sessionIdRef.current && event.sessionId && event.sessionId !== sessionIdRef.current) {
        return
      }
      if (sessionIdRef.current && !event.sessionId) {
        return
      }
      const currentRequestId = resolveCurrentRequestId()
      if (prevActiveRequestIdRef.current !== currentRequestId) {
        if (prevActiveRequestIdRef.current) {
          addBoundedId(reqIds, prevActiveRequestIdRef.current)
        }
        prevActiveRequestIdRef.current = currentRequestId
      }
      if (event.requestId && reqIds.has(event.requestId)) {
        return
      }
      if (currentRequestId !== undefined) {
        if (!currentRequestId || !event.requestId || event.requestId !== currentRequestId) {
          return
        }
      }
      if (activeRunIdRef.current && event.runId !== activeRunIdRef.current) {
        return
      }
      if (runIds.has(event.runId)) {
        return
      }
      setRun((current) => {
        const latestRequestId = resolveCurrentRequestId()
        if (!current) {
          if (
            event.phase !== 'start' &&
            event.phase !== 'thinking' &&
            event.phase !== 'tool' &&
            event.phase !== 'writing'
          ) {
            return null
          }
          if (latestRequestId !== undefined) {
            if (!latestRequestId || !event.requestId || event.requestId !== latestRequestId) {
              return null
            }
          }
          if (activeRunIdRef.current && event.runId !== activeRunIdRef.current) {
            return null
          }
          return reduceRun(null, event)
        }
        if (current.requestId && event.requestId && event.requestId !== current.requestId) {
          if (
            latestRequestId &&
            event.requestId === latestRequestId &&
            (event.phase === 'start' ||
              event.phase === 'thinking' ||
              event.phase === 'tool' ||
              event.phase === 'writing')
          ) {
            addBoundedId(reqIds, current.requestId)
            addBoundedId(runIds, current.id)
            return reduceRun(null, event)
          }
          return current
        }
        if (event.runId !== current.id) {
          if (
            event.phase === 'start' &&
            (!activeRunIdRef.current || event.runId === activeRunIdRef.current) &&
            (latestRequestId !== undefined
              ? !!latestRequestId && event.requestId === latestRequestId
              : (!current.requestId || !event.requestId || event.requestId === current.requestId) &&
                event.at >= current.startedAt)
          ) {
            addBoundedId(runIds, current.id)
            return reduceRun(null, event)
          }
          return current
        }
        return reduceRun(current, event)
      })
    })
    const onFocus = () => void loadState()
    window.addEventListener('focus', onFocus)
    window.addEventListener(MODEL_CHANGED, onFocus)
    // a change made in another window reaches this one through the main process
    let offModel: (() => void) | undefined
    try {
      offModel = source.onAgyChatModelChanged?.(onFocus)
    } catch {
      offModel = undefined
    }
    const clock = setInterval(() => tick((n) => n + 1), 30_000)
    return () => {
      off()
      offLogin?.()
      offInstall?.()
      offRun?.()
      offModel?.()
      window.removeEventListener('focus', onFocus)
      window.removeEventListener(MODEL_CHANGED, onFocus)
      clearInterval(clock)
      if (peekTimer.current) clearTimeout(peekTimer.current)
      runIds.clear()
      reqIds.clear()
      setRun(null)
    }
  }, [source, loadState, apply, part])

  useEffect(() => {
    if (busy === false) {
      if (run) {
        addBoundedId(supersededRequestIds.current, run.requestId)
        setRun(null)
      }
      addBoundedId(supersededRequestIds.current, resolveCurrentRequestId())
      supersededRunIds.current.clear()
    }
  }, [busy, run])

  useEffect(() => {
    if (!run) return
    const currentRequestId = getActiveRequestId ? getActiveRequestId() : activeRequestId
    if (currentRequestId !== undefined) {
      if (!currentRequestId || run.requestId !== currentRequestId) {
        addBoundedId(supersededRequestIds.current, run.requestId)
        addBoundedId(supersededRunIds.current, run.id)
        setRun(null)
      }
    }
  }, [activeRequestId, getActiveRequestId, run])

  useEffect(() => {
    if (activeRunId && run && run.id !== activeRunId) {
      addBoundedId(supersededRequestIds.current, run.requestId)
      addBoundedId(supersededRunIds.current, run.id)
      setRun(null)
    }
  }, [activeRunId, run])

  useEffect(() => {
    if (sessionId && run && run.sessionId && run.sessionId !== sessionId) {
      addBoundedId(supersededRequestIds.current, run.requestId)
      supersededRunIds.current.clear()
      setRun(null)
    }
  }, [sessionId, run])

  useEffect(() => {
    if (state && !state.active && run) {
      addBoundedId(supersededRequestIds.current, run.requestId)
      addBoundedId(supersededRunIds.current, run.id)
      setRun(null)
    }
  }, [state, run])

  const effectiveRequestId = getActiveRequestId ? getActiveRequestId() : activeRequestId
  const effectiveRun =
    run &&
    (!state || state.active) &&
    (!sessionId || !run.sessionId || run.sessionId === sessionId) &&
    (!activeRunId || run.id === activeRunId) &&
    (effectiveRequestId === undefined
      ? !run.requestId || !supersededRequestIds.current.has(run.requestId)
      : !!effectiveRequestId &&
        run.requestId === effectiveRequestId &&
        !supersededRequestIds.current.has(run.requestId)) &&
    (mode === 'home-chat' ? !!busy : busy !== false)
      ? run
      : null

  const running = !!effectiveRun && effectiveRun.phase !== 'done' && effectiveRun.phase !== 'error'
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
      if (loginActive.current) return
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) hide()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !loginActive.current) hide()
    }
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('keydown', key)
    }
  }, [menu, open])

  const [fallbackElapsed, setFallbackElapsed] = useState(0)
  useEffect(() => {
    if (!busy || (source && state?.active && effectiveRun)) {
      setFallbackElapsed(0)
      return
    }
    const t0 = Date.now()
    const timer = setInterval(() => {
      setFallbackElapsed(Math.max(1, Math.round((Date.now() - t0) / 1000)))
    }, 1000)
    return () => clearInterval(timer)
  }, [busy, source, state?.active, effectiveRun])

  if (!source || !state?.active) {
    if (part !== 'bar' && busy) {
      const timeStr = fallbackElapsed > 0 ? ` · ${clockTime(fallbackElapsed * 1000)}` : ''
      return (
        <section
          className={`agy-think is-thinking is-static${mode === 'home-chat' ? ' is-home-chat' : ''}`}
          aria-live="polite"
        >
          <div className="agy-think-head">
            <span className="agy-think-dot" aria-hidden="true" />
            <span className="agy-think-title">
              {mode === 'home-chat' ? `${d.thinkingHome}${timeStr}` : `${d.thinkingNow}…`}
            </span>
          </div>
        </section>
      )
    }
    return null
  }
  const showBar = part !== 'steps'
  const showSteps = part !== 'bar'

  const current = state.models?.find((model) => model.id === state.selected) ?? state.models?.[0]
  const runningModelInfo =
    running && effectiveRun?.model
      ? (state.models?.find((model) => model.id === effectiveRun.model) ?? null)
      : null
  const displayModelLabel =
    runningModelInfo?.label ??
    (running && effectiveRun?.model
      ? effectiveRun.model
      : state.selectedStatus === 'none'
        ? d.noModel
        : (current?.label ?? state.selected))
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

  const quotaPercent = worst === null ? null : Math.round(worst * 100)
  const usageProblem = !!(usage?.needsLogin || usage?.cliMissing || usage?.failed)
  // always visible once there is a number; with none, only a real problem (or an open popover) shows it
  const showUsage = open || quotaPercent !== null || usageProblem
  const usageLabel =
    quotaPercent !== null
      ? fill(d.left, { p: quotaPercent })
      : usage?.cliMissing
        ? d.installTitle
        : usage?.needsLogin
          ? d.loginTitle
          : d.unavailable

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
      className={`agy-bar${part === 'steps' ? ' is-steps' : ''}${mode === 'home-chat' ? ' is-home-chat' : ''}`}
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
              {!five && !week && <p className="agy-bar-note">{d.none}</p>}
            </>
          )}
          {showBar && (usage?.cliMissing || install.phase !== 'idle') && source.startAgyInstall && (
            <div className="agy-login agy-install">
              <strong>{d.installTitle}</strong>
              {(install.phase === 'idle' || install.phase === 'failed') && <p>{d.installIntro}</p>}
              {install.phase === 'installing' && <p>{d.installing}</p>}
              {install.phase === 'done' && <p>{d.installDone}</p>}
              {install.phase === 'failed' && (
                <>
                  <p>{d.installFailed}</p>
                  {install.output && <pre className="agy-install-output">{install.output}</pre>}
                </>
              )}
              <div className="agy-login-actions">
                {(install.phase === 'idle' || install.phase === 'failed') && (
                  <button type="button" onClick={() => void source.startAgyInstall?.()}>
                    {install.phase === 'failed' ? d.installRetry : d.installStart}
                  </button>
                )}
              </div>
            </div>
          )}
          {showBar &&
            !usage?.cliMissing &&
            (usage?.needsLogin || login.phase !== 'idle') &&
            source.startAgyLogin && (
              <div className="agy-login">
                <strong>{d.loginTitle}</strong>
                {login.phase === 'idle' && <p>{d.loginIntro}</p>}
                {login.phase === 'starting' && <p>{d.loginStarting}</p>}
                {login.phase === 'waiting' && <p>{d.loginWaiting}</p>}
                {login.phase === 'checking' && <p>{d.loginChecking}</p>}
                {login.phase === 'done' && <p>{d.loginDone}</p>}
                {login.phase === 'failed' && (
                  <p>
                    {login.error === 'rejected'
                      ? d.loginRejected
                      : login.error === 'cli-missing'
                        ? d.loginMissing
                        : d.loginTimeout}
                  </p>
                )}
                {(login.phase === 'waiting' || login.phase === 'checking') && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      void source.submitAgyLoginCode?.(code)
                    }}
                  >
                    <input
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      placeholder={d.loginPlaceholder}
                      aria-label={d.loginPlaceholder}
                      spellCheck={false}
                      autoComplete="off"
                      disabled={login.phase === 'checking'}
                    />
                    <button type="submit" disabled={!code.trim() || login.phase === 'checking'}>
                      {d.loginSend}
                    </button>
                  </form>
                )}
                <div className="agy-login-actions">
                  {(login.phase === 'idle' || login.phase === 'failed') && (
                    <button type="button" onClick={() => void source.startAgyLogin?.()}>
                      {d.loginStart}
                    </button>
                  )}
                  {login.phase === 'waiting' && login.url && (
                    <button type="button" onClick={() => void source.startAgyLogin?.()}>
                      {d.loginReopen}
                    </button>
                  )}
                  {(login.phase === 'waiting' || login.phase === 'checking') && (
                    <button type="button" onClick={() => void source.cancelAgyLogin?.()}>
                      {d.loginCancel}
                    </button>
                  )}
                </div>
              </div>
            )}
          {usage?.failed && (!usage.needsLogin || !source.startAgyLogin) && (
            <p className="agy-bar-note">{usage.needsLogin ? d.needsLogin : d.failed}</p>
          )}
          <footer>
            <button type="button" onClick={recheck} disabled={usage?.refreshing}>
              {d.recheck}
            </button>
          </footer>
        </section>
      )}
      {showBar && showModel && menu && (
        <div className="agy-bar-menu" role="listbox" aria-label={d.model}>
          {state.models.map((model) => {
            // the chat box lists what the person switched on, but only a model the CLI
            // confirmed can actually be chosen: the main process refuses the rest, so the
            // menu must not look like it accepts them
            const blocked =
              (state.available !== undefined && !state.available.includes(model.id)) ||
              model.enabled === false
            return (
              <button
                key={model.id}
                type="button"
                role="option"
                aria-selected={model.id === state.selected}
                aria-disabled={blocked}
                disabled={blocked}
                title={blocked ? `${model.label} - ${d.unverified}` : model.label}
                className={model.id === state.selected ? 'is-selected' : ''}
                onClick={() => {
                  if (blocked) return
                  void choose(model.id)
                }}
              >
                <span className="agy-bar-menu-main">
                  <strong>{model.label}</strong>
                  <span className={`agy-bar-pill is-${model.speed}`}>{speedLabel(model)}</span>
                </span>
                <span className="agy-bar-menu-sub">
                  {model.relativeCost <= 1 ? d.costBase : fill(d.cost, { n: model.relativeCost })}
                </span>
              </button>
            )
          })}
          <p className="agy-bar-note">{d.more}</p>
        </div>
      )}
      {showSteps && (effectiveRun || (mode === 'home-chat' && busy)) && (
        <section
          className={`agy-think is-${effectiveRun?.phase ?? 'thinking'}${mode === 'home-chat' ? ' is-home-chat' : ''}${
            effectiveRun && effectiveRun.steps.length > 0 ? '' : ' is-static'
          }${steps && effectiveRun && effectiveRun.steps.length > 0 ? ' is-open' : ''}`}
          aria-live="polite"
        >
          <button
            type="button"
            className="agy-think-head"
            aria-expanded={steps}
            onClick={() => {
              if (effectiveRun && effectiveRun.steps.length > 0) setSteps((value) => !value)
            }}
          >
            <span className="agy-think-dot" aria-hidden="true" />
            <span className="agy-think-title">
              {effectiveRun
                ? thinkTitle(effectiveRun, d, mode)
                : `${d.thinkingHome}${fallbackElapsed > 0 ? ` · ${clockTime(fallbackElapsed * 1000)}` : ''}`}
            </span>
            {effectiveRun && effectiveRun.tokens > 0 && (
              <span className="agy-think-meta">
                {fill(d.thoughtTokens, { n: compactTokens(effectiveRun.tokens) })}
              </span>
            )}
            {effectiveRun && effectiveRun.steps.length > 0 && (
              <span className="agy-think-toggle">{steps ? d.hideSteps : d.showSteps}</span>
            )}
          </button>
          {steps && effectiveRun && (
            <div className="agy-think-body">
              <ol>
                {effectiveRun.steps.map((step, index) => (
                  <li key={index} className={`is-${step.kind}`}>
                    <span className="agy-think-step-name">
                      {step.kind === 'thinking'
                        ? d.stepThinking
                        : step.kind === 'writing'
                          ? d.stepWriting
                          : toolActivityLabel(step.tool, step.target, d)}
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
      {showBar && (showModel || showUsage) && (
        <div className="agy-bar-row-main">
          {showModel && (
            <button
              type="button"
              className="agy-bar-chip agy-bar-model"
              data-status={state.selectedStatus}
              aria-haspopup="listbox"
              aria-expanded={menu}
              title={
                state.selectedStatus === 'none'
                  ? d.noModelHint
                  : state.selectedStatus === 'unavailable'
                    ? d.unavailableModel
                    : state.catalogError
                      ? d.unverified
                      : d.model
              }
              onClick={() => {
                setMenu((value) => !value)
              }}
            >
              <span className="agy-bar-model-name">{displayModelLabel}</span>
              <span aria-hidden="true" className="agy-bar-caret">
                ▾
              </span>
            </button>
          )}
          {showUsage && (
            <button
              type="button"
              className={`agy-bar-chip agy-bar-usage${worst === null ? '' : ` is-${tone(worst)}`}`}
              aria-expanded={open}
              title={usage?.failed ? `${d.usage}. ${d.failed}` : d.usage}
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
              <span>{usageLabel}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
