import type { HomeApi } from '../../../shared/home-api'
import type { IndexingMode } from '../../../shared/fork/indexing-mode'
import type { IndexedFolder } from '../../../shared/fork/document-index-api'

/**
 * A small command layer for the indexing dashboard and the Home chat: "index tới đâu rồi?",
 * "tạm dừng index", "ưu tiên thư mục Luat" and so on are answered and carried out on this
 * computer, without asking a language model (so no tokens are spent and it works offline).
 */
export type IndexCommand =
  | { kind: 'status' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'scan'; folder?: string }
  | { kind: 'stop-scan' }
  | { kind: 'retry' }
  | { kind: 'priority'; folder: string; on: boolean }
  | { kind: 'mode'; mode: IndexingMode }
  | { kind: 'model'; profile: 'standard' | 'high' }
  | { kind: 'help' }

const plain = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim()

/** Words that tie a sentence to the document index (used to decide whether Home chat takes it). */
export function mentionsIndex(text: string): boolean {
  return /\b(index|indexing|chi muc|lap chi muc|ocr)\b/.test(plain(text))
}

/** What follows a keyword, e.g. the folder name in "uu tien thu muc Luat". */
function after(text: string, keys: RegExp): string {
  const match = keys.exec(text)
  if (!match) return ''
  return text
    .slice(match.index + match[0].length)
    .trim()
    .replace(/^(thu muc|folder|muc|cai|:)\s*/g, '')
    .replace(/\b(truoc|di|nhe|giup|cho toi|len dau|index|chi muc)\b/g, '')
    .trim()
}

export function parseIndexCommand(raw: string): IndexCommand | null {
  const text = plain(raw)
  if (!text) return null
  if (/^(help|\?|tro giup|huong dan|lam duoc gi|co the lam gi)/.test(text)) return { kind: 'help' }
  if (/(bo uu tien|huy uu tien|thoi uu tien|unprioriti[sz]e)/.test(text)) {
    return {
      kind: 'priority',
      folder: after(text, /(bo uu tien|huy uu tien|thoi uu tien|unprioriti[sz]e)/),
      on: false,
    }
  }
  if (/(uu tien|prioriti[sz]e)/.test(text)) {
    return { kind: 'priority', folder: after(text, /(uu tien|prioriti[sz]e)/), on: true }
  }
  if (/(dung quet|ngung quet|stop scan|huy quet)/.test(text)) return { kind: 'stop-scan' }
  if (/(tam dung|tam ngung|dung index|ngung index|dung lai|pause|stop index|tat index)/.test(text))
    return { kind: 'pause' }
  if (/(tiep tuc|chay tiep|bat lai|bat index|resume|chay lai index|mo lai)/.test(text))
    return { kind: 'resume' }
  if (/(thu lai|retry|sua loi|chay lai cac loi|index lai cac loi)/.test(text))
    return { kind: 'retry' }
  if (/(quet lai|quet thu muc|quet ngay|scan|rescan|cap nhat index)/.test(text)) {
    return {
      kind: 'scan',
      folder: after(text, /(quet lai|quet thu muc|quet ngay|rescan|scan)/) || undefined,
    }
  }
  if (/(che do|mode|toc do)/.test(text)) {
    if (/(nhe|light|em|tiet kiem)/.test(text)) return { kind: 'mode', mode: 'light' }
    if (/(nhanh|fast|manh)/.test(text)) return { kind: 'mode', mode: 'fast' }
    if (/(can bang|balanced|vua)/.test(text)) return { kind: 'mode', mode: 'balanced' }
  }
  if (/(mo hinh|model).*(tim kiem|search|index)|chat luong cao|vietnamese embedding/.test(text)) {
    if (/(cao|high|vietnamese)/.test(text)) return { kind: 'model', profile: 'high' }
    if (/(chuan|standard|e5|thuong)/.test(text)) return { kind: 'model', profile: 'standard' }
  }
  if (
    /(toi dau|tien do|trang thai|status|progress|bao nhieu|con bao nhieu|xong chua|the nao|sao roi|dang lam gi|bao lau|index chua|con lai)/.test(
      text,
    )
  )
    return { kind: 'status' }
  return null
}

const STR = {
  vi: {
    help: 'Mình làm được:\n• "index tới đâu rồi?" – xem tiến độ\n• "tạm dừng index" / "tiếp tục index"\n• "quét lại" hoặc "quét lại thư mục <tên>"\n• "ưu tiên thư mục <tên>" / "bỏ ưu tiên <tên>"\n• "thử lại các lỗi"\n• "chế độ nhẹ / cân bằng / nhanh"\n• "dùng mô hình chất lượng cao / chuẩn"',
    unavailable: 'Chưa đọc được trạng thái chỉ mục.',
    paused: 'Đang tạm dừng',
    running: 'Đang chạy',
    idle: 'Đã xong, không còn gì chờ',
    off: 'Bộ nhớ tài liệu đang tắt',
    files: '{ready}/{total} tệp đã xong ({pct}%), {pending} đang chờ, {errors} lỗi.',
    chunks: 'Đã lưu {chunks} đoạn và {vectors} vector từ {docs} tài liệu.',
    scanning: 'Đang quét thư mục: {root} ({discovered} tệp thấy, {enrolled} mới).',
    model: 'Mô hình tìm kiếm: {state}.',
    modelDownloading: 'đang tải {p}%',
    modelReady: 'sẵn sàng',
    modelError: 'lỗi ({e})',
    modelIdle: 'chưa nạp',
    mode: 'Chế độ: {mode}.',
    modes: { light: 'nhẹ', balanced: 'cân bằng', fast: 'nhanh' },
    paused2: 'Đã tạm dừng index. Nói "tiếp tục index" khi muốn chạy lại.',
    resumed: 'Đã bật lại index.',
    scanStarted: 'Đã bắt đầu quét lại {root}.',
    scanAll: 'Đã bắt đầu quét lại {n} thư mục.',
    scanNone: 'Chưa có thư mục nào để quét. Hãy thêm thư mục trong tab Thư mục.',
    stopped: 'Đã dừng quét.',
    retried: 'Đã xếp lại {n} tệp lỗi để thử lại.',
    retryNone: 'Không có tệp lỗi nào để thử lại.',
    noFolder: 'Mình không tìm thấy thư mục "{q}". Các thư mục: {list}.',
    needFolder: 'Cho mình biết thư mục nào (một phần tên là đủ).',
    prioOn: 'Thư mục {root} sẽ được index trước.',
    prioOff: 'Đã bỏ ưu tiên thư mục {root}.',
    modeSet: 'Đã chuyển sang chế độ {mode}.',
    modelSet:
      'Đã đổi mô hình tìm kiếm sang "{name}"; tài liệu sẽ được đọc lại ở nền ({n} tệp xếp hàng).',
    failed: 'Không làm được: {e}',
    high: 'chất lượng cao',
    standard: 'chuẩn',
  },
  en: {
    help: 'I can do:\n• "how far is indexing?" – progress\n• "pause indexing" / "resume indexing"\n• "rescan" or "rescan folder <name>"\n• "prioritize folder <name>" / "unprioritize <name>"\n• "retry the errors"\n• "light / balanced / fast mode"\n• "use the high quality / standard model"',
    unavailable: 'The index status is not readable yet.',
    paused: 'Paused',
    running: 'Running',
    idle: 'Done, nothing waiting',
    off: 'Document memory is off',
    files: '{ready}/{total} files done ({pct}%), {pending} waiting, {errors} problems.',
    chunks: '{chunks} passages and {vectors} vectors stored from {docs} documents.',
    scanning: 'Scanning folder: {root} ({discovered} files seen, {enrolled} new).',
    model: 'Search model: {state}.',
    modelDownloading: 'downloading {p}%',
    modelReady: 'ready',
    modelError: 'error ({e})',
    modelIdle: 'not loaded',
    mode: 'Mode: {mode}.',
    modes: { light: 'light', balanced: 'balanced', fast: 'fast' },
    paused2: 'Indexing paused. Say "resume indexing" to continue.',
    resumed: 'Indexing is on again.',
    scanStarted: 'Rescanning {root}.',
    scanAll: 'Rescanning {n} folders.',
    scanNone: 'No folder to scan yet. Add one in the Folders tab.',
    stopped: 'Scan stopped.',
    retried: 'Queued {n} failed files to try again.',
    retryNone: 'No failed files to retry.',
    noFolder: 'No folder matches "{q}". Folders: {list}.',
    needFolder: 'Tell me which folder (part of the name is enough).',
    prioOn: '{root} will be indexed first.',
    prioOff: '{root} is no longer prioritized.',
    modeSet: 'Switched to {mode} mode.',
    modelSet:
      'Search model is now "{name}"; documents are re-read in the background ({n} files queued).',
    failed: 'Could not do that: {e}',
    high: 'high quality',
    standard: 'standard',
  },
}
type Words = typeof STR.en

export function indexWords(lang: string): Words {
  return (lang === 'vi' ? STR.vi : STR.en) as Words
}
const fill = (text: string, values: Record<string, string | number>): string =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
const num = (n: number, lang: string): string => n.toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US')
const folderName = (root: string): string => root.split(/[\\/]/).filter(Boolean).pop() ?? root

function findFolder(folders: IndexedFolder[], query: string): IndexedFolder | null {
  const q = plain(query)
  if (!q) return null
  return (
    folders.find((f) => plain(folderName(f.root)) === q) ??
    folders.find((f) => plain(f.root).includes(q)) ??
    null
  )
}

/** One paragraph about how indexing is going, from live numbers. */
export async function describeIndexStatus(api: HomeApi, lang: string): Promise<string> {
  const w = indexWords(lang)
  const [mem, act, mode] = await Promise.allSettled([
    api.getDocumentMemoryStatus(),
    api.getIndexingActivity(),
    api.getIndexingModeState?.(),
  ])
  if (mem.status !== 'fulfilled' || act.status !== 'fulfilled') return w.unavailable
  const m = mem.value
  const a = act.value
  const lines: string[] = []
  const paused = mode.status === 'fulfilled' && mode.value?.effective?.paused
  const state = !m.enabled
    ? w.off
    : paused
      ? w.paused
      : m.pending > 0 || a.folder?.running
        ? w.running
        : w.idle
  const progress = a.folderProgress
  lines.push(
    progress
      ? `${state}. ${fill(w.files, {
          ready: num(progress.readyFiles, lang),
          total: num(progress.totalFiles, lang),
          pct: progress.percent ?? 0,
          pending: num(progress.pendingFiles, lang),
          errors: num(progress.errorFiles, lang),
        })}`
      : `${state}. ${fill(w.files, {
          ready: num(m.documents - m.pending - m.errors, lang),
          total: num(m.documents, lang),
          pct: m.documents
            ? Math.round(((m.documents - m.pending - m.errors) / m.documents) * 100)
            : 0,
          pending: num(m.pending, lang),
          errors: num(m.errors, lang),
        })}`,
  )
  lines.push(
    fill(w.chunks, {
      chunks: num(m.chunks, lang),
      vectors: num(m.vectors, lang),
      docs: num(m.documents, lang),
    }),
  )
  if (a.folder?.running && a.folder.root)
    lines.push(
      fill(w.scanning, {
        root: a.folder.root,
        discovered: num(a.folder.discovered, lang),
        enrolled: num(a.folder.enrolled, lang),
      }),
    )
  const modelState =
    m.modelState === 'ready'
      ? w.modelReady
      : m.modelState === 'downloading'
        ? fill(w.modelDownloading, {
            p: Math.round((m.modelProgress ?? 0) * (m.modelProgress! <= 1 ? 100 : 1)),
          })
        : m.modelState === 'error'
          ? fill(w.modelError, { e: m.lastError ?? '' })
          : w.modelIdle
  lines.push(fill(w.model, { state: modelState }))
  if (mode.status === 'fulfilled' && mode.value)
    lines.push(fill(w.mode, { mode: w.modes[mode.value.mode] }))
  return lines.join('\n')
}

/** Carry out a command and say what happened. `onChanged` lets the page refresh itself. */
export async function runIndexCommand(
  api: HomeApi,
  command: IndexCommand,
  lang: string,
  onChanged?: () => void,
): Promise<string> {
  const w = indexWords(lang)
  try {
    switch (command.kind) {
      case 'help':
        return w.help
      case 'status':
        return await describeIndexStatus(api, lang)
      case 'pause':
        await api.setDocumentMemoryEnabled(false)
        onChanged?.()
        return w.paused2
      case 'resume':
        await api.setDocumentMemoryEnabled(true)
        onChanged?.()
        return w.resumed
      case 'stop-scan':
        await api.stopDocumentFolderScan()
        onChanged?.()
        return w.stopped
      case 'retry': {
        const status = await api.getIndexingActivity()
        const root = status.folder?.root
        if (!root) return w.retryNone
        const result = await api.retryDocumentIndexGroup(root)
        onChanged?.()
        return result.ok && result.retried > 0
          ? fill(w.retried, { n: result.retried })
          : w.retryNone
      }
      case 'scan': {
        const folders = await api.listIndexedFolders()
        if (!folders.length) return w.scanNone
        if (command.folder) {
          const hit = findFolder(folders, command.folder)
          if (!hit)
            return fill(w.noFolder, {
              q: command.folder,
              list: folders.map((f) => folderName(f.root)).join(', '),
            })
          const result = await api.rescanIndexedFolder(hit.root)
          onChanged?.()
          return result.ok
            ? fill(w.scanStarted, { root: folderName(hit.root) })
            : fill(w.failed, { e: result.error ?? '' })
        }
        let started = 0
        for (const folder of folders) {
          if (folder.unavailable) continue
          if ((await api.rescanIndexedFolder(folder.root)).ok) started++
        }
        onChanged?.()
        return fill(w.scanAll, { n: started })
      }
      case 'priority': {
        const folders = await api.listIndexedFolders()
        if (!command.folder) return w.needFolder
        const hit = findFolder(folders, command.folder)
        if (!hit)
          return fill(w.noFolder, {
            q: command.folder,
            list: folders.map((f) => folderName(f.root)).join(', '),
          })
        await api.setIndexedFolderPriority(hit.root, command.on)
        onChanged?.()
        return fill(command.on ? w.prioOn : w.prioOff, { root: folderName(hit.root) })
      }
      case 'mode':
        await api.setIndexingMode(command.mode)
        onChanged?.()
        return fill(w.modeSet, { mode: w.modes[command.mode] })
      case 'model': {
        const result = await api.setEmbeddingModel(command.profile)
        onChanged?.()
        return result.ok
          ? fill(w.modelSet, {
              name: command.profile === 'high' ? w.high : w.standard,
              n: result.requeued,
            })
          : fill(w.failed, { e: '' })
      }
    }
  } catch (error) {
    return fill(w.failed, { e: error instanceof Error ? error.message : String(error) })
  }
}
