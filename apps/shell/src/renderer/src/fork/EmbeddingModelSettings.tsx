import { appConfirm } from '../ui-feedback'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  EmbeddingModelState,
  EmbeddingProfileChoice,
} from '../../../shared/fork/document-index-api'
import { useI18n } from '../locale'

const EN = {
  title: 'Search model',
  desc: 'The model that turns text into vectors for semantic search. Changing it re-reads your indexed files in the background.',
  standard: 'Standard',
  standardDesc:
    'Fast and light (about {download} MB download, {memory} MB of memory). Works on every computer.',
  high: 'High quality (Vietnamese)',
  highDesc:
    'Finds the right Vietnamese passage noticeably more often (about 10 points better on a legal-search test) but is about 6 times slower and needs about {download} MB of download and {memory} MB of memory.',
  machine: 'This computer: {mem} GB memory, {cores} processor threads.',
  recommended: 'Recommended here',
  limitMemory:
    'High quality needs at least 16 GB of memory; this computer has less, so Standard is advised.',
  limitCpu: 'High quality would be very slow with this few processor threads; Standard is advised.',
  confirmHigh:
    'Switch to the high-quality model?\n\nIt downloads about {download} MB and re-reads all indexed files, which can take hours on this computer. Search keeps working meanwhile.',
  confirmHighWeak:
    'Switch to the high-quality model?\n\nThis computer is below what it needs ({reason}). Indexing will be slow and may use a lot of memory.\n\nIt downloads about {download} MB and re-reads all indexed files.',
  confirmStandard:
    'Switch back to the standard model?\n\nAll indexed files are re-read with it in the background. Search keeps working meanwhile.',
  switching: 'Switching…',
  switched: 'Switched. {n} files are being re-read.',
  active: 'In use',
}
const VI: typeof EN = {
  title: 'Mô hình tìm kiếm',
  desc: 'Mô hình biến văn bản thành vector để tìm theo ngữ nghĩa. Đổi mô hình sẽ đọc lại các tệp đã lập chỉ mục ở chế độ nền.',
  standard: 'Tiêu chuẩn',
  standardDesc:
    'Nhanh và nhẹ (tải khoảng {download} MB, dùng khoảng {memory} MB bộ nhớ). Chạy tốt trên mọi máy.',
  high: 'Chất lượng cao (tiếng Việt)',
  highDesc:
    'Tìm đúng đoạn tiếng Việt chính xác hơn rõ rệt (hơn khoảng 10 điểm trong bài thử tìm văn bản pháp luật) nhưng chậm hơn khoảng 6 lần, cần tải khoảng {download} MB và dùng khoảng {memory} MB bộ nhớ.',
  machine: 'Máy này: {mem} GB RAM, {cores} luồng xử lý.',
  recommended: 'Phù hợp với máy này',
  limitMemory: 'Chất lượng cao cần ít nhất 16 GB RAM; máy này ít hơn nên nên dùng Tiêu chuẩn.',
  limitCpu: 'Máy có quá ít luồng xử lý nên bản chất lượng cao sẽ rất chậm; nên dùng Tiêu chuẩn.',
  confirmHigh:
    'Chuyển sang mô hình chất lượng cao?\n\nCần tải khoảng {download} MB và đọc lại toàn bộ tệp đã lập chỉ mục, có thể mất vài giờ trên máy này. Tìm kiếm vẫn dùng được trong lúc đó.',
  confirmHighWeak:
    'Chuyển sang mô hình chất lượng cao?\n\nMáy này chưa đạt yêu cầu ({reason}). Việc lập chỉ mục sẽ chậm và có thể tốn nhiều bộ nhớ.\n\nCần tải khoảng {download} MB và đọc lại toàn bộ tệp đã lập chỉ mục.',
  confirmStandard:
    'Quay về mô hình tiêu chuẩn?\n\nToàn bộ tệp đã lập chỉ mục sẽ được đọc lại ở chế độ nền. Tìm kiếm vẫn dùng được trong lúc đó.',
  switching: 'Đang chuyển…',
  switched: 'Đã chuyển. {n} tệp đang được đọc lại.',
  active: 'Đang dùng',
}
const ZH: typeof EN = {
  title: '搜索模型',
  desc: '把文本转换为向量以进行语义搜索的模型。更换后会在后台重新读取已索引的文件。',
  standard: '标准',
  standardDesc: '快速轻量（下载约 {download} MB，占用约 {memory} MB 内存）。适合所有电脑。',
  high: '高质量（越南语）',
  highDesc:
    '明显更常找到正确的越南语段落（在法律检索测试中约高 10 分），但慢约 6 倍，需要下载约 {download} MB，占用约 {memory} MB 内存。',
  machine: '本机：{mem} GB 内存，{cores} 个处理线程。',
  recommended: '适合本机',
  limitMemory: '高质量至少需要 16 GB 内存；本机内存较少，建议使用标准。',
  limitCpu: '处理线程太少，高质量会非常慢；建议使用标准。',
  confirmHigh:
    '切换到高质量模型？\n\n需要下载约 {download} MB，并重新读取所有已索引文件，在这台电脑上可能需要数小时。期间搜索仍可使用。',
  confirmHighWeak:
    '切换到高质量模型？\n\n本机未达到要求（{reason}）。索引会很慢，并可能占用大量内存。\n\n需要下载约 {download} MB，并重新读取所有已索引文件。',
  confirmStandard: '切换回标准模型？\n\n所有已索引的文件会在后台重新读取。期间搜索仍可使用。',
  switching: '正在切换…',
  switched: '已切换。正在重新读取 {n} 个文件。',
  active: '使用中',
}
const DICTS: Record<string, typeof EN> = { en: EN, vi: VI, zh: ZH }

function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
}

export function EmbeddingModelSettings() {
  const { lang } = useI18n()
  const d = DICTS[lang] ?? EN
  const [state, setState] = useState<EmbeddingModelState | null>(null)
  const [busy, setBusy] = useState(false)
  const choicePending = useRef(false)
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    try {
      const next = await window.aiOffice.getEmbeddingModel?.()
      if (next) setState(next)
    } catch {
      // keep what is shown
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  if (!state) return null

  const choose = async (choice: EmbeddingProfileChoice) => {
    if (choicePending.current || busy || choice === state.profile) return
    const info = state.profiles.high
    const values = { download: info.downloadMB, reason: '' }
    let message = d.confirmStandard
    if (choice === 'high') {
      message =
        state.recommended === 'high'
          ? fill(d.confirmHigh, values)
          : fill(d.confirmHighWeak, {
              ...values,
              reason:
                state.limit === 'memory'
                  ? `${state.machine.totalMemGiB} GB RAM`
                  : `${state.machine.logicalCores} threads`,
            })
    }
    choicePending.current = true
    setBusy(true)
    try {
      if (!(await appConfirm(message))) return
      setNote(d.switching)
      const result = await window.aiOffice.setEmbeddingModel(choice)
      setNote(result.ok ? fill(d.switched, { n: result.requeued }) : '')
    } catch {
      setNote('')
    } finally {
      choicePending.current = false
      setBusy(false)
      void load()
    }
  }

  const option = (id: EmbeddingProfileChoice, title: string, desc: string) => {
    const info = state.profiles[id]
    const selected = state.profile === id
    return (
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={busy}
        className={`set-model-option${selected ? ' is-selected' : ''}`}
        onClick={() => void choose(id)}
      >
        <span className="set-model-option-head">
          <strong>{title}</strong>
          {selected && <span className="set-model-badge">{d.active}</span>}
          {state.recommended === id && (
            <span className="set-model-badge is-hint">{d.recommended}</span>
          )}
        </span>
        <span className="set-model-option-name">
          {info.name} · {info.dimensions}d
        </span>
        <span className="set-field-desc">
          {fill(desc, { download: info.downloadMB, memory: info.memoryMB })}
        </span>
      </button>
    )
  }

  return (
    <div className="set-model">
      <h4 className="set-field-label">{d.title}</h4>
      <p className="set-field-desc">{d.desc}</p>
      <p className="set-field-desc">
        {fill(d.machine, { mem: state.machine.totalMemGiB, cores: state.machine.logicalCores })}
        {state.limit === 'memory'
          ? ` ${d.limitMemory}`
          : state.limit === 'cpu'
            ? ` ${d.limitCpu}`
            : ''}
      </p>
      <div className="set-model-options" role="radiogroup" aria-label={d.title}>
        {option('standard', d.standard, d.standardDesc)}
        {option('high', d.high, d.highDesc)}
      </div>
      {note && (
        <p className="set-field-desc" role="status">
          {note}
        </p>
      )}
    </div>
  )
}
