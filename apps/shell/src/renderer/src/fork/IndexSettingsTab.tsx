import { appConfirm } from '../ui-feedback'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import { useI18n } from '../locale'
import { IndexingModeSettings } from './IndexingModeSettings'
import { AgyOcrSettings } from './AgyOcrSettings'
import { EmbeddingModelSettings } from './EmbeddingModelSettings'
import { EverythingSettings } from './EverythingSettings'
import { DbLocationSettings } from './DbLocationSettings'
import { IndexStorageSettings } from './IndexStorageSettings'
import { PdfPagesSettings } from './PdfPagesSettings'
import { IndexDiagnostics } from './IndexDiagnostics'
import './index-settings.css'
import { IndexMutationTimeout, runIndexMutation } from './index-mutation'
import type { IgnoreRule, IndexedFolder } from '../../../shared/fork/document-index-api'

const EN = {
  title: 'Index settings',
  hint: 'Choose how your files are read and kept ready for search.',
  advanced: 'Advanced reading & search',
  advancedHint: 'Fine-tune scanned documents and search quality when needed.',
  storage: 'Index storage',
  storageHint: 'Choose where the local search database is kept.',
  clearTitle: 'Clear indexed content',
  clearHint:
    'Removes extracted text and search data. Your original files stay in place; excluded files remain excluded.',
  clearing: 'Clearing…',
  failed: 'The index could not be cleared. Please try again.',
  unknown:
    'The clear request has not acknowledged completion. Check the index before trying again.',
  run: 'Running in the background',
  runHint: 'How hard it works, and when it rests',
  pdf: 'PDF pages',
  pdfHint: 'How many pages of each PDF are read',
  ocr: 'Reading scanned PDFs',
  ocrHint: 'Daily limit, pages, model, quota floors',
  model: 'Search model',
  modelHint: 'Standard or high quality',
  diagnostics: 'Diagnostics',
  diagnosticsHint: 'Model architecture, vector dimensions, ANN state, and cache',
  data: 'Data',
  dataHint: 'Where the index is kept, and clearing it',
  clear: 'Clear indexed content…',
  confirm:
    'Clear indexed content on this computer? Extracted text and search data will be removed. Original files and exclusions are kept.',
  cleared: 'Indexed content was cleared.',
  ignore: 'Ignore rules',
  ignoreHint: 'Exclude files and folders by pattern or folder scope from indexing.',
  ignoreAddRule: 'Add rule',
  ignorePatternPlaceholder: 'Pattern (e.g. *.tmp, private/, ~$*)',
  ignoreDescPlaceholder: 'Description (optional)',
  ignoreScopeAll: 'All folders (Global)',
  ignoreScope: 'Scope',
  ignoreEmpty: 'No ignore rules configured.',
  ignoreTestTitle: 'Test a path',
  ignoreTestPlaceholder: 'Enter a file or folder path to test (e.g. C:\\Docs\\file.tmp)',
  ignoreTestBtn: 'Check path',
  ignoreStatusIgnored: 'Ignored (excluded from indexing and search)',
  ignoreStatusIndexed: 'Indexed (available in search)',
  ignoreStatusNotIndexed: 'Not yet indexed (allowed by ignore rules)',
  ignoreSaved: 'Ignore rules saved.',
  ignoreDelete: 'Remove',
  ignoreEdit: 'Edit',
  ignoreSave: 'Save',
  ignoreCancel: 'Cancel',
  ignoreFromGenoffice: '.genofficeignore',
  ignoreUserRule: 'Custom',
}
const VI: typeof EN = {
  title: 'Cài đặt chỉ mục',
  hint: 'Chọn cách đọc tệp và chuẩn bị dữ liệu để tìm kiếm.',
  advanced: 'Đọc & tìm kiếm nâng cao',
  advancedHint: 'Tinh chỉnh tài liệu quét và chất lượng tìm kiếm khi cần.',
  storage: 'Nơi lưu chỉ mục',
  storageHint: 'Chọn nơi lưu cơ sở dữ liệu tìm kiếm trên máy.',
  clearTitle: 'Xoá nội dung đã lập chỉ mục',
  clearHint:
    'Xoá văn bản đã trích xuất và dữ liệu tìm kiếm. Tệp gốc được giữ nguyên; tệp đã loại trừ vẫn được loại trừ.',
  clearing: 'Đang xoá…',
  failed: 'Không thể xoá chỉ mục. Vui lòng thử lại.',
  unknown: 'Chưa nhận được xác nhận xoá xong. Hãy kiểm tra chỉ mục trước khi thực hiện lại.',
  run: 'Chạy nền',
  runHint: 'Làm việc mạnh nhẹ ra sao, khi nào nghỉ',
  pdf: 'Số trang PDF',
  pdfHint: 'Đọc bao nhiêu trang đầu của mỗi PDF',
  ocr: 'Đọc PDF quét (OCR)',
  ocrHint: 'Số PDF mỗi ngày, số trang, mô hình, ngưỡng quota',
  model: 'Mô hình tìm kiếm',
  modelHint: 'Chuẩn hay chất lượng cao',
  diagnostics: 'Chẩn đoán',
  diagnosticsHint: 'Kiến trúc mô hình, số chiều vector, trạng thái ANN và bộ nhớ đệm',
  data: 'Dữ liệu',
  dataHint: 'Chỉ mục nằm ở đâu, và xoá nó',
  clear: 'Xoá nội dung chỉ mục…',
  confirm:
    'Xoá nội dung đã lập chỉ mục trên máy? Văn bản trích xuất và dữ liệu tìm kiếm sẽ bị xoá. Tệp gốc và danh sách loại trừ được giữ nguyên.',
  cleared: 'Đã xoá nội dung chỉ mục.',
  ignore: 'Quy tắc loại trừ',
  ignoreHint: 'Loại trừ tệp và thư mục theo mẫu hoặc phạm vi thư mục khỏi chỉ mục.',
  ignoreAddRule: 'Thêm quy tắc',
  ignorePatternPlaceholder: 'Mẫu (vd: *.tmp, private/, ~$*)',
  ignoreDescPlaceholder: 'Mô tả (tuỳ chọn)',
  ignoreScopeAll: 'Tất cả thư mục (Toàn cục)',
  ignoreScope: 'Phạm vi',
  ignoreEmpty: 'Chưa có quy tắc loại trừ nào.',
  ignoreTestTitle: 'Kiểm tra đường dẫn',
  ignoreTestPlaceholder: 'Nhập đường dẫn tệp hoặc thư mục để thử (vd: C:\\Docs\\file.tmp)',
  ignoreTestBtn: 'Kiểm tra',
  ignoreStatusIgnored: 'Đã loại trừ (bị bỏ qua khi quét và tìm kiếm)',
  ignoreStatusIndexed: 'Đã lập chỉ mục (tìm kiếm được)',
  ignoreStatusNotIndexed: 'Chưa lập chỉ mục (hợp lệ theo quy tắc loại trừ)',
  ignoreSaved: 'Đã lưu quy tắc loại trừ.',
  ignoreDelete: 'Xoá',
  ignoreEdit: 'Sửa',
  ignoreSave: 'Lưu',
  ignoreCancel: 'Huỷ',
  ignoreFromGenoffice: '.genofficeignore',
  ignoreUserRule: 'Tuỳ chỉnh',
}

type SectionIcon = 'run' | 'pdf' | 'ocr' | 'model' | 'data' | 'diagnostics' | 'ignore'
const ICON_PATHS: Record<SectionIcon, string> = {
  run: 'M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  pdf: 'M7 3h7l4 4v14H7zM14 3v5h4M10 12h5m-5 4h5',
  ocr: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 9h8m-4 0v7m-3 0h6',
  model: 'M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Zm5.5-2 5 5',
  diagnostics: 'M22 12h-4l-3 9L9 3l-3 9H2',
  data: 'M4 6c0-4 16-4 16 0s-16 4-16 0Zm0 0v6c0 4 16 4 16 0V6M4 12v6c0 4 16 4 16 0v-6',
  ignore:
    'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm-7 10a7 7 0 0 1 11.95-4.95l-9.9 9.9A6.95 6.95 0 0 1 5 12zm7 7a6.95 6.95 0 0 1-4.95-2.05l9.9-9.9A7 7 0 0 1 12 19z',
}
function Section({
  title,
  hint,
  icon,
  open = false,
  children,
  id,
}: {
  title: string
  hint: string
  icon: SectionIcon
  open?: boolean
  children: ReactNode
  id?: string
}) {
  return (
    <details id={id} className="idx-details" open={open}>
      <summary>
        <svg className="ixs-icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d={ICON_PATHS[icon]}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="ixs-section-text">
          <strong>{title}</strong>
          <span>{hint}</span>
        </span>
      </summary>
      <div>{children}</div>
    </details>
  )
}

export function IgnoreRulesSettings({ api }: { api: HomeApi }) {
  const { lang } = useI18n()
  const d = lang === 'vi' ? VI : EN
  const [rules, setRules] = useState<IgnoreRule[]>([])
  const [folders, setFolders] = useState<string[]>([])
  const [newPattern, setNewPattern] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newScope, setNewScope] = useState('global')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editPattern, setEditPattern] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [testPath, setTestPath] = useState('')
  const [testResult, setTestResult] = useState<{
    tested: boolean
    ignored: boolean
    reason?: string
    status?: 'ignored' | 'indexed' | 'not-yet-indexed'
  } | null>(null)
  const [note, setNote] = useState('')

  const loadData = useCallback(async () => {
    try {
      if (api.getIgnoreRules) {
        const active = await api.getIgnoreRules()
        setRules(active)
      }
      if (api.listIndexedFolders) {
        const indexed = await api.listIndexedFolders()
        setFolders(indexed.map((f: IndexedFolder) => f.root))
      }
    } catch {
      // safe fallback
    }
  }, [api])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const saveRules = async (nextRules: IgnoreRule[]) => {
    setRules(nextRules)
    try {
      if (api.saveIgnoreRules) {
        await api.saveIgnoreRules(nextRules)
        setNote(d.ignoreSaved)
        setTimeout(() => setNote(''), 3000)
      }
    } catch {
      setNote(d.failed)
    }
  }

  const handleToggle = (id: string) => {
    const next = rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))
    void saveRules(next)
  }

  const handleDelete = (id: string) => {
    const next = rules.filter((r) => r.id !== id)
    void saveRules(next)
  }

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    const pat = newPattern.trim()
    if (!pat) return
    const newRule: IgnoreRule = {
      id: `rule-${Date.now()}`,
      pattern: pat,
      enabled: true,
      scope: newScope,
      description: newDescription.trim() || undefined,
      source: 'user',
    }
    const next = [...rules, newRule]
    setNewPattern('')
    setNewDescription('')
    void saveRules(next)
  }

  const startEdit = (rule: IgnoreRule) => {
    setEditingId(rule.id)
    setEditPattern(rule.pattern)
    setEditDescription(rule.description || '')
  }

  const handleSaveEdit = (id: string) => {
    const pat = editPattern.trim()
    if (!pat) return
    const next = rules.map((r) =>
      r.id === id ? { ...r, pattern: pat, description: editDescription.trim() || undefined } : r,
    )
    setEditingId(null)
    void saveRules(next)
  }

  const handleTest = async (e: React.FormEvent) => {
    e.preventDefault()
    const p = testPath.trim()
    if (!p) return
    if (!api.testIgnorePath) {
      setTestResult({
        tested: true,
        ignored: false,
        reason: 'API unavailable',
        status: 'not-yet-indexed',
      })
      return
    }
    try {
      const res = await api.testIgnorePath(p)
      let status: 'ignored' | 'indexed' | 'not-yet-indexed' = 'not-yet-indexed'
      if (res.ignored) {
        status = 'ignored'
      } else if (api.searchIndexedFiles) {
        const basename = p.replace(/\\/g, '/').split('/').pop() || p
        const hits = await api.searchIndexedFiles(basename).catch(() => [])
        const normP = p.replace(/\\/g, '/').toLowerCase()
        const match = hits.some((h) => h.path.replace(/\\/g, '/').toLowerCase() === normP)
        status = match ? 'indexed' : 'not-yet-indexed'
      }
      setTestResult({
        tested: true,
        ignored: res.ignored,
        reason: res.reason,
        status,
      })
    } catch {
      setTestResult({
        tested: true,
        ignored: false,
        reason: 'Error testing path',
        status: 'not-yet-indexed',
      })
    }
  }

  return (
    <div className="ixs-ignore">
      <div className="ixs-ignore-list">
        {rules.length === 0 ? (
          <p className="idx-muted">{d.ignoreEmpty}</p>
        ) : (
          rules.map((rule) => {
            const isEditing = editingId === rule.id
            const isGenoffice = rule.source === '.genofficeignore'
            return (
              <div key={rule.id} className={`ixs-ignore-item ${!rule.enabled ? 'disabled' : ''}`}>
                {isEditing ? (
                  <div className="ixs-ignore-edit-row">
                    <input
                      type="text"
                      className="idx-input"
                      value={editPattern}
                      onChange={(e) => setEditPattern(e.target.value)}
                      placeholder={d.ignorePatternPlaceholder}
                    />
                    <input
                      type="text"
                      className="idx-input"
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      placeholder={d.ignoreDescPlaceholder}
                    />
                    <div className="ixs-ignore-actions">
                      <button
                        type="button"
                        className="idx-btn idx-btn-primary"
                        onClick={() => handleSaveEdit(rule.id)}
                      >
                        {d.ignoreSave}
                      </button>
                      <button type="button" className="idx-btn" onClick={() => setEditingId(null)}>
                        {d.ignoreCancel}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="ixs-ignore-meta">
                      <label className="ixs-ignore-check">
                        <input
                          type="checkbox"
                          checked={rule.enabled}
                          onChange={() => handleToggle(rule.id)}
                        />
                      </label>
                      <span className="ixs-ignore-pattern">{rule.pattern}</span>
                      {rule.description && (
                        <span className="ixs-ignore-desc">{rule.description}</span>
                      )}
                      <span className="ixs-ignore-badge">
                        {rule.scope === 'global' ? d.ignoreScopeAll : rule.scope}
                      </span>
                      {isGenoffice && (
                        <span className="ixs-ignore-badge ixs-badge-genoffice">
                          {d.ignoreFromGenoffice}
                        </span>
                      )}
                    </div>
                    {!isGenoffice && (
                      <div className="ixs-ignore-actions">
                        <button
                          type="button"
                          className="idx-btn idx-btn-sm"
                          onClick={() => startEdit(rule)}
                        >
                          {d.ignoreEdit}
                        </button>
                        <button
                          type="button"
                          className="idx-btn idx-btn-sm idx-btn-danger"
                          onClick={() => handleDelete(rule.id)}
                        >
                          {d.ignoreDelete}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          })
        )}
      </div>

      <form className="ixs-ignore-form" onSubmit={handleAdd}>
        <input
          type="text"
          className="idx-input"
          value={newPattern}
          onChange={(e) => setNewPattern(e.target.value)}
          placeholder={d.ignorePatternPlaceholder}
          required
        />
        <input
          type="text"
          className="idx-input"
          value={newDescription}
          onChange={(e) => setNewDescription(e.target.value)}
          placeholder={d.ignoreDescPlaceholder}
        />
        <select
          className="idx-input"
          value={newScope}
          onChange={(e) => setNewScope(e.target.value)}
        >
          <option value="global">{d.ignoreScopeAll}</option>
          {folders.map((folder) => (
            <option key={folder} value={folder}>
              {folder}
            </option>
          ))}
        </select>
        <button type="submit" className="idx-btn idx-btn-primary">
          {d.ignoreAddRule}
        </button>
      </form>

      <div className="ixs-ignore-tester">
        <h4>{d.ignoreTestTitle}</h4>
        <form className="ixs-tester-form" onSubmit={handleTest}>
          <input
            type="text"
            className="idx-input"
            value={testPath}
            onChange={(e) => setTestPath(e.target.value)}
            placeholder={d.ignoreTestPlaceholder}
          />
          <button type="submit" className="idx-btn">
            {d.ignoreTestBtn}
          </button>
        </form>
        {testResult?.tested && (
          <div className={`ixs-test-result ${testResult.status || ''}`}>
            <strong>
              {testResult.status === 'ignored'
                ? d.ignoreStatusIgnored
                : testResult.status === 'indexed'
                  ? d.ignoreStatusIndexed
                  : d.ignoreStatusNotIndexed}
            </strong>
            {testResult.reason && <p>{testResult.reason}</p>}
          </div>
        )}
      </div>
      {note && (
        <p className="idx-muted" role="status">
          {note}
        </p>
      )}
    </div>
  )
}

export function IndexSettingsTab({ api, focus }: { api: HomeApi; focus?: 'ocr' }) {
  const { lang } = useI18n()
  const d = lang === 'vi' ? VI : EN
  const [note, setNote] = useState('')
  const [failed, setFailed] = useState(false)
  const [clearing, setClearing] = useState(false)
  const clearPending = useRef(false)
  useEffect(() => {
    if (focus === 'ocr')
      document.getElementById('index-settings-ocr')?.scrollIntoView({ block: 'nearest' })
  }, [focus])
  const clear = async () => {
    if (clearPending.current) return
    clearPending.current = true
    setClearing(true)
    try {
      if (
        !(await appConfirm(d.confirm, {
          title: d.clearTitle,
          confirmLabel: d.clear,
          tone: 'danger',
        }))
      )
        return
      setNote('')
      setFailed(false)
      await runIndexMutation(() => api.clearDocumentMemory())
      setNote(d.cleared)
    } catch (error) {
      setFailed(true)
      setNote(error instanceof IndexMutationTimeout ? d.unknown : d.failed)
    } finally {
      clearPending.current = false
      setClearing(false)
    }
  }
  return (
    <div className="ixp ixs">
      <header className="ixs-head">
        <h2>{d.title}</h2>
        <p>{d.hint}</p>
      </header>
      <Section title={d.run} hint={d.runHint} icon="run" open>
        <IndexingModeSettings />
      </Section>
      <Section title={d.pdf} hint={d.pdfHint} icon="pdf" open>
        <PdfPagesSettings api={api} />
      </Section>
      <Section title={d.ignore} hint={d.ignoreHint} icon="ignore" open>
        <IgnoreRulesSettings api={api} />
      </Section>
      <div className="ixs-heading">
        <h3>{d.advanced}</h3>
        <p>{d.advancedHint}</p>
      </div>
      <Section
        id="index-settings-ocr"
        title={d.ocr}
        hint={d.ocrHint}
        icon="ocr"
        open={focus === 'ocr'}
      >
        <AgyOcrSettings />
      </Section>
      <Section title={d.model} hint={d.modelHint} icon="model">
        <EmbeddingModelSettings />
      </Section>
      <Section title={d.diagnostics} hint={d.diagnosticsHint} icon="diagnostics">
        <IndexDiagnostics api={api} />
      </Section>
      <EverythingSettings api={api} />
      <Section title={d.storage} hint={d.storageHint} icon="data" open>
        <DbLocationSettings api={api} />
        <IndexStorageSettings api={api} />
      </Section>
      <section className="ixs-danger" aria-label={d.clearTitle}>
        <div>
          <h3>{d.clearTitle}</h3>
          <p>{d.clearHint}</p>
        </div>
        <button
          type="button"
          className="idx-btn ixs-clear"
          disabled={clearing}
          onClick={() => void clear()}
        >
          {clearing ? d.clearing : d.clear}
        </button>
        {note && (
          <p className={failed ? 'ixs-error' : 'idx-muted'} role={failed ? 'alert' : 'status'}>
            {note}
          </p>
        )}
      </section>
    </div>
  )
}
