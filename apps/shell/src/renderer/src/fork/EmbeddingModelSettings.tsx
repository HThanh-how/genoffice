import { appConfirm } from '../ui-feedback'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type {
  EmbeddingModelState,
  EmbeddingProfileChoice,
} from '../../../shared/fork/document-index-api'
import { useI18n } from '../locale'
import { readIndexRequest } from './index-request'
import { IndexMutationTimeout, runIndexMutation } from './index-mutation'

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
  base: 'Light',
  baseDesc:
    'Fastest and smallest, made for computers with about 4 GB of memory (about {download} MB download, {memory} MB of memory).',
  balanced: 'Balanced',
  balancedDesc:
    'Better Vietnamese search for computers with about 8 GB of memory (about {download} MB download, {memory} MB of memory).',
  mid: 'High quality',
  midDesc:
    'The best quality for its speed, made for computers with 16 GB of memory (about {download} MB download, {memory} MB of memory).',
  plus: 'Maximum',
  plusDesc:
    'The same model and the same index as High quality, with more parallel work and longer passages for 32 GB computers. Switching between the two does not re-read your files.',
  recommended: 'Recommended here',
  legacyMissing:
    'The Standard search model is not downloaded on this computer and its download source is no longer available, so semantic search is off. Switch to "{name}" (recommended here) to turn it on; text search keeps working.',
  limitMemory: 'This computer has less memory than the larger models need, so a smaller one is advised.',
  limitCpu: 'The larger models would be very slow with this few processor threads; a smaller one is advised.',
  confirmSwitch:
    'Switch to this search model?\n\nIt downloads about {download} MB and re-reads all indexed files in the background. Search keeps working meanwhile.',
  confirmHeavy:
    'Switch to this search model?\n\nThis computer is below what it needs ({reason}). Indexing will be slow and may use a lot of memory.\n\nIt downloads about {download} MB and re-reads all indexed files.',
  switching: 'Switching…',
  switched: 'Switched. {n} files are being re-read.',
  active: 'In use',
  loading: 'Loading search model settings…',
  loadFailed: 'Could not load search model settings.',
  retry: 'Try again',
  saveFailed: 'Could not switch search models. Try again.',
  unknownOutcome:
    'No confirmation arrived in time. The model may have switched; reload before trying again.',
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
  base: 'Nhẹ',
  baseDesc:
    'Nhanh và nhỏ nhất, dành cho máy khoảng 4 GB RAM (tải khoảng {download} MB, dùng khoảng {memory} MB bộ nhớ).',
  balanced: 'Cân bằng',
  balancedDesc:
    'Tìm tiếng Việt tốt hơn cho máy khoảng 8 GB RAM (tải khoảng {download} MB, dùng khoảng {memory} MB bộ nhớ).',
  mid: 'Chất lượng cao',
  midDesc:
    'Chất lượng tốt nhất so với tốc độ, dành cho máy 16 GB RAM (tải khoảng {download} MB, dùng khoảng {memory} MB bộ nhớ).',
  plus: 'Tối đa',
  plusDesc:
    'Cùng mô hình và cùng chỉ mục với Chất lượng cao, nhưng chạy song song nhiều hơn và đọc đoạn dài hơn cho máy 32 GB RAM. Chuyển qua lại giữa hai bản không phải đọc lại tệp.',
  recommended: 'Phù hợp với máy này',
  legacyMissing:
    'Mô hình Tiêu chuẩn chưa được tải về máy này và nguồn tải không còn khả dụng nên tìm theo ngữ nghĩa đang tắt. Hãy chuyển sang "{name}" (phù hợp với máy này) để bật lại; tìm theo từ khóa vẫn dùng được.',
  limitMemory: 'Máy này có ít RAM hơn mức các mô hình lớn cần nên nên dùng bản nhỏ hơn.',
  limitCpu: 'Máy có quá ít luồng xử lý nên các mô hình lớn sẽ rất chậm; nên dùng bản nhỏ hơn.',
  confirmSwitch:
    'Chuyển sang mô hình tìm kiếm này?\n\nCần tải khoảng {download} MB và đọc lại toàn bộ tệp đã lập chỉ mục ở chế độ nền. Tìm kiếm vẫn dùng được trong lúc đó.',
  confirmHeavy:
    'Chuyển sang mô hình tìm kiếm này?\n\nMáy này chưa đạt yêu cầu ({reason}). Việc lập chỉ mục sẽ chậm và có thể tốn nhiều bộ nhớ.\n\nCần tải khoảng {download} MB và đọc lại toàn bộ tệp đã lập chỉ mục.',
  switching: 'Đang chuyển…',
  switched: 'Đã chuyển. {n} tệp đang được đọc lại.',
  active: 'Đang dùng',
  loading: 'Đang tải cài đặt mô hình tìm kiếm…',
  loadFailed: 'Không tải được cài đặt mô hình tìm kiếm.',
  retry: 'Thử lại',
  saveFailed: 'Không chuyển được mô hình tìm kiếm. Hãy thử lại.',
  unknownOutcome:
    'Chưa nhận xác nhận kịp thời. Mô hình có thể đã được chuyển; hãy tải lại trước khi thử tiếp.',
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
  base: '轻量',
  baseDesc: '最快最小，适合约 4 GB 内存的电脑（下载约 {download} MB，占用约 {memory} MB 内存）。',
  balanced: '均衡',
  balancedDesc: '为约 8 GB 内存的电脑提供更好的越南语搜索（下载约 {download} MB，占用约 {memory} MB 内存）。',
  mid: '高质量',
  midDesc: '同等速度下质量最好，适合 16 GB 内存的电脑（下载约 {download} MB，占用约 {memory} MB 内存）。',
  plus: '最高',
  plusDesc:
    '与“高质量”使用相同的模型和相同的索引，为 32 GB 内存的电脑提供更多并行处理和更长的段落。两者之间切换不需要重新读取文件。',
  recommended: '适合本机',
  legacyMissing:
    '本机未下载“标准”搜索模型，且其下载来源已不可用，因此语义搜索处于关闭状态。请切换到“{name}”（适合本机）以启用；文本搜索仍可使用。',
  limitMemory: '本机内存少于较大模型的需求，建议使用较小的模型。',
  limitCpu: '处理线程太少，较大的模型会非常慢；建议使用较小的模型。',
  confirmSwitch:
    '切换到此搜索模型？\n\n需要下载约 {download} MB，并在后台重新读取所有已索引文件。期间搜索仍可使用。',
  confirmHeavy:
    '切换到此搜索模型？\n\n本机未达到要求（{reason}）。索引会很慢，并可能占用大量内存。\n\n需要下载约 {download} MB，并重新读取所有已索引文件。',
  switching: '正在切换…',
  switched: '已切换。正在重新读取 {n} 个文件。',
  active: '使用中',
  loading: '正在加载搜索模型设置…',
  loadFailed: '无法加载搜索模型设置。',
  retry: '重试',
  saveFailed: '无法切换搜索模型，请重试。',
  unknownOutcome: '未能及时收到确认。模型可能已切换；请先重新加载再试。',
}
const DICTS: Record<string, typeof EN> = { en: EN, vi: VI, zh: ZH }

const CHOICES: readonly EmbeddingProfileChoice[] = ['base', 'balanced', 'mid', 'plus', 'standard', 'high']
/** Bigger = heavier; used to warn when a model is above what this computer is advised to run. */
const RANK: Record<EmbeddingProfileChoice, number> = { base: 0, standard: 0, balanced: 1, mid: 2, high: 2, plus: 3 }
const isChoice = (value: unknown): value is EmbeddingProfileChoice =>
  typeof value === 'string' && (CHOICES as readonly string[]).includes(value)

function isEmbeddingModelState(value: unknown): value is EmbeddingModelState {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<EmbeddingModelState>
  return (
    isChoice(v.profile) &&
    isChoice(v.recommended) &&
    !!v.machine &&
    Number.isFinite(v.machine.totalMemGiB) &&
    Number.isFinite(v.machine.logicalCores) &&
    !!v.profiles &&
    [v.profile, v.recommended].every((id) => {
      const profile = v.profiles?.[id as EmbeddingProfileChoice]
      return (
        !!profile &&
        typeof profile.name === 'string' &&
        Number.isFinite(profile.dimensions) &&
        Number.isFinite(profile.downloadMB) &&
        Number.isFinite(profile.memoryMB)
      )
    })
  )
}

function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
}

export function EmbeddingModelSettings() {
  const { lang } = useI18n()
  const d = DICTS[lang] ?? EN
  const [state, setState] = useState<EmbeddingModelState | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const choicePending = useRef(false)
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadFailed(false)
    try {
      const next = await readIndexRequest(
        () => window.aiOffice.getEmbeddingModel?.(),
        isEmbeddingModelState,
      )
      setState(next)
    } catch {
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  if (!state)
    return (
      <div className="set-model" role="status">
        <p className="set-field-desc">{loading ? d.loading : d.loadFailed}</p>
        {!loading && (
          <button type="button" className="idx-link" onClick={() => void load()}>
            {d.retry}
          </button>
        )}
      </div>
    )

  const choose = async (choice: EmbeddingProfileChoice) => {
    if (choicePending.current || busy || choice === state.profile) return
    const info = state.profiles[choice]
    const values = { download: info?.downloadMB ?? '', reason: '' }
    const tooHeavy = RANK[choice] > RANK[state.recommended]
    const message = tooHeavy
      ? fill(d.confirmHeavy, {
          ...values,
          reason:
            state.limit === 'cpu'
              ? `${state.machine.logicalCores} threads`
              : `${state.machine.totalMemGiB} GB RAM`,
        })
      : fill(d.confirmSwitch, values)
    choicePending.current = true
    setBusy(true)
    try {
      if (!(await appConfirm(message))) return
      setNote(d.switching)
      const result = await runIndexMutation(() => window.aiOffice.setEmbeddingModel(choice))
      setNote(result.ok ? fill(d.switched, { n: result.requeued }) : d.saveFailed)
    } catch (error) {
      setNote(error instanceof IndexMutationTimeout ? d.unknownOutcome : d.saveFailed)
    } finally {
      choicePending.current = false
      setBusy(false)
      void load()
    }
  }

  const option = (id: EmbeddingProfileChoice, title: string, desc: string) => {
    const info = state.profiles[id]
    if (!info) return null
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
      {loadFailed && (
        <p className="set-field-desc" role="status">
          {d.loadFailed}{' '}
          <button type="button" className="idx-link" onClick={() => void load()}>
            {d.retry}
          </button>
        </p>
      )}
      <p className="set-field-desc">
        {fill(d.machine, { mem: state.machine.totalMemGiB, cores: state.machine.logicalCores })}
        {state.limit === 'memory'
          ? ` ${d.limitMemory}`
          : state.limit === 'cpu'
            ? ` ${d.limitCpu}`
            : ''}
      </p>
      {state.profile === 'standard' && state.modelCached === false && state.recommended !== 'standard' && (
        <p className="set-field-desc" role="status">
          {fill(d.legacyMissing, { name: d[state.recommended as 'base' | 'balanced' | 'mid' | 'plus'] ?? state.profiles[state.recommended]?.name ?? '' })}
        </p>
      )}
      <div className="set-model-options" role="radiogroup" aria-label={d.title}>
        {(['base', 'balanced', 'mid', 'plus'] as const).map((id) => (
          <Fragment key={id}>{option(id, d[id], d[`${id}Desc`])}</Fragment>
        ))}
        {/* the two original models only stay listed for installs that still use them */}
        {state.profile === 'standard' && option('standard', d.standard, d.standardDesc)}
        {state.profile === 'high' && option('high', d.high, d.highDesc)}
      </div>
      {note && (
        <p className="set-field-desc" role="status">
          {note}
        </p>
      )}
    </div>
  )
}
