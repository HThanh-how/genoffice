import type { Lang } from '@genoffice/i18n'
import { QUOTA_MARGIN_POINTS } from '@genoffice/ai-provider/agy-ocr'
import type { AgyOcrActivity, AgyOcrBucketLive, AgyOcrStatus } from '../../../shared/fork/agy-ocr'

/**
 * Strings of the scanned-PDF reader (Antigravity) settings, popup note and manual action.
 * Fork-owned so the shared strings.ts stays untouched. `zh` defines the key set; languages
 * without a table fall back to English.
 */
const zh = {
  title: '读取扫描版 PDF（Antigravity）',
  desc: '有些 PDF 是没有文字层的扫描件，搜索看不到其中的内容。只要 Antigravity 额度充足，此功能就用你的账号读取这些页面，并把文字加入索引。',
  consent:
    '扫描版 PDF 的页面图片会通过你的 Antigravity 账号发送给 Google，并消耗该账号的额度。默认开启。',
  enable: '读取扫描版 PDF',
  model: '模型',
  modelDesc: '用于读取页面的模型。标有“最省”的版本思考最少，用量最低。',
  cheapest: '最省',
  modelsLoading: '正在载入模型…',
  modelsFailed: '无法获取模型列表：{error}',
  quotaTitle: '额度保留线',
  quotaDesc:
    '每个额度桶都有一条随时间下降的保留线：只有剩余额度高于保留线（开始时再多 {margin} 个百分点）才会读取，因此额度会被均匀使用，并始终为你自己使用 Antigravity 留出余量。',
  weeklyTitle: '每周额度',
  firstDayFloor: '第 1 天的保留线（%）',
  dropPerDay: '每天下降（百分点）',
  minFloor: '最低保留线（%）',
  weeklyError: '请满足：0 ≤ 最低保留线 ≤ 第 1 天保留线 ≤ 100，且每天下降 0–100。',
  scheduleTitle: '本周计划',
  scheduleDay: '第 {n} 天',
  scheduleHint: '剩余额度不低于所列数值时才会读取。',
  fiveHourTitle: '5 小时额度',
  fiveStart: '窗口开始时的保留线（%）',
  fiveEnd: '窗口结束时的保留线（%）',
  fiveHint: '保留线在 5 小时窗口内从第一个值线性降到第二个值，快到重置时没用完的额度可以被使用。',
  fiveError: '两个数值都必须在 0 到 100 之间。',
  ignoreWeekly: '忽略每周额度限制',
  ignoreFiveHour: '忽略 5 小时额度限制',
  liveUnknown: '{bucket}：尚未读取',
  liveRunning: '{bucket}：剩余 {percent}%，当前保留线 {floor}% → 正在读取',
  liveSchedule: '{bucket}：剩余 {percent}%，当前保留线 {floor}% → {when}再次运行',
  liveRefill: '{bucket}：剩余 {percent}%，当前保留线 {floor}% → 额度重置后再次运行',
  liveIgnored: '{bucket}：已忽略',
  maxPdfsPerDay: '每天最多 PDF 数',
  maxPdfsPerDayDesc: '可选的上限。0 表示不限制，上面的额度保留线仍然有效。',
  maxPagesPerFile: '每个文件最多页数',
  maxPagesPerFileDesc: '只读取每个 PDF 的前几页，更长的文件会标记为仅部分索引。0 表示不限制页数。',
  onlyAC: '仅在接通电源或电量充足时',
  onlyACDesc: '使用电池时，电量低于 50% 不读取。',
  onlyIdle: '仅在电脑空闲时',
  onlyIdleDesc: '你正在使用电脑时不读取。',
  statusOff: '已关闭，不会发送任何内容。',
  statusToday: '今天：{pdfs} 个 PDF · {pages} 页 · {tokens} 个令牌',
  statusWaiting: '{count} 个文件待读取',
  statusLast: '最近一次：{file} 的 {pages} 页',
  statusError: '最近的错误：{message}',
  actWorking: '运行中：额度高于保留线时会继续读取',
  actChecking: '正在检查 Antigravity 额度…',
  actNothing: '没有待读取的扫描版 PDF。',
  actGate: '已暂停：等待{why}',
  actCap: '已暂停：今天的 PDF 数量已达上限，明天继续',
  actHalted: '今天已停止：{message}',
  actBackoff: '出错后将在 {time} 重试',
  actBlocked: '已暂停：{bucket}剩余 {percent}%，{reason}，{clear}',
  actBelow: '低于当前 {floor}% 的保留线',
  actMargin: '刚好高于 {floor}% 的保留线，需达到 {start}% 才会开始',
  actClearSchedule: '{when}恢复',
  actClearRefill: '额度重置后恢复',
  actUnreadable: '已暂停：无法读取 Antigravity 用量',
  actUnknownGroup: '已暂停：此模型不属于已知的额度组',
  today: '今天',
  tomorrow: '明天',
  unitDay: '天',
  unitHour: '小时',
  unitMinute: '分钟',
  whyBattery: '接通电源或电量超过 50%',
  whyPaused: '索引恢复运行',
  whyIdle: '电脑空闲',
  whyUnknown: '电源状态',
  quota5h: '5 小时剩余 {n}%',
  quotaWeekly: '每周剩余 {n}%',
  popupLine: '读取扫描版 PDF：{state} · {count} 个文件待读取',
  popupRunning: '运行中',
  popupChecking: '正在检查额度',
  popupGate: '已暂停，等待{why}',
  popupCap: '已暂停，今天的 PDF 数量已达上限',
  popupHalted: '今天已停止',
  popupBackoff: '稍后重试',
  popupBlocked: '已暂停：{bucket}剩余 {percent}%，保留线 {floor}%（{clear}）',
  popupClearIn: '约 {eta} 后恢复',
  popupClearRefill: '额度重置后恢复',
  popupUnreadable: '已暂停：无法读取 Antigravity 用量',
  popupUnknownGroup: '已暂停：未知的额度组',
  bucket5h: '5 小时额度',
  bucketWeekly: '每周额度',
  readNow: '用 Antigravity 读取',
  readNowBusy: '正在读取…',
  readNowConfirm:
    '现在读取此 PDF 的前 {n} 页吗？页面图片会通过你的 Antigravity 账号发送给 Google，并消耗额度；此操作不受上面的额度保留线限制。',
  readNowDone: '已读取 {n} 页',
  readNowFailed: '无法读取：{error}',
  readNowBusyElsewhere: '正在读取其他文件，请稍后再试',
  readNowNothing: '这个文件的页面都已读过',
}

type Dict = Record<keyof typeof zh, string>

const en = {
  title: 'Read scanned PDFs (Antigravity)',
  desc: 'Some PDFs are scans without a text layer, so search cannot see inside them. While your Antigravity quota is plentiful, this reads their pages with your account and adds the text to the index.',
  consent:
    'Page images of scanned PDFs are sent to Google through your Antigravity account and use its quota. On by default.',
  enable: 'Read scanned PDFs',
  model: 'Model',
  modelDesc:
    'The model that reads the pages. The ones marked cheapest think the least and use the fewest tokens.',
  cheapest: 'cheapest',
  modelsLoading: 'Loading models…',
  modelsFailed: 'Could not list models: {error}',
  quotaTitle: 'Quota reserve',
  quotaDesc:
    'Each quota bucket keeps a reserve that shrinks over its window. Reading happens only while the share left is above the reserve (plus {margin} points to start), so the quota is spread out and some is always left for your own Antigravity use.',
  weeklyTitle: 'Weekly quota',
  firstDayFloor: 'Reserve on day 1 (%)',
  dropPerDay: 'Reserve drops per day (points)',
  minFloor: 'Never below (%)',
  weeklyError: 'Use 0 ≤ minimum ≤ day-1 reserve ≤ 100, and a drop of 0–100.',
  scheduleTitle: 'Plan for the week',
  scheduleDay: 'Day {n}',
  scheduleHint: 'Reading runs while at least this much weekly quota is left.',
  fiveHourTitle: '5-hour quota',
  fiveStart: 'Reserve at the start of the window (%)',
  fiveEnd: 'Reserve at the end of the window (%)',
  fiveHint:
    'The reserve glides from the first value to the second over the 5-hour window, so quota that would expire unused near the reset can be spent.',
  fiveError: 'Both values must be between 0 and 100.',
  ignoreWeekly: 'Ignore the weekly limit',
  ignoreFiveHour: 'Ignore the 5-hour limit',
  liveUnknown: '{bucket}: not read yet',
  liveRunning: '{bucket}: {percent}% left, floor {floor}% now → running',
  liveSchedule: '{bucket}: {percent}% left, floor {floor}% now → runs again {when}',
  liveRefill: '{bucket}: {percent}% left, floor {floor}% now → runs again when the quota refills',
  liveIgnored: '{bucket}: ignored',
  maxPdfsPerDay: 'PDFs per day',
  maxPdfsPerDayDesc: 'Optional cap. 0 means no limit; the quota reserves above still apply.',
  maxPagesPerFile: 'Pages per file',
  maxPagesPerFileDesc:
    'Only the first pages of each PDF are read; longer files are marked as partly indexed. 0 means no limit.',
  onlyAC: 'Only on AC power or a good charge',
  onlyACDesc: 'On battery, nothing is read below 50%.',
  onlyIdle: 'Only when idle',
  onlyIdleDesc: 'Nothing is read while you are using the computer.',
  statusOff: 'Off. Nothing is sent anywhere.',
  statusToday: 'Today: {pdfs} PDFs · {pages} pages · {tokens} tokens',
  statusWaiting: '{count} files waiting',
  statusLast: 'Last: {pages} pages of {file}',
  statusError: 'Last error: {message}',
  actWorking: 'Running: reads more while the quota is above its reserve',
  actChecking: 'Checking the Antigravity quota…',
  actNothing: 'Nothing to read: no scanned PDFs are waiting.',
  actGate: 'Paused: waiting for {why}',
  actCap: 'Paused: today’s PDF cap is reached; continues tomorrow',
  actHalted: 'Stopped for today: {message}',
  actBackoff: 'Retrying after an error at {time}',
  actBlocked: 'Paused: {bucket} at {percent}% — {reason}, {clear}',
  actBelow: 'below today’s {floor}% floor',
  actMargin: 'just above the {floor}% floor; needs {start}% to start',
  actClearSchedule: 'resumes {when}',
  actClearRefill: 'resumes when the quota refills',
  actUnreadable: 'Paused: can’t read Antigravity usage',
  actUnknownGroup: 'Paused: no known quota group for this model',
  today: 'today',
  tomorrow: 'tomorrow',
  unitDay: 'd',
  unitHour: 'h',
  unitMinute: 'min',
  whyBattery: 'AC power or battery above 50%',
  whyPaused: 'indexing to resume',
  whyIdle: 'the computer to be idle',
  whyUnknown: 'the power state',
  quota5h: '5h {n}% left',
  quotaWeekly: 'weekly {n}% left',
  popupLine: 'Reading scanned PDFs: {state} · {count} files waiting',
  popupRunning: 'running',
  popupChecking: 'checking quota',
  popupGate: 'paused, waiting for {why}',
  popupCap: 'paused, today’s PDF cap reached',
  popupHalted: 'stopped for today',
  popupBackoff: 'retrying later',
  popupBlocked: 'paused: {bucket} at {percent}%, floor {floor}% ({clear})',
  popupClearIn: 'resumes in ~{eta}',
  popupClearRefill: 'resumes when the quota refills',
  popupUnreadable: 'paused: can’t read Antigravity usage',
  popupUnknownGroup: 'paused: unknown quota group',
  bucket5h: '5-hour quota',
  bucketWeekly: 'weekly quota',
  readNow: 'Read with Antigravity now',
  readNowBusy: 'Reading…',
  readNowConfirm:
    'Read up to {n} pages of this PDF now? The page images are sent to Google through your Antigravity account and use its quota. This ignores the quota reserves above.',
  readNowDone: 'Read {n} pages',
  readNowFailed: 'Could not read it: {error}',
  readNowBusyElsewhere: 'Another file is being read. Try again in a moment.',
  readNowNothing: 'All pages of this file have been read already.',
} satisfies Dict

const vi = {
  title: 'Đọc PDF quét (Antigravity)',
  desc: 'Một số PDF là bản quét không có lớp chữ nên tìm kiếm không thấy nội dung bên trong. Khi hạn mức Antigravity còn dồi dào, tính năng này đọc các trang đó bằng tài khoản của bạn và thêm chữ vào chỉ mục.',
  consent:
    'Ảnh các trang của PDF quét sẽ được gửi tới Google qua tài khoản Antigravity của bạn và tốn hạn mức của tài khoản đó. Mặc định bật.',
  enable: 'Đọc PDF quét',
  model: 'Mô hình',
  modelDesc:
    'Mô hình dùng để đọc các trang. Loại ghi “rẻ nhất” suy nghĩ ít nhất nên tốn ít token nhất.',
  cheapest: 'rẻ nhất',
  modelsLoading: 'Đang tải danh sách mô hình…',
  modelsFailed: 'Không lấy được danh sách mô hình: {error}',
  quotaTitle: 'Mức dự trữ hạn mức',
  quotaDesc:
    'Mỗi nhóm hạn mức giữ một mức dự trữ giảm dần theo thời gian. Chỉ đọc khi phần còn lại cao hơn mức dự trữ (cộng thêm {margin} điểm để bắt đầu), nhờ đó hạn mức được dùng đều và luôn còn phần cho chính bạn dùng Antigravity.',
  weeklyTitle: 'Hạn mức tuần',
  firstDayFloor: 'Dự trữ ngày 1 (%)',
  dropPerDay: 'Dự trữ giảm mỗi ngày (điểm)',
  minFloor: 'Không bao giờ thấp hơn (%)',
  weeklyError: 'Cần 0 ≤ mức tối thiểu ≤ dự trữ ngày 1 ≤ 100, và mức giảm mỗi ngày từ 0 đến 100.',
  scheduleTitle: 'Kế hoạch trong tuần',
  scheduleDay: 'Ngày {n}',
  scheduleHint: 'Chỉ đọc khi hạn mức tuần còn lại ít nhất bằng mức này.',
  fiveHourTitle: 'Hạn mức 5 giờ',
  fiveStart: 'Dự trữ lúc bắt đầu chu kỳ (%)',
  fiveEnd: 'Dự trữ lúc kết thúc chu kỳ (%)',
  fiveHint:
    'Mức dự trữ giảm dần đều từ giá trị đầu đến giá trị sau trong chu kỳ 5 giờ, nên phần hạn mức sắp hết hạn mà chưa dùng có thể được dùng nốt.',
  fiveError: 'Cả hai giá trị phải nằm trong khoảng 0 đến 100.',
  ignoreWeekly: 'Bỏ qua giới hạn tuần',
  ignoreFiveHour: 'Bỏ qua giới hạn 5 giờ',
  liveUnknown: '{bucket}: chưa đọc được',
  liveRunning: '{bucket}: còn {percent}%, mức dự trữ hiện tại {floor}% → đang chạy',
  liveSchedule: '{bucket}: còn {percent}%, mức dự trữ hiện tại {floor}% → chạy lại {when}',
  liveRefill:
    '{bucket}: còn {percent}%, mức dự trữ hiện tại {floor}% → chạy lại khi hạn mức làm mới',
  liveIgnored: '{bucket}: đang bỏ qua',
  maxPdfsPerDay: 'Số PDF mỗi ngày',
  maxPdfsPerDayDesc:
    'Giới hạn tùy chọn. 0 là không giới hạn; các mức dự trữ hạn mức ở trên vẫn áp dụng.',
  maxPagesPerFile: 'Số trang tối đa mỗi tệp',
  maxPagesPerFileDesc:
    'Chỉ đọc những trang đầu của mỗi PDF; tệp dài hơn sẽ được đánh dấu là chỉ lập chỉ mục một phần. 0 là không giới hạn số trang.',
  onlyAC: 'Chỉ khi cắm điện hoặc pin còn đủ',
  onlyACDesc: 'Khi chạy bằng pin, dưới 50% thì không đọc.',
  onlyIdle: 'Chỉ khi máy rảnh',
  onlyIdleDesc: 'Không đọc khi bạn đang dùng máy.',
  statusOff: 'Đang tắt. Không có gì được gửi đi.',
  statusToday: 'Hôm nay: {pdfs} PDF · {pages} trang · {tokens} token',
  statusWaiting: 'Còn {count} tệp đang chờ',
  statusLast: 'Gần nhất: {pages} trang của {file}',
  statusError: 'Lỗi gần nhất: {message}',
  actWorking: 'Đang chạy: còn đọc tiếp khi hạn mức cao hơn mức dự trữ',
  actChecking: 'Đang kiểm tra hạn mức Antigravity…',
  actNothing: 'Không có gì để đọc: không còn PDF quét nào đang chờ.',
  actGate: 'Tạm dừng: đang chờ {why}',
  actCap: 'Tạm dừng: đã đủ số PDF của hôm nay, mai sẽ đọc tiếp',
  actHalted: 'Hôm nay đã dừng: {message}',
  actBackoff: 'Sẽ thử lại sau lỗi lúc {time}',
  actBlocked: 'Tạm dừng: {bucket} còn {percent}% — {reason}, {clear}',
  actBelow: 'thấp hơn mức dự trữ {floor}% của hôm nay',
  actMargin: 'vừa cao hơn mức dự trữ {floor}%, cần đạt {start}% mới bắt đầu',
  actClearSchedule: 'chạy lại {when}',
  actClearRefill: 'chạy lại khi hạn mức làm mới',
  actUnreadable: 'Tạm dừng: không đọc được mức sử dụng Antigravity',
  actUnknownGroup: 'Tạm dừng: mô hình này không thuộc nhóm hạn mức nào đã biết',
  today: 'hôm nay',
  tomorrow: 'ngày mai',
  unitDay: 'ngày',
  unitHour: 'giờ',
  unitMinute: 'phút',
  whyBattery: 'cắm điện hoặc pin trên 50%',
  whyPaused: 'việc lập chỉ mục chạy lại',
  whyIdle: 'máy rảnh',
  whyUnknown: 'thông tin nguồn điện',
  quota5h: '5 giờ còn {n}%',
  quotaWeekly: 'tuần còn {n}%',
  popupLine: 'Đọc PDF quét: {state} · còn {count} tệp đang chờ',
  popupRunning: 'đang chạy',
  popupChecking: 'đang kiểm tra hạn mức',
  popupGate: 'tạm dừng, đang chờ {why}',
  popupCap: 'tạm dừng, đã đủ số PDF của hôm nay',
  popupHalted: 'hôm nay đã dừng',
  popupBackoff: 'sẽ thử lại sau',
  popupBlocked: 'tạm dừng: {bucket} còn {percent}%, mức dự trữ {floor}% ({clear})',
  popupClearIn: 'chạy lại sau ~{eta}',
  popupClearRefill: 'chạy lại khi hạn mức làm mới',
  popupUnreadable: 'tạm dừng: không đọc được mức sử dụng Antigravity',
  popupUnknownGroup: 'tạm dừng: nhóm hạn mức không xác định',
  bucket5h: 'hạn mức 5 giờ',
  bucketWeekly: 'hạn mức tuần',
  readNow: 'Đọc bằng Antigravity ngay',
  readNowBusy: 'Đang đọc…',
  readNowConfirm:
    'Đọc tối đa {n} trang đầu của PDF này ngay bây giờ? Ảnh các trang sẽ được gửi tới Google qua tài khoản Antigravity của bạn và tốn hạn mức. Việc này không bị giới hạn bởi các mức dự trữ hạn mức ở trên.',
  readNowDone: 'Đã đọc {n} trang',
  readNowFailed: 'Không đọc được: {error}',
  readNowBusyElsewhere: 'Đang đọc một tệp khác. Hãy thử lại sau giây lát.',
  readNowNothing: 'Tất cả các trang của tệp này đã được đọc.',
} satisfies Dict

const tables: Partial<Record<Lang, Dict>> = { zh, en, vi }

export type AgyOcrStringKey = keyof Dict

export function agyOcrString(
  lang: Lang,
  key: AgyOcrStringKey,
  params?: Record<string, string | number>,
): string {
  const source = (tables[lang] ?? en)[key]
  return source.replace(/\{(\w+)\}/g, (match, name: string) =>
    params?.[name] == null ? match : String(params[name]),
  )
}

const WHY_KEYS: Record<string, AgyOcrStringKey> = {
  'on-battery': 'whyBattery',
  'indexing-paused': 'whyPaused',
  'not-idle': 'whyIdle',
  'no-power-info': 'whyUnknown',
}

export function formatTime(lang: Lang, at: number): string {
  try {
    return new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(
      new Date(at),
    )
  } catch {
    return new Date(at).toLocaleTimeString()
  }
}

/** "today 14:30", "tomorrow 00:00", "Sat 09:00": a moment in the user's local time. */
export function formatWhen(lang: Lang, at: number, now: number = Date.now()): string {
  const day = (ms: number) => {
    const d = new Date(ms)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const diffDays = Math.round((day(at) - day(now)) / 86_400_000)
  const time = formatTime(lang, at)
  if (diffDays === 0) return `${agyOcrString(lang, 'today')} ${time}`
  if (diffDays === 1) return `${agyOcrString(lang, 'tomorrow')} ${time}`
  try {
    return new Intl.DateTimeFormat(lang, {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(at))
  } catch {
    return time
  }
}

export function formatCount(lang: Lang, n: number): string {
  try {
    return new Intl.NumberFormat(lang).format(n)
  } catch {
    return String(n)
  }
}

/** "2 d 4 h", "3 h 10 min", "35 min": how long until a moment. */
export function formatDuration(lang: Lang, ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  const d = agyOcrString(lang, 'unitDay')
  const h = agyOcrString(lang, 'unitHour')
  const m = agyOcrString(lang, 'unitMinute')
  if (days > 0) return hours > 0 ? `${days} ${d} ${hours} ${h}` : `${days} ${d}`
  if (hours > 0) return mins > 0 && hours < 6 ? `${hours} ${h} ${mins} ${m}` : `${hours} ${h}`
  return `${mins} ${m}`
}

export function bucketName(lang: Lang, window: '5h' | 'weekly'): string {
  return agyOcrString(lang, window === '5h' ? 'bucket5h' : 'bucketWeekly')
}

/** The quota description shown above the two bucket editors. */
export function quotaDescription(lang: Lang): string {
  return agyOcrString(lang, 'quotaDesc', { margin: QUOTA_MARGIN_POINTS })
}

/** One live line per bucket: "weekly quota: 74% left, floor 80% now → runs again tomorrow 00:00". */
export function bucketLiveLine(
  lang: Lang,
  window: '5h' | 'weekly',
  live: AgyOcrBucketLive | undefined,
  activity: AgyOcrActivity,
  now: number = Date.now(),
): string {
  const bucket = bucketName(lang, window)
  if (!live) return agyOcrString(lang, 'liveUnknown', { bucket })
  if (live.ignored) return agyOcrString(lang, 'liveIgnored', { bucket })
  const base = { bucket, percent: Math.round(live.percent), floor: Math.round(live.floor) }
  if (live.percent >= live.startAt) return agyOcrString(lang, 'liveRunning', base)
  const clearsAt =
    activity.kind === 'quota-blocked' && activity.window === window ? activity.clearsAt : undefined
  return clearsAt !== undefined && clearsAt > now
    ? agyOcrString(lang, 'liveSchedule', { ...base, when: formatWhen(lang, clearsAt, now) })
    : agyOcrString(lang, 'liveRefill', base)
}

type Blocked = Extract<AgyOcrActivity, { kind: 'quota-blocked' }>

/** The long status sentence of the Settings panel. */
export function activityLine(
  lang: Lang,
  activity: AgyOcrActivity,
  now: number = Date.now(),
): string {
  const t = (key: AgyOcrStringKey, params?: Record<string, string | number>) =>
    agyOcrString(lang, key, params)
  switch (activity.kind) {
    case 'off':
      return t('statusOff')
    case 'working':
      return t('actWorking')
    case 'checking':
      return t('actChecking')
    case 'nothing':
      return t('actNothing')
    case 'gate':
      return t('actGate', { why: t(WHY_KEYS[activity.why] ?? 'whyUnknown') })
    case 'cap':
      return t('actCap')
    case 'halted':
      return t('actHalted', { message: activity.message })
    case 'backoff':
      return t('actBackoff', { time: formatTime(lang, activity.until) })
    case 'quota-unreadable':
      return t('actUnreadable')
    case 'quota-unknown-group':
      return t('actUnknownGroup')
    case 'quota-blocked': {
      const reason = activity.belowFloor
        ? t('actBelow', { floor: Math.round(activity.floor) })
        : t('actMargin', { floor: Math.round(activity.floor), start: Math.round(activity.startAt) })
      const clear =
        activity.clearsAt !== undefined
          ? t('actClearSchedule', { when: formatWhen(lang, activity.clearsAt, now) })
          : t('actClearRefill')
      return t('actBlocked', {
        bucket: bucketName(lang, activity.window),
        percent: Math.round(activity.percent),
        reason,
        clear,
      })
    }
  }
}

/** "Gemini 5h 84% left, weekly 97% left" (the buckets that were read). */
export function quotaSummary(lang: Lang, quota: NonNullable<AgyOcrStatus['quota']>): string {
  const parts: string[] = []
  if (quota.fiveHour && !quota.fiveHour.ignored)
    parts.push(agyOcrString(lang, 'quota5h', { n: Math.round(quota.fiveHour.percent) }))
  if (quota.weekly && !quota.weekly.ignored)
    parts.push(agyOcrString(lang, 'quotaWeekly', { n: Math.round(quota.weekly.percent) }))
  const group = quota.group?.replace(/ models?$/i, '')
  return `${group ? `${group} ` : ''}${parts.join(', ')}`.trim()
}

function popupBlocked(lang: Lang, activity: Blocked, now: number): string {
  const wake = activity.clearsAt ?? undefined
  const clear =
    wake !== undefined && wake > now
      ? agyOcrString(lang, 'popupClearIn', { eta: formatDuration(lang, wake - now) })
      : agyOcrString(lang, 'popupClearRefill')
  return agyOcrString(lang, 'popupBlocked', {
    bucket: bucketName(lang, activity.window),
    percent: Math.round(activity.percent),
    floor: Math.round(activity.floor),
    clear,
  })
}

/** The quiet one-liner in the Document index popup (only while the reader is on and has work). */
export function popupLine(
  lang: Lang,
  status: AgyOcrStatus,
  now: number = Date.now(),
): string | null {
  const t = (key: AgyOcrStringKey, params?: Record<string, string | number>) =>
    agyOcrString(lang, key, params)
  const activity = status.activity
  let state: string
  switch (activity.kind) {
    case 'off':
    case 'nothing':
      return null
    case 'working': {
      const summary = status.quota ? quotaSummary(lang, status.quota) : ''
      state = summary ? `${t('popupRunning')} · ${summary}` : t('popupRunning')
      break
    }
    case 'checking':
      state = t('popupChecking')
      break
    case 'gate':
      state = t('popupGate', { why: t(WHY_KEYS[activity.why] ?? 'whyUnknown') })
      break
    case 'cap':
      state = t('popupCap')
      break
    case 'halted':
      state = t('popupHalted')
      break
    case 'backoff':
      state = t('popupBackoff')
      break
    case 'quota-unreadable':
      state = t('popupUnreadable')
      break
    case 'quota-unknown-group':
      state = t('popupUnknownGroup')
      break
    case 'quota-blocked':
      state = popupBlocked(lang, activity, now)
      break
  }
  return t('popupLine', { state, count: formatCount(lang, status.filesWaiting) })
}
