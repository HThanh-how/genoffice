import type { Lang } from '@genoffice/i18n'
import type { IndexIssueReason } from '../../main/document-memory/issues'

/**
 * Copy for the redesigned "Document index" popup. English, Vietnamese and Chinese are
 * written out in full; every other locale falls back to English for these newer strings
 * (the older strings in indexing-activity-i18n.ts stay translated in all locales).
 */
export interface ReasonCopy {
  /** group heading: what happened, in a few words */
  title: string
  /** one sentence: what it means and what the user can do */
  hint: string
}

export interface ActivityCopy {
  modelTitle: string
  modelBody: string
  modelCause: string
  tryAgain: string
  retryAll: string
  retrying: string
  exclude: string
  excluded: string
  details: string
  needsAttention: string
  skipped: string
  scanErrorsTitle: string
  scanErrorsHint: string
  hideNotice: string
  pausedBody: string
  showMore: string
  retriedNote: string
  /** "{done} of {total} files" */
  progressFiles: string
  /** "Found {n} files so far" */
  foundSoFar: string
  /** "{n} files are ready to search" */
  doneBody: string
  skippedNote: string
  etaSoon: string
  etaMinutes: string
  etaHours: string
  filesCount: string
  reasons: Record<IndexIssueReason, ReasonCopy>
}

const en: ActivityCopy = {
  modelTitle: 'Search model couldn’t load',
  modelBody: 'Keyword search still works. Search by meaning is on hold until the model loads.',
  modelCause: 'Cause',
  tryAgain: 'Try again',
  retryAll: 'Retry all',
  retrying: 'Retrying…',
  exclude: 'Exclude from index',
  excluded: 'Excluded',
  details: 'Technical details',
  needsAttention: 'Needs attention',
  skipped: 'Skipped',
  scanErrorsTitle: 'Folders it couldn’t open',
  scanErrorsHint:
    'Some folders or files couldn’t be read while scanning. Check that you have access to them.',
  hideNotice: 'Hide until next scan',
  pausedBody: 'Indexing is paused. Turn it back on in Settings to continue.',
  showMore: 'Show more',
  retriedNote: 'Queued {n} files to try again',
  progressFiles: '{done} of {total} files',
  foundSoFar: 'Found {n} files so far',
  doneBody: '{n} files are ready to search',
  skippedNote: '{n} skipped',
  etaSoon: 'Less than a minute left',
  etaMinutes: 'About {n} min left',
  etaHours: 'About {n} hr left',
  filesCount: '{n}',
  reasons: {
    model: {
      title: 'Search model didn’t load',
      hint: 'Check your internet connection, then try again.',
    },
    timeout: {
      title: 'Took too long',
      hint: 'The file was too slow to read. Retry when your computer is less busy.',
    },
    permission: {
      title: 'Blocked or in use',
      hint: 'Another program may have the file open, or you don’t have permission. Close it, then retry.',
    },
    unavailable: {
      title: 'Moved or deleted',
      hint: 'The file is no longer where it was. Exclude it, or scan the folder again to find it.',
    },
    corrupt: {
      title: 'Damaged file',
      hint: 'This file couldn’t be opened. Try opening it in its app; saving it again may fix it.',
    },
    changed: {
      title: 'Changed while indexing',
      hint: 'The file was edited part-way through. Retry to read the latest version.',
    },
    other: {
      title: 'Couldn’t be read',
      hint: 'Something unexpected went wrong. Retry; if it fails again, see the technical details.',
    },
    password: {
      title: 'Password-protected',
      hint: 'Remove the password to include this file, then retry.',
    },
    'no-text': {
      title: 'No text to read',
      hint: 'Scanned PDFs and photos hold no readable text, so they can’t be searched by content.',
    },
    'too-large': {
      title: 'Too large',
      hint: 'Files over 128 MB aren’t indexed.',
    },
    unsupported: {
      title: 'Unsupported format',
      hint: 'This kind of file can’t be read for search yet.',
    },
  },
}

const vi: ActivityCopy = {
  modelTitle: 'Không tải được mô hình tìm kiếm',
  modelBody:
    'Tìm theo từ khóa vẫn dùng được. Tìm theo ý nghĩa tạm dừng cho đến khi mô hình tải xong.',
  modelCause: 'Nguyên nhân',
  tryAgain: 'Thử lại',
  retryAll: 'Thử lại tất cả',
  retrying: 'Đang thử lại…',
  exclude: 'Loại khỏi chỉ mục',
  excluded: 'Đã loại',
  details: 'Chi tiết kỹ thuật',
  needsAttention: 'Cần xử lý',
  skipped: 'Đã bỏ qua',
  scanErrorsTitle: 'Thư mục không mở được',
  scanErrorsHint: 'Một số thư mục hoặc tệp không đọc được khi quét. Hãy kiểm tra quyền truy cập.',
  hideNotice: 'Ẩn đến lần quét sau',
  pausedBody: 'Đã tạm dừng lập chỉ mục. Bật lại trong Cài đặt để tiếp tục.',
  showMore: 'Xem thêm',
  retriedNote: 'Đã xếp {n} tệp vào hàng đợi để thử lại',
  progressFiles: '{done}/{total} tệp',
  foundSoFar: 'Đã tìm thấy {n} tệp',
  doneBody: '{n} tệp đã sẵn sàng để tìm kiếm',
  skippedNote: 'bỏ qua {n}',
  etaSoon: 'Còn chưa đến 1 phút',
  etaMinutes: 'Còn khoảng {n} phút',
  etaHours: 'Còn khoảng {n} giờ',
  filesCount: '{n}',
  reasons: {
    model: {
      title: 'Mô hình tìm kiếm không tải được',
      hint: 'Kiểm tra kết nối mạng rồi thử lại.',
    },
    timeout: {
      title: 'Đọc quá lâu',
      hint: 'Tệp đọc quá chậm. Hãy thử lại khi máy đỡ bận.',
    },
    permission: {
      title: 'Bị chặn hoặc đang mở',
      hint: 'Có thể chương trình khác đang mở tệp, hoặc bạn không có quyền. Đóng tệp rồi thử lại.',
    },
    unavailable: {
      title: 'Đã di chuyển hoặc xóa',
      hint: 'Tệp không còn ở vị trí cũ. Hãy loại khỏi chỉ mục, hoặc quét lại thư mục để tìm.',
    },
    corrupt: {
      title: 'Tệp bị lỗi',
      hint: 'Không mở được tệp này. Thử mở bằng ứng dụng gốc; lưu lại có thể sửa được.',
    },
    changed: {
      title: 'Tệp đổi khi đang đọc',
      hint: 'Tệp bị sửa giữa chừng. Thử lại để đọc bản mới nhất.',
    },
    other: {
      title: 'Không đọc được',
      hint: 'Có lỗi bất ngờ. Thử lại; nếu vẫn lỗi, hãy xem chi tiết kỹ thuật.',
    },
    password: {
      title: 'Có mật khẩu',
      hint: 'Gỡ mật khẩu để đưa tệp vào chỉ mục, rồi thử lại.',
    },
    'no-text': {
      title: 'Không có chữ để đọc',
      hint: 'PDF dạng ảnh hoặc ảnh chụp không chứa văn bản nên không tìm theo nội dung được.',
    },
    'too-large': {
      title: 'Quá lớn',
      hint: 'Tệp trên 128 MB không được lập chỉ mục.',
    },
    unsupported: {
      title: 'Định dạng chưa hỗ trợ',
      hint: 'Chưa đọc được loại tệp này để tìm kiếm.',
    },
  },
}

const zh: ActivityCopy = {
  modelTitle: '搜索模型未能加载',
  modelBody: '关键词搜索仍可使用。按语义搜索将暂停，直到模型加载成功。',
  modelCause: '原因',
  tryAgain: '重试',
  retryAll: '全部重试',
  retrying: '正在重试…',
  exclude: '从索引中排除',
  excluded: '已排除',
  details: '技术详情',
  needsAttention: '需要处理',
  skipped: '已跳过',
  scanErrorsTitle: '无法打开的文件夹',
  scanErrorsHint: '扫描时有些文件夹或文件无法读取。请检查你是否有访问权限。',
  hideNotice: '隐藏，直到下次扫描',
  pausedBody: '索引已暂停。请在设置中重新开启以继续。',
  showMore: '显示更多',
  retriedNote: '已将 {n} 个文件排入重试队列',
  progressFiles: '{done} / {total} 个文件',
  foundSoFar: '目前已找到 {n} 个文件',
  doneBody: '{n} 个文件可供搜索',
  skippedNote: '跳过 {n} 个',
  etaSoon: '不到 1 分钟',
  etaMinutes: '约剩 {n} 分钟',
  etaHours: '约剩 {n} 小时',
  filesCount: '{n}',
  reasons: {
    model: { title: '搜索模型未能加载', hint: '请检查网络连接，然后重试。' },
    timeout: { title: '读取超时', hint: '文件读取太慢。请在电脑不太忙时重试。' },
    permission: {
      title: '被占用或无权限',
      hint: '可能有其他程序正在打开该文件，或你没有权限。请关闭后重试。',
    },
    unavailable: {
      title: '已移动或删除',
      hint: '文件已不在原位置。可将其排除，或重新扫描文件夹来找到它。',
    },
    corrupt: {
      title: '文件已损坏',
      hint: '无法打开此文件。请尝试用原应用打开，重新保存可能会修复。',
    },
    changed: { title: '读取期间被修改', hint: '文件在读取过程中被编辑。重试即可读取最新版本。' },
    other: { title: '无法读取', hint: '发生了意外错误。请重试；若仍失败，请查看技术详情。' },
    password: { title: '受密码保护', hint: '移除密码后才能收录此文件，然后重试。' },
    'no-text': { title: '没有可读文字', hint: '扫描版 PDF 和照片不含可读文字，无法按内容搜索。' },
    'too-large': { title: '文件过大', hint: '超过 128 MB 的文件不会被索引。' },
    unsupported: { title: '格式不支持', hint: '暂时无法读取这类文件用于搜索。' },
  },
}

const zhTW: ActivityCopy = {
  modelTitle: '搜尋模型無法載入',
  modelBody: '關鍵字搜尋仍可使用。依語意搜尋會暫停，直到模型載入成功。',
  modelCause: '原因',
  tryAgain: '重試',
  retryAll: '全部重試',
  retrying: '正在重試…',
  exclude: '從索引中排除',
  excluded: '已排除',
  details: '技術詳細資料',
  needsAttention: '需要處理',
  skipped: '已略過',
  scanErrorsTitle: '無法開啟的資料夾',
  scanErrorsHint: '掃描時有些資料夾或檔案無法讀取。請檢查你是否有存取權限。',
  hideNotice: '隱藏，直到下次掃描',
  pausedBody: '索引已暫停。請在設定中重新開啟以繼續。',
  showMore: '顯示更多',
  retriedNote: '已將 {n} 個檔案排入重試佇列',
  progressFiles: '{done} / {total} 個檔案',
  foundSoFar: '目前已找到 {n} 個檔案',
  doneBody: '{n} 個檔案可供搜尋',
  skippedNote: '略過 {n} 個',
  etaSoon: '不到 1 分鐘',
  etaMinutes: '約剩 {n} 分鐘',
  etaHours: '約剩 {n} 小時',
  filesCount: '{n}',
  reasons: {
    model: { title: '搜尋模型無法載入', hint: '請檢查網路連線，然後重試。' },
    timeout: { title: '讀取逾時', hint: '檔案讀取太慢。請在電腦較不忙時重試。' },
    permission: {
      title: '被占用或無權限',
      hint: '可能有其他程式正在開啟該檔案，或你沒有權限。請關閉後重試。',
    },
    unavailable: {
      title: '已移動或刪除',
      hint: '檔案已不在原位置。可將其排除，或重新掃描資料夾來找到它。',
    },
    corrupt: {
      title: '檔案已損毀',
      hint: '無法開啟此檔案。請嘗試用原應用程式開啟，重新儲存可能會修復。',
    },
    changed: { title: '讀取期間被修改', hint: '檔案在讀取過程中被編輯。重試即可讀取最新版本。' },
    other: { title: '無法讀取', hint: '發生了意外錯誤。請重試；若仍失敗，請查看技術詳細資料。' },
    password: { title: '受密碼保護', hint: '移除密碼後才能收錄此檔案，然後重試。' },
    'no-text': { title: '沒有可讀文字', hint: '掃描版 PDF 和照片不含可讀文字，無法依內容搜尋。' },
    'too-large': { title: '檔案過大', hint: '超過 128 MB 的檔案不會被索引。' },
    unsupported: { title: '格式不支援', hint: '暫時無法讀取這類檔案用於搜尋。' },
  },
}

const translated: Partial<Record<Lang, ActivityCopy>> = { en, vi, zh, 'zh-TW': zhTW }

/** Strings for `lang`; locales without a translation use English for these newer strings. */
export function activityCopy(lang: Lang): ActivityCopy {
  return translated[lang] ?? en
}

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
}
