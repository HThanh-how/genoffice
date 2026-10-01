import { createI18n, type Lang, type LangDicts, type Params } from '@genoffice/i18n'

/**
 * Strings for the "Antigravity CLI" (agy) provider: Settings fields and the Home
 * chat states. Kept out of the shared strings.ts so upstream merges stay trivial.
 * `zh` defines the key set; languages without a dedicated translation reuse English.
 */
const zh = {
  agyNote:
    '通过你的 Antigravity 账号在 Google 服务器上运行。每次请求都会启动 Antigravity 智能体，因此比直接调用 API 慢；适合阅读文档和图片。不支持直接编辑文档（无工具调用）。无需 API Key。',
  agyPathLabel: 'Antigravity 可执行文件',
  agyPathHint: '仅自定义安装时填写；留空会自动查找（{where}）。',
  agyPathPlaceholder: '留空自动检测（推荐）',
  agyWhereWin: 'PATH，然后是 %LOCALAPPDATA%\\agy\\bin\\agy.exe',
  agyWhereMac:
    'PATH、~/.local/bin、~/.agy/bin、/opt/homebrew/bin、/usr/local/bin，然后是登录 shell',
  agyChecking: '正在检查 Antigravity…',
  agyConnected: '已连接 · {n} 个模型',
  agyNotFound: '未连接：{error}',
  agyRecheck: '重新检查',
  agyTestFailed: '无法连接 Antigravity CLI',
  agyStarting: '正在启动 Antigravity…',
  agyStartingHint: '每条消息都会启动智能体，需要几秒钟。',
  agyContextHeader: '检索到的文档（节选）',
}

type Dict = Record<keyof typeof zh, string>

const en = {
  agyNote:
    "Runs on Google's servers through your Antigravity account. Each request starts the Antigravity agent, so it is slower than a direct API call; best for reading documents and images. It cannot edit your documents directly (no tool calling). No API key needed.",
  agyPathLabel: 'Antigravity executable',
  agyPathHint: 'Only set this for a custom install; leave blank to auto-detect ({where}).',
  agyPathPlaceholder: 'Auto-detect (recommended)',
  agyWhereWin: 'PATH, then %LOCALAPPDATA%\\agy\\bin\\agy.exe',
  agyWhereMac:
    'PATH, ~/.local/bin, ~/.agy/bin, /opt/homebrew/bin, /usr/local/bin, then your login shell',
  agyChecking: 'Checking Antigravity…',
  agyConnected: 'Connected · {n} models',
  agyNotFound: 'Not connected: {error}',
  agyRecheck: 'Re-check',
  agyTestFailed: 'Could not reach the Antigravity CLI',
  agyStarting: 'Starting Antigravity…',
  agyStartingHint: 'Every message starts the agent, which takes a few seconds.',
  agyContextHeader: 'Retrieved documents (excerpts)',
} satisfies Dict

const vi = {
  agyNote:
    'Chạy trên máy chủ của Google thông qua tài khoản Antigravity của bạn. Mỗi yêu cầu khởi động tác tử Antigravity nên chậm hơn gọi API trực tiếp; phù hợp nhất để đọc tài liệu và hình ảnh. Không thể sửa trực tiếp tài liệu của bạn (không gọi công cụ). Không cần khóa API.',
  agyPathLabel: 'Tệp thực thi Antigravity',
  agyPathHint: 'Chỉ đặt mục này nếu cài đặt tùy chỉnh; để trống để tự động phát hiện ({where}).',
  agyPathPlaceholder: 'Tự động phát hiện (khuyến nghị)',
  agyWhereWin: 'PATH, sau đó %LOCALAPPDATA%\\agy\\bin\\agy.exe',
  agyWhereMac:
    'PATH, ~/.local/bin, ~/.agy/bin, /opt/homebrew/bin, /usr/local/bin, rồi đến shell đăng nhập',
  agyChecking: 'Đang kiểm tra Antigravity…',
  agyConnected: 'Đã kết nối · {n} mô hình',
  agyNotFound: 'Chưa kết nối: {error}',
  agyRecheck: 'Kiểm tra lại',
  agyTestFailed: 'Không thể kết nối Antigravity CLI',
  agyStarting: 'Đang khởi động Antigravity…',
  agyStartingHint: 'Mỗi tin nhắn khởi động tác tử nên mất vài giây.',
  agyContextHeader: 'Tài liệu đã truy xuất (trích đoạn)',
} satisfies Dict

const dicts: LangDicts<Dict> = {
  zh,
  en,
  vi,
  ja: en,
  ko: en,
  'zh-TW': en,
  fr: en,
  de: en,
  es: en,
  th: en,
  id: en,
  ru: en,
  ar: en,
  pt: en,
  it: en,
  pl: en,
  cs: en,
  nl: en,
  ms: en,
  he: en,
  hi: en,
}

export type AgyStringKey = keyof typeof zh

const translate = createI18n(dicts)

/** Looks up an Antigravity CLI provider string. */
export function agyString(lang: Lang, key: AgyStringKey, params?: Params): string {
  return translate(lang, key, params)
}
