import { createI18n, type Lang, type LangDicts, type Params } from '@genoffice/i18n'

/**
 * Strings for the Antigravity CLI block in Settings → AI Media & Search. Fork-owned (never grow
 * the shared strings.ts); `zh` defines the key set, other languages without a translation use English.
 */
const zh = {
  agyMediaHint:
    '使用你的 Antigravity 账号，无需 API Key。比直接调用 API 慢（每张图片约 10–40 秒），并会消耗你的 Antigravity 额度。',
  agyMediaLimits: '图片生成每次一张；分析支持图片、短视频和音频（单个文件最大 20 MB）。',
  agyMediaTest: '测试连接',
  agyMediaTestOk: '已连接 · {n} 个模型（未消耗额度）',
  agyMediaPathPlaceholderShared: '留空则使用「AI 模型」中的路径：{path}',
  agyMediaPathHint: '留空会先使用 AI 模型设置里的路径，再自动查找（{where}）。',
}

type Dict = Record<keyof typeof zh, string>

const en = {
  agyMediaHint:
    'Uses your Antigravity account, no API key. Slower than a direct API (about 10–40 s per image). Counts against your Antigravity quota.',
  agyMediaLimits:
    'Generates one image per request; analysis reads images, short video and audio (up to 20 MB per file).',
  agyMediaTest: 'Test connection',
  agyMediaTestOk: 'Connected · {n} models (no quota used)',
  agyMediaPathPlaceholderShared: 'Empty uses the AI Model path: {path}',
  agyMediaPathHint:
    'Leave blank to use the path from AI Model settings, then auto-detect ({where}).',
} satisfies Dict

const vi = {
  agyMediaHint:
    'Dùng tài khoản Antigravity của bạn, không cần khóa API. Chậm hơn gọi API trực tiếp (khoảng 10–40 giây mỗi ảnh). Tính vào hạn mức Antigravity của bạn.',
  agyMediaLimits:
    'Mỗi yêu cầu tạo một ảnh; phân tích đọc được ảnh, video ngắn và âm thanh (tối đa 20 MB mỗi tệp).',
  agyMediaTest: 'Kiểm tra kết nối',
  agyMediaTestOk: 'Đã kết nối · {n} mô hình (không tốn hạn mức)',
  agyMediaPathPlaceholderShared: 'Để trống sẽ dùng đường dẫn ở Mô hình AI: {path}',
  agyMediaPathHint:
    'Để trống để dùng đường dẫn trong cài đặt Mô hình AI, sau đó tự động phát hiện ({where}).',
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

export type AgyMediaStringKey = keyof typeof zh

const translate = createI18n(dicts)

export function agyMediaString(lang: Lang, key: AgyMediaStringKey, params?: Params): string {
  return translate(lang, key, params)
}
