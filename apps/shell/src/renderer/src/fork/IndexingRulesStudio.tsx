import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import { useI18n } from '../locale'
import { appConfirm } from '../ui-feedback'
import type {
  GenOfficeIgnoreFileResult,
  IgnoreRule,
  IgnoreTestResult,
  IndexPolicyMode,
  IndexRuleAction,
  IndexedFolder,
  IndexingPreset,
} from '../../../shared/fork/document-index-api'

const I18N = {
  en: {
    title: 'Indexing Rules',
    subtitle: 'Choose which files GenOffice can discover and index.',
    modeStandard: 'Standard Mode',
    modeAllowlist: 'Allowlist Mode',
    modeStandardDesc:
      'All supported documents are indexed unless excluded by an active Ignore rule.',
    modeAllowlistDesc:
      'Only documents matching an explicit Allow rule or enabled document preset are indexed.',
    allowCount: 'Allow Rules',
    ignoreCount: 'Ignore Rules',
    presetsCount: 'Active Presets',
    foldersCount: 'Watched Folders',
    searchPlaceholder: 'Search patterns, descriptions, scopes…',
    filterActionAll: 'All Actions',
    filterActionAllow: 'Allow Only',
    filterActionIgnore: 'Ignore Only',
    filterScopeAll: 'All Scopes',
    filterScopeGlobal: 'Global Only',
    filterSourceAll: 'All Sources',
    filterSourceUser: 'Custom Rules',
    filterSourceGenoffice: '.genofficeignore',
    filterSourcePreset: 'Presets',
    filterStateAll: 'All States',
    filterStateEnabled: 'Enabled',
    filterStateDisabled: 'Disabled',
    addRuleBtn: 'Add Rule',
    openEditorBtn: 'Edit .genofficeignore',
    colEnabled: 'Active',
    colAction: 'Action',
    colPattern: 'Pattern',
    colScope: 'Scope',
    colSource: 'Source',
    colDesc: 'Description',
    colActions: 'Actions',
    badgeAllow: 'ALLOW',
    badgeIgnore: 'IGNORE',
    badgeCustom: 'Custom',
    badgeBuiltin: 'Built-in',
    badgeGenoffice: '.genofficeignore',
    actionEdit: 'Edit',
    actionDelete: 'Delete',
    bulkSelected: (n: number) => `${n} selected`,
    bulkEnable: 'Enable',
    bulkDisable: 'Disable',
    bulkDelete: 'Delete Selected',
    bulkExport: 'Export JSON',
    bulkClear: 'Clear Selection',
    confirmDeleteRule: (pat: string) => `Remove rule "${pat}"? This action cannot be undone.`,
    confirmBulkDelete: (n: number) => `Delete ${n} custom rules?`,
    presetsSectionTitle: 'Recommended Rule Presets',
    presetsSectionSubtitle:
      'Versioned protective and admission presets for development artifacts, lock files, and documents.',
    testerTitle: 'Policy Tester & Explainer',
    testerSubtitle:
      'Understand exactly WHY a path is allowed or ignored across the precedence hierarchy.',
    testInputPlaceholder: 'Enter absolute file or folder path (e.g. C:\\Docs\\report.docx)',
    testRootDefault: 'Auto-detect Root',
    testCheckBtn: 'Test Path',
    testTesting: 'Testing…',
    testDecisionAllowed: 'ALLOWED',
    testDecisionIgnored: 'IGNORED',
    testLabelDecision: 'Final Policy Decision',
    testLabelWinning: 'Winning Rule',
    testLabelOverridden: 'Overridden Rule',
    testLabelEligibility: 'Safety & Format Eligibility',
    testLabelIndexStatus: 'Index Status',
    testLabelExplanation: 'Detailed Explanation',
    testCopyBtn: 'Copy Result',
    testCopied: 'Copied!',
    statusIndexed: 'Indexed in search',
    statusNotIndexed: 'Not indexed',
    statusPending: 'Pending / In Queue',
    statusIgnored: 'Ignored by policy',
    editorTitle: '.genofficeignore Editor',
    editorSubtitle: 'Edit root-scoped indexing policy directives and exclusions directly on disk.',
    editorRootLabel: 'Indexed Root:',
    editorFileExists: 'File exists on disk',
    editorFileMissing: 'File not yet created',
    editorCreateFile: 'Create .genofficeignore',
    editorSaveBtn: 'Save Configuration',
    editorSaving: 'Saving…',
    editorDiscardBtn: 'Discard Draft',
    editorReloadBtn: 'Reload from Disk',
    editorTemplateBtn: 'Recommended Template',
    editorSyntaxBtn: 'Syntax Guide',
    editorCloseBtn: 'Close Editor',
    editorUnsavedBadge: 'Unsaved changes',
    editorConflictAlert:
      'The file on disk was modified by an external process. Please review or reload.',
    modalAddTitle: 'Add Indexing Rule',
    modalEditTitle: 'Edit Indexing Rule',
    modalActionLabel: 'Rule Action',
    modalActionAllow: 'Allow (Admit to index)',
    modalActionIgnore: 'Ignore (Exclude from index)',
    modalPatternLabel: 'Pattern (Glob)',
    modalPatternPlaceholder: 'e.g. *.docx, drafts/**, !temp/**',
    modalScopeLabel: 'Scope',
    modalScopeGlobal: 'All Folders (Global)',
    modalDescLabel: 'Description (Optional)',
    modalDescPlaceholder: 'e.g. Client deliverables',
    modalSaveBtn: 'Save Rule',
    modalCancelBtn: 'Cancel',
    sensitiveWarning:
      'Warning: This Allow rule targets a sensitive location (.ssh, .env, secrets, credentials, or private). Files inside may be admitted to local search.',
    sensitiveConfirmQuestion: 'Do you really want to allow indexing of this sensitive path?',
    emptyRules: 'No indexing rules match your filter criteria.',
    emptyAllRules: 'No indexing rules configured.',
    savedSuccess: 'Indexing rules saved.',
    saveFailed: 'Failed to save configuration.',
    paginationRows: 'Rows per page:',
    paginationPage: (cur: number, total: number, count: number) =>
      `Page ${cur} of ${Math.max(1, total)} (${count} rules)`,
  },
  vi: {
    title: 'Quy tắc chỉ mục',
    subtitle: 'Chọn tệp nào GenOffice được phát hiện và lập chỉ mục.',
    modeStandard: 'Chế độ Chuẩn',
    modeAllowlist: 'Chế độ Cho phép (Allowlist)',
    modeStandardDesc:
      'Tất cả tài liệu được hỗ trợ đều được lập chỉ mục trừ khi bị loại trừ bởi quy tắc.',
    modeAllowlistDesc:
      'Chỉ các tài liệu khớp với quy tắc Cho phép hoặc bộ mẫu được kích hoạt mới được lập chỉ mục.',
    allowCount: 'Quy tắc Cho phép',
    ignoreCount: 'Quy tắc Loại trừ',
    presetsCount: 'Bộ mẫu Kích hoạt',
    foldersCount: 'Thư mục Theo dõi',
    searchPlaceholder: 'Tìm theo mẫu, mô tả, phạm vi…',
    filterActionAll: 'Tất cả hành động',
    filterActionAllow: 'Chỉ Cho phép',
    filterActionIgnore: 'Chỉ Loại trừ',
    filterScopeAll: 'Tất cả phạm vi',
    filterScopeGlobal: 'Toàn cục (Global)',
    filterSourceAll: 'Tất cả nguồn',
    filterSourceUser: 'Quy tắc tùy chỉnh',
    filterSourceGenoffice: '.genofficeignore',
    filterSourcePreset: 'Bộ mẫu (Preset)',
    filterStateAll: 'Tất cả trạng thái',
    filterStateEnabled: 'Đang bật',
    filterStateDisabled: 'Đang tắt',
    addRuleBtn: 'Thêm quy tắc',
    openEditorBtn: 'Sửa .genofficeignore',
    colEnabled: 'Bật',
    colAction: 'Hành động',
    colPattern: 'Mẫu đường dẫn',
    colScope: 'Phạm vi',
    colSource: 'Nguồn',
    colDesc: 'Mô tả',
    colActions: 'Thao tác',
    badgeAllow: 'CHO PHÉP',
    badgeIgnore: 'LOẠI TRỪ',
    badgeCustom: 'Tùy chỉnh',
    badgeBuiltin: 'Mặc định',
    badgeGenoffice: '.genofficeignore',
    actionEdit: 'Sửa',
    actionDelete: 'Xóa',
    bulkSelected: (n: number) => `Đã chọn ${n} quy tắc`,
    bulkEnable: 'Bật',
    bulkDisable: 'Tắt',
    bulkDelete: 'Xóa đã chọn',
    bulkExport: 'Xuất JSON',
    bulkClear: 'Bỏ chọn',
    confirmDeleteRule: (pat: string) => `Xóa quy tắc "${pat}"? Thao tác này không thể hoàn tác.`,
    confirmBulkDelete: (n: number) => `Xóa ${n} quy tắc tùy chỉnh đã chọn?`,
    presetsSectionTitle: 'Bộ mẫu quy tắc chuẩn',
    presetsSectionSubtitle:
      'Các nhóm quy tắc phân phiên bản để bảo vệ môi trường phát triển, tệp khóa và tài liệu.',
    testerTitle: 'Kiểm tra & Giải thích chính sách',
    testerSubtitle:
      'Hiểu chính xác VÌ SAO một đường dẫn được cho phép hoặc loại trừ theo thứ bậc ưu tiên.',
    testInputPlaceholder: 'Nhập đường dẫn tuyệt đối (vd: C:\\Docs\\baocao.docx)',
    testRootDefault: 'Tự động nhận diện thư mục gốc',
    testCheckBtn: 'Kiểm tra',
    testTesting: 'Đang kiểm tra…',
    testDecisionAllowed: 'ĐƯỢC CHO PHÉP',
    testDecisionIgnored: 'BỊ LOẠI TRỪ',
    testLabelDecision: 'Quyết định chính sách',
    testLabelWinning: 'Quy tắc quyết định',
    testLabelOverridden: 'Quy tắc bị ghi đè',
    testLabelEligibility: 'Tính hợp lệ định dạng & an toàn',
    testLabelIndexStatus: 'Trạng thái chỉ mục',
    testLabelExplanation: 'Giải thích chi tiết',
    testCopyBtn: 'Sao chép kết quả',
    testCopied: 'Đã sao chép!',
    statusIndexed: 'Đã có trong tìm kiếm',
    statusNotIndexed: 'Chưa lập chỉ mục',
    statusPending: 'Đang chờ đọc',
    statusIgnored: 'Bị loại trừ bởi chính sách',
    editorTitle: 'Trình chỉnh sửa .genofficeignore',
    editorSubtitle: 'Quản lý các chỉ thị chính sách và loại trừ trực tiếp trong thư mục chỉ mục.',
    editorRootLabel: 'Thư mục gốc:',
    editorFileExists: 'Tệp đã tồn tại trên đĩa',
    editorFileMissing: 'Chưa tạo tệp',
    editorCreateFile: 'Tạo tệp .genofficeignore',
    editorSaveBtn: 'Lưu chính sách',
    editorSaving: 'Đang lưu…',
    editorDiscardBtn: 'Hủy bản nháp',
    editorReloadBtn: 'Tải lại từ đĩa',
    editorTemplateBtn: 'Mẫu khuyến nghị',
    editorSyntaxBtn: 'Hướng dẫn cú pháp',
    editorCloseBtn: 'Đóng',
    editorUnsavedBadge: 'Chưa lưu thay đổi',
    editorConflictAlert:
      'Tệp trên đĩa đã bị thay đổi bởi tiến trình khác. Vui lòng xem lại hoặc tải lại.',
    modalAddTitle: 'Thêm quy tắc chỉ mục',
    modalEditTitle: 'Sửa quy tắc chỉ mục',
    modalActionLabel: 'Hành động quy tắc',
    modalActionAllow: 'Cho phép (Thu nạp vào chỉ mục)',
    modalActionIgnore: 'Loại trừ (Bỏ qua khỏi chỉ mục)',
    modalPatternLabel: 'Mẫu đường dẫn (Glob)',
    modalPatternPlaceholder: 'vd: *.docx, drafts/**, !temp/**',
    modalScopeLabel: 'Phạm vi',
    modalScopeGlobal: 'Tất cả thư mục (Toàn cục)',
    modalDescLabel: 'Mô tả (Tùy chọn)',
    modalDescPlaceholder: 'vd: Tài liệu bàn giao',
    modalSaveBtn: 'Lưu quy tắc',
    modalCancelBtn: 'Hủy',
    sensitiveWarning:
      'Cảnh báo: Quy tắc Cho phép này nhắm tới thư mục nhạy cảm (.ssh, .env, secrets, credentials, private). Các tệp bên trong có thể xuất hiện trong tìm kiếm.',
    sensitiveConfirmQuestion: 'Bạn có chắc chắn muốn cho phép lập chỉ mục đường dẫn nhạy cảm này?',
    emptyRules: 'Không có quy tắc nào khớp với bộ lọc.',
    emptyAllRules: 'Chưa có quy tắc chỉ mục nào được thiết lập.',
    savedSuccess: 'Đã lưu quy tắc chỉ mục.',
    saveFailed: 'Lưu cấu hình thất bại.',
    paginationRows: 'Số dòng mỗi trang:',
    paginationPage: (cur: number, total: number, count: number) =>
      `Trang ${cur} / ${Math.max(1, total)} (${count} quy tắc)`,
  },
}

const RECOMMENDED_ALLOWLIST_TEMPLATE = `# GenOffice indexing policy
@mode allowlist

# Allow common documents
!**/*.pdf
!**/*.doc
!**/*.docx
!**/*.xls
!**/*.xlsx
!**/*.ppt
!**/*.pptx
!**/*.txt
!**/*.csv
!**/*.md
!**/*.markdown
`

function isSensitivePattern(pattern: string): boolean {
  return /(\.ssh|\.aws|\.gnupg|\.env|secrets|credentials|private)/i.test(pattern)
}

export function IndexingRulesStudio({ api }: { api: HomeApi }) {
  const { lang } = useI18n()
  const d = lang === 'vi' ? I18N.vi : I18N.en

  // Core Policy State
  const [mode, setMode] = useState<IndexPolicyMode>('standard')
  const [rules, setRules] = useState<IgnoreRule[]>([])
  const [presets, setPresets] = useState<IndexingPreset[]>([])
  const [folders, setFolders] = useState<string[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState('')
  const [actionFilter, setActionFilter] = useState<'all' | 'allow' | 'ignore'>('all')
  const [scopeFilter, setScopeFilter] = useState('all')
  const [sourceFilter, setSourceFilter] = useState<'all' | 'user' | '.genofficeignore' | 'preset'>(
    'all',
  )
  const [stateFilter, setStateFilter] = useState<'all' | 'enabled' | 'disabled'>('all')

  // Pagination
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  // Status message
  const [note, setNote] = useState('')
  const [noteError, setNoteError] = useState(false)

  // Presets Collapsible
  const [presetsExpanded, setPresetsExpanded] = useState(false)

  // Add/Edit Modal
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<IgnoreRule | null>(null)
  const [formAction, setFormAction] = useState<IndexRuleAction>('ignore')
  const [formPattern, setFormPattern] = useState('')
  const [formScope, setFormScope] = useState('global')
  const [formDesc, setFormDesc] = useState('')

  // Sensitive Warning Confirmation
  const [sensitivePendingRule, setSensitivePendingRule] = useState<IgnoreRule | null>(null)

  // Path Tester
  const [testPath, setTestPath] = useState('')
  const [testRoot, setTestRoot] = useState('')
  const [testLoading, setTestLoading] = useState(false)
  const [testResult, setTestResult] = useState<IgnoreTestResult | null>(null)
  const [copiedTest, setCopiedTest] = useState(false)

  // .genofficeignore Editor Drawer
  const [isEditorOpen, setIsEditorOpen] = useState(false)
  const [editorRoot, setEditorRoot] = useState('')
  const [editorContent, setEditorContent] = useState('')
  const [editorOriginalContent, setEditorOriginalContent] = useState('')
  const [editorRevision, setEditorRevision] = useState('')
  const [editorExists, setEditorExists] = useState(false)
  const [editorErrors, setEditorErrors] = useState<string[]>([])
  const [editorSaving, setEditorSaving] = useState(false)
  const [editorConflict, setEditorConflict] = useState(false)
  const [isSyntaxGuideOpen, setIsSyntaxGuideOpen] = useState(false)

  // Load Data
  const loadData = useCallback(async () => {
    try {
      if (api.getIgnorePolicyConfig) {
        const config = await api.getIgnorePolicyConfig()
        if (config) {
          setMode(config.mode || 'standard')
          setRules(config.rules || [])
        }
      } else if (api.getIgnoreRules) {
        const active = await api.getIgnoreRules()
        setRules(active || [])
      }

      if (api.getPolicyPresets) {
        const p = await api.getPolicyPresets()
        setPresets(p || [])
      }

      if (api.listIndexedFolders) {
        const indexed = await api.listIndexedFolders()
        const roots = (indexed || []).map((f: IndexedFolder) => f.root)
        setFolders(roots)
        if (roots.length > 0 && !editorRoot) {
          setEditorRoot(roots[0]!)
        }
      }
    } catch {
      // Safe fallback
    }
  }, [api, editorRoot])

  useEffect(() => {
    void loadData()
  }, [loadData])

  // Save rules helper
  const savePolicyRules = async (nextRules: IgnoreRule[]) => {
    try {
      if (api.saveIgnorePolicyConfig) {
        const res = await api.saveIgnorePolicyConfig({ mode, rules: nextRules })
        if (res?.ok) {
          setRules(nextRules)
          setNote(d.savedSuccess)
          setNoteError(false)
          setTimeout(() => setNote(''), 3000)
        } else {
          setNote(d.saveFailed)
          setNoteError(true)
        }
      } else if (api.saveIgnoreRules) {
        const res = await api.saveIgnoreRules(nextRules)
        if (res?.ok) {
          setRules(nextRules)
          setNote(d.savedSuccess)
          setNoteError(false)
          setTimeout(() => setNote(''), 3000)
        } else {
          setNote(d.saveFailed)
          setNoteError(true)
        }
      }
    } catch {
      setNote(d.saveFailed)
      setNoteError(true)
    }
  }

  // Toggle Policy Mode
  const handleModeChange = async (newMode: IndexPolicyMode) => {
    if (newMode === mode) return
    setMode(newMode)
    try {
      if (api.saveIgnorePolicyConfig) {
        await api.saveIgnorePolicyConfig({ mode: newMode, rules })
        setNote(d.savedSuccess)
        setNoteError(false)
        setTimeout(() => setNote(''), 3000)
      }
    } catch {
      setNote(d.saveFailed)
      setNoteError(true)
    }
  }

  // Toggle Single Rule
  const handleToggleRule = (id: string) => {
    const target = rules.find((r) => r.id === id)
    if (!target || target.source === '.genofficeignore') return
    const next = rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))
    void savePolicyRules(next)
  }

  // Delete Single Rule
  const handleDeleteRule = async (rule: IgnoreRule) => {
    if (rule.source === '.genofficeignore') return
    const confirmed = await appConfirm(d.confirmDeleteRule(rule.pattern), {
      title: d.actionDelete,
      confirmLabel: d.actionDelete,
      tone: 'danger',
    })
    if (!confirmed) return
    const next = rules.filter((r) => r.id !== rule.id)
    setSelectedIds((prev) => {
      const copy = new Set(prev)
      copy.delete(rule.id)
      return copy
    })
    void savePolicyRules(next)
  }

  // Start Add Rule
  const openAddModal = () => {
    setEditingRule(null)
    setFormAction('ignore')
    setFormPattern('')
    setFormScope('global')
    setFormDesc('')
    setIsModalOpen(true)
  }

  // Start Edit Rule
  const openEditModal = (rule: IgnoreRule) => {
    if (rule.source === '.genofficeignore') return
    setEditingRule(rule)
    setFormAction(rule.action ?? 'ignore')
    setFormPattern(rule.pattern)
    setFormScope(rule.scope)
    setFormDesc(rule.description || '')
    setIsModalOpen(true)
  }

  // Submit Rule Form (with sensitive warning check)
  const handleModalSubmit = (e: FormEvent) => {
    e.preventDefault()
    const pat = formPattern.trim()
    if (!pat) return

    const candidateRule: IgnoreRule = {
      id: editingRule ? editingRule.id : `rule-${Date.now()}`,
      pattern: pat,
      enabled: editingRule ? editingRule.enabled : true,
      scope: formScope,
      description: formDesc.trim() || undefined,
      action: formAction,
      source: editingRule?.source ?? 'user',
    }

    // Check sensitive location warning for Allow rules
    if (candidateRule.action === 'allow' && isSensitivePattern(candidateRule.pattern)) {
      setSensitivePendingRule(candidateRule)
      return
    }

    applyCandidateRule(candidateRule)
  }

  const applyCandidateRule = (rule: IgnoreRule) => {
    let next: IgnoreRule[]
    if (editingRule) {
      next = rules.map((r) => (r.id === rule.id ? rule : r))
    } else {
      next = [rule, ...rules]
    }
    setIsModalOpen(false)
    setEditingRule(null)
    setSensitivePendingRule(null)
    void savePolicyRules(next)
  }

  // Toggle Preset
  const handleTogglePreset = async (presetId: string, enabled: boolean) => {
    const nextPresets = presets.map((p) => (p.id === presetId ? { ...p, enabled } : p))
    setPresets(nextPresets)
    try {
      const presetsMap: Record<string, boolean> = {}
      for (const p of nextPresets) {
        presetsMap[p.id] = p.enabled ?? true
      }
      if (api.saveIgnorePolicyConfig) {
        await api.saveIgnorePolicyConfig({ mode, rules, presets: presetsMap })
      }
    } catch {
      // Safe fallback
    }
  }

  // Selection & Bulk Operations
  const handleToggleSelectAll = (filteredRules: IgnoreRule[]) => {
    if (selectedIds.size === filteredRules.length && filteredRules.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredRules.map((r) => r.id)))
    }
  }

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleBulkEnable = (enabled: boolean) => {
    const next = rules.map((r) => {
      if (selectedIds.has(r.id) && r.source !== '.genofficeignore') {
        return { ...r, enabled }
      }
      return r
    })
    void savePolicyRules(next)
  }

  const handleBulkDelete = async () => {
    const customSelected = rules.filter(
      (r) => selectedIds.has(r.id) && r.source !== '.genofficeignore',
    )
    if (customSelected.length === 0) return
    const confirmed = await appConfirm(d.confirmBulkDelete(customSelected.length), {
      title: d.bulkDelete,
      confirmLabel: d.bulkDelete,
      tone: 'danger',
    })
    if (!confirmed) return
    const customIds = new Set(customSelected.map((r) => r.id))
    const next = rules.filter((r) => !customIds.has(r.id))
    setSelectedIds(new Set())
    void savePolicyRules(next)
  }

  const handleBulkExport = () => {
    const selectedRules = rules.filter((r) => selectedIds.has(r.id))
    const jsonStr = JSON.stringify(selectedRules, null, 2)
    void navigator.clipboard.writeText(jsonStr)
    setNote('Selected rules exported to clipboard as JSON.')
    setTimeout(() => setNote(''), 3000)
  }

  // Filtered Rules Computation
  const filteredRules = useMemo(() => {
    return rules.filter((r) => {
      if (actionFilter === 'allow' && r.action !== 'allow') return false
      if (actionFilter === 'ignore' && r.action === 'allow') return false

      if (scopeFilter === 'global' && r.scope !== 'global') return false
      if (scopeFilter !== 'all' && scopeFilter !== 'global' && r.scope !== scopeFilter) return false

      if (sourceFilter === 'user' && r.source === '.genofficeignore') return false
      if (sourceFilter === '.genofficeignore' && r.source !== '.genofficeignore') return false
      if (sourceFilter === 'preset' && r.source !== 'preset') return false

      if (stateFilter === 'enabled' && !r.enabled) return false
      if (stateFilter === 'disabled' && r.enabled) return false

      if (searchQuery) {
        const q = searchQuery.toLowerCase()
        const pat = r.pattern.toLowerCase()
        const desc = (r.description || '').toLowerCase()
        const sc = r.scope.toLowerCase()
        if (!pat.includes(q) && !desc.includes(q) && !sc.includes(q)) return false
      }
      return true
    })
  }, [rules, actionFilter, scopeFilter, sourceFilter, stateFilter, searchQuery])

  // Pagination Computation
  const totalPages = Math.ceil(filteredRules.length / pageSize)
  const paginatedRules = useMemo(() => {
    const start = (page - 1) * pageSize
    return filteredRules.slice(start, start + pageSize)
  }, [filteredRules, page, pageSize])

  // Rule Counts
  const allowCount = useMemo(() => rules.filter((r) => r.action === 'allow').length, [rules])
  const ignoreCount = useMemo(() => rules.filter((r) => r.action !== 'allow').length, [rules])
  const activePresetsCount = useMemo(
    () => presets.filter((p) => p.enabled !== false).length,
    [presets],
  )

  // Policy Tester
  const handleTestPath = async (e: FormEvent) => {
    e.preventDefault()
    const p = testPath.trim()
    if (!p) return
    setTestLoading(true)
    setCopiedTest(false)
    try {
      if (api.testIgnorePath) {
        const res = await api.testIgnorePath(p, testRoot || undefined)
        let status: string | undefined = res.ignored ? 'ignored' : 'not-indexed'
        if (!res.ignored && api.searchIndexedFiles) {
          const basename = p.replace(/\\/g, '/').split('/').pop() || p
          const hits = await api.searchIndexedFiles(basename).catch(() => [])
          const normP = p.replace(/\\/g, '/').toLowerCase()
          const matched = hits.some((h) => h.path.replace(/\\/g, '/').toLowerCase() === normP)
          if (matched) status = 'indexed'
        }
        setTestResult({
          ...res,
          reason: res.reason,
          explanation: res.explanation || res.reason,
          eligibility: res.eligibility || 'supported',
          hardGateReason: status,
        })
      }
    } catch {
      setTestResult({
        ignored: false,
        reason: 'Error testing path',
        explanation: 'Failed to contact policy engine IPC.',
      })
    } finally {
      setTestLoading(false)
    }
  }

  const handleCopyTestResult = () => {
    if (!testResult) return
    const text = [
      `Path: ${testPath}`,
      `Selected root: ${testRoot || 'Auto-detect'}`,
      `Policy mode: ${testResult.mode || mode}`,
      `Eligibility: ${testResult.eligibility || 'supported'}`,
      `Final policy decision: ${testResult.ignored ? 'IGNORED' : 'ALLOWED'}`,
      `Winning rule: ${testResult.winningRule?.pattern || testResult.pattern || 'Mode fallback'}`,
      `Origin: ${testResult.source || testResult.winningRule?.source || 'Default'}`,
      testResult.overriddenRule ? `Conflicting rule: ${testResult.overriddenRule.pattern}` : '',
      `Explanation: ${testResult.explanation || testResult.reason}`,
    ]
      .filter(Boolean)
      .join('\n')
    void navigator.clipboard.writeText(text)
    setCopiedTest(true)
    setTimeout(() => setCopiedTest(false), 2000)
  }

  // .genofficeignore Editor
  const openEditorForRoot = async (rootPath: string) => {
    setEditorRoot(rootPath)
    setIsEditorOpen(true)
    setEditorConflict(false)
    setEditorErrors([])
    try {
      if (api.getGenOfficeIgnoreFile) {
        const res = (await api.getGenOfficeIgnoreFile(rootPath)) as GenOfficeIgnoreFileResult
        setEditorExists(res?.exists ?? false)
        setEditorContent(res?.content ?? '')
        setEditorOriginalContent(res?.content ?? '')
        setEditorRevision(res?.revision ?? '')
      }
    } catch {
      // Safe fallback
    }
  }

  const handleEditorRootChange = (newRoot: string) => {
    if (editorContent !== editorOriginalContent) {
      if (!window.confirm('You have unsaved changes in the editor. Switch root anyway?')) return
    }
    void openEditorForRoot(newRoot)
  }

  const handleSaveEditor = async () => {
    if (!editorRoot) return
    setEditorSaving(true)
    setEditorErrors([])
    setEditorConflict(false)
    try {
      if (api.saveGenOfficeIgnoreFile) {
        const res = await api.saveGenOfficeIgnoreFile(editorRoot, editorContent, editorRevision)
        if (res?.ok) {
          setEditorOriginalContent(editorContent)
          setEditorRevision(res.revision || '')
          setEditorExists(true)
          setNote('Saved .genofficeignore successfully.')
          setTimeout(() => setNote(''), 3000)
          void loadData()
        } else if (res?.error === 'conflict') {
          setEditorConflict(true)
        } else {
          setEditorErrors(res?.validationErrors || [res?.error || 'Failed to save'])
        }
      }
    } catch (err) {
      setEditorErrors([err instanceof Error ? err.message : 'Save failed'])
    } finally {
      setEditorSaving(false)
    }
  }

  return (
    <div className="ixs-studio">
      {/* A. Header Section */}
      <header className="ixs-studio-head">
        <div className="ixs-studio-title-group">
          <h3 className="ixs-studio-title">{d.title}</h3>
          <p className="ixs-studio-sub">{d.subtitle}</p>
        </div>
        <div className="ixs-studio-metrics">
          <span className="ixs-metric-pill ixs-pill-allow" title={d.allowCount}>
            <strong>{allowCount}</strong> {d.allowCount}
          </span>
          <span className="ixs-metric-pill ixs-pill-ignore" title={d.ignoreCount}>
            <strong>{ignoreCount}</strong> {d.ignoreCount}
          </span>
          <span className="ixs-metric-pill ixs-pill-preset" title={d.presetsCount}>
            <strong>{activePresetsCount}</strong> {d.presetsCount}
          </span>
          <span className="ixs-metric-pill ixs-pill-folder" title={d.foldersCount}>
            <strong>{folders.length}</strong> {d.foldersCount}
          </span>
        </div>
      </header>

      {/* B. Mode Selector */}
      <section className="ixs-mode-card" aria-label="Policy Mode Selector">
        <div className="ixs-mode-buttons">
          <button
            type="button"
            className={`ixs-mode-btn ${mode === 'standard' ? 'active' : ''}`}
            onClick={() => void handleModeChange('standard')}
          >
            <span className="ixs-mode-icon">✦</span>
            <span>{d.modeStandard}</span>
          </button>
          <button
            type="button"
            className={`ixs-mode-btn ${mode === 'allowlist' ? 'active' : ''}`}
            onClick={() => void handleModeChange('allowlist')}
          >
            <span className="ixs-mode-icon">🛡</span>
            <span>{d.modeAllowlist}</span>
          </button>
        </div>
        <p className="ixs-mode-desc">
          {mode === 'standard' ? d.modeStandardDesc : d.modeAllowlistDesc}
        </p>
      </section>

      {/* E. Grouped Presets Section */}
      <section className="ixs-presets-card">
        <button
          type="button"
          className="ixs-presets-toggle"
          onClick={() => setPresetsExpanded(!presetsExpanded)}
          aria-expanded={presetsExpanded}
        >
          <div className="ixs-presets-toggle-text">
            <strong>{d.presetsSectionTitle}</strong>
            <span className="idx-muted">{d.presetsSectionSubtitle}</span>
          </div>
          <span className="ixs-chevron">{presetsExpanded ? '▲' : '▼'}</span>
        </button>

        {presetsExpanded && (
          <div className="ixs-presets-grid">
            {presets.map((preset) => (
              <div key={preset.id} className="ixs-preset-item">
                <div className="ixs-preset-info">
                  <div className="ixs-preset-head">
                    <span
                      className={`ixs-badge ${preset.action === 'allow' ? 'ixs-badge-allow' : 'ixs-badge-ignore'}`}
                    >
                      {preset.action === 'allow' ? d.badgeAllow : d.badgeIgnore}
                    </span>
                    <strong className="ixs-preset-name">{preset.name}</strong>
                  </div>
                  <p className="ixs-preset-desc">{preset.description}</p>
                  <div className="ixs-preset-patterns">
                    {preset.patterns.slice(0, 6).map((pat) => (
                      <code key={pat} className="ixs-pat-pill">
                        {pat}
                      </code>
                    ))}
                    {preset.patterns.length > 6 && (
                      <span className="ixs-pat-more">+{preset.patterns.length - 6} more</span>
                    )}
                  </div>
                </div>
                <label className="ixs-switch" title={`Toggle ${preset.name}`}>
                  <input
                    type="checkbox"
                    checked={preset.enabled !== false}
                    onChange={(e) => void handleTogglePreset(preset.id, e.target.checked)}
                  />
                  <span className="ixs-slider" />
                </label>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* C. Rule Toolbar */}
      <div className="ixs-studio-toolbar">
        <div className="ixs-search-box">
          <input
            type="search"
            className="idx-input ixs-search-input"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value)
              setPage(1)
            }}
            placeholder={d.searchPlaceholder}
          />
        </div>

        <div className="ixs-filters-row">
          <select
            className="idx-input ixs-select"
            value={actionFilter}
            onChange={(e) => {
              setActionFilter(e.target.value as 'all' | 'allow' | 'ignore')
              setPage(1)
            }}
          >
            <option value="all">{d.filterActionAll}</option>
            <option value="allow">{d.filterActionAllow}</option>
            <option value="ignore">{d.filterActionIgnore}</option>
          </select>

          <select
            className="idx-input ixs-select"
            value={scopeFilter}
            onChange={(e) => {
              setScopeFilter(e.target.value)
              setPage(1)
            }}
          >
            <option value="all">{d.filterScopeAll}</option>
            <option value="global">{d.filterScopeGlobal}</option>
            {folders.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>

          <select
            className="idx-input ixs-select"
            value={sourceFilter}
            onChange={(e) => {
              setSourceFilter(e.target.value as 'all' | 'user' | '.genofficeignore' | 'preset')
              setPage(1)
            }}
          >
            <option value="all">{d.filterSourceAll}</option>
            <option value="user">{d.filterSourceUser}</option>
            <option value=".genofficeignore">{d.filterSourceGenoffice}</option>
            <option value="preset">{d.filterSourcePreset}</option>
          </select>

          <select
            className="idx-input ixs-select"
            value={stateFilter}
            onChange={(e) => {
              setStateFilter(e.target.value as 'all' | 'enabled' | 'disabled')
              setPage(1)
            }}
          >
            <option value="all">{d.filterStateAll}</option>
            <option value="enabled">{d.filterStateEnabled}</option>
            <option value="disabled">{d.filterStateDisabled}</option>
          </select>
        </div>

        <div className="ixs-toolbar-actions">
          <button type="button" className="idx-btn idx-btn-primary" onClick={openAddModal}>
            + {d.addRuleBtn}
          </button>
          <button
            type="button"
            className="idx-btn ixs-btn-open-editor"
            onClick={() => void openEditorForRoot(folders[0] || testRoot || '')}
          >
            📄 {d.openEditorBtn}
          </button>
        </div>
      </div>

      {/* Bulk Actions Bar */}
      {selectedIds.size > 0 && (
        <div className="ixs-bulk-bar">
          <span className="ixs-bulk-count">{d.bulkSelected(selectedIds.size)}</span>
          <div className="ixs-bulk-actions">
            <button
              type="button"
              className="idx-btn idx-btn-sm"
              onClick={() => handleBulkEnable(true)}
            >
              {d.bulkEnable}
            </button>
            <button
              type="button"
              className="idx-btn idx-btn-sm"
              onClick={() => handleBulkEnable(false)}
            >
              {d.bulkDisable}
            </button>
            <button
              type="button"
              className="idx-btn idx-btn-sm idx-btn-danger"
              onClick={() => void handleBulkDelete()}
            >
              {d.bulkDelete}
            </button>
            <button type="button" className="idx-btn idx-btn-sm" onClick={handleBulkExport}>
              {d.bulkExport}
            </button>
            <button
              type="button"
              className="idx-btn idx-btn-sm"
              onClick={() => setSelectedIds(new Set())}
            >
              {d.bulkClear}
            </button>
          </div>
        </div>
      )}

      {/* D. Dense Rules Table */}
      <div className="ixs-table-wrapper">
        <table className="ixs-dense-table" aria-label="Indexing Rules Table">
          <thead>
            <tr>
              <th className="ixs-th-check">
                <input
                  type="checkbox"
                  checked={
                    paginatedRules.length > 0 && paginatedRules.every((r) => selectedIds.has(r.id))
                  }
                  onChange={() => handleToggleSelectAll(paginatedRules)}
                  aria-label="Select all rules on this page"
                />
              </th>
              <th className="ixs-th-enabled">{d.colEnabled}</th>
              <th className="ixs-th-action">{d.colAction}</th>
              <th className="ixs-th-pattern">{d.colPattern}</th>
              <th className="ixs-th-scope">{d.colScope}</th>
              <th className="ixs-th-source">{d.colSource}</th>
              <th className="ixs-th-desc">{d.colDesc}</th>
              <th className="ixs-th-ops">{d.colActions}</th>
            </tr>
          </thead>
          <tbody>
            {paginatedRules.length === 0 ? (
              <tr>
                <td colSpan={8} className="ixs-empty-row">
                  <p className="idx-muted">{rules.length === 0 ? d.emptyAllRules : d.emptyRules}</p>
                </td>
              </tr>
            ) : (
              paginatedRules.map((rule) => {
                const isAllow = rule.action === 'allow'
                const isFromGenoffice = rule.source === '.genofficeignore'
                const isPreset = rule.source === 'preset'
                const isSelected = selectedIds.has(rule.id)

                return (
                  <tr
                    key={rule.id}
                    className={`ixs-row ${!rule.enabled ? 'disabled' : ''} ${isSelected ? 'selected' : ''}`}
                  >
                    <td className="ixs-td-check">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleToggleSelect(rule.id)}
                        aria-label={`Select rule ${rule.pattern}`}
                      />
                    </td>
                    <td className="ixs-td-enabled">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        disabled={isFromGenoffice}
                        onChange={() => handleToggleRule(rule.id)}
                        aria-label={`Toggle rule ${rule.pattern}`}
                      />
                    </td>
                    <td className="ixs-td-action">
                      <span
                        className={`ixs-badge ${isAllow ? 'ixs-badge-allow' : 'ixs-badge-ignore'}`}
                      >
                        {isAllow ? d.badgeAllow : d.badgeIgnore}
                      </span>
                    </td>
                    <td className="ixs-td-pattern">
                      <code className="ixs-pattern-code" title={rule.pattern}>
                        {rule.pattern}
                      </code>
                    </td>
                    <td className="ixs-td-scope">
                      <span className="ixs-scope-badge" title={rule.scope}>
                        {rule.scope === 'global'
                          ? d.filterScopeGlobal
                          : rule.scope.split(/[/\\]/).pop()}
                      </span>
                    </td>
                    <td className="ixs-td-source">
                      <span
                        className={`ixs-source-badge ${
                          isFromGenoffice
                            ? 'ixs-src-genoffice'
                            : isPreset
                              ? 'ixs-src-preset'
                              : 'ixs-src-custom'
                        }`}
                      >
                        {isFromGenoffice
                          ? d.badgeGenoffice
                          : isPreset
                            ? d.badgeBuiltin
                            : d.badgeCustom}
                      </span>
                    </td>
                    <td className="ixs-td-desc">
                      <span className="ixs-desc-text" title={rule.description || ''}>
                        {rule.description || '—'}
                      </span>
                    </td>
                    <td className="ixs-td-ops">
                      {!isFromGenoffice && !isPreset && (
                        <div className="ixs-row-actions">
                          <button
                            type="button"
                            className="idx-btn idx-btn-xs"
                            onClick={() => openEditModal(rule)}
                            title={d.actionEdit}
                          >
                            ✏️
                          </button>
                          <button
                            type="button"
                            className="idx-btn idx-btn-xs idx-btn-danger"
                            onClick={() => void handleDeleteRule(rule)}
                            title={d.actionDelete}
                          >
                            🗑
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      {filteredRules.length > 0 && (
        <div className="ixs-pagination">
          <div className="ixs-page-size">
            <span className="idx-muted">{d.paginationRows}</span>
            <select
              className="idx-input ixs-select-sm"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value))
                setPage(1)
              }}
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </div>

          <div className="ixs-page-nav">
            <span className="idx-muted">
              {d.paginationPage(page, totalPages, filteredRules.length)}
            </span>
            <button
              type="button"
              className="idx-btn idx-btn-sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              ◀
            </button>
            <button
              type="button"
              className="idx-btn idx-btn-sm"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              ▶
            </button>
          </div>
        </div>
      )}

      {/* F. Path Tester & Explainer Tool */}
      <section className="ixs-tester-card" aria-label="Policy Tester">
        <header className="ixs-tester-head">
          <span className="ixs-tool-icon">🔍</span>
          <div>
            <h4 className="ixs-tester-title">{d.testerTitle}</h4>
            <p className="ixs-tester-sub">{d.testerSubtitle}</p>
          </div>
        </header>

        <form className="ixs-tester-form" onSubmit={handleTestPath}>
          <input
            type="text"
            className="idx-input ixs-tester-input"
            value={testPath}
            onChange={(e) => setTestPath(e.target.value)}
            placeholder={d.testInputPlaceholder}
            required
          />
          {folders.length > 1 && (
            <select
              className="idx-input ixs-tester-root-select"
              value={testRoot}
              onChange={(e) => setTestRoot(e.target.value)}
            >
              <option value="">{d.testRootDefault}</option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          )}
          <button
            type="submit"
            className="idx-btn idx-btn-primary ixs-tester-btn"
            disabled={testLoading}
          >
            {testLoading ? d.testTesting : d.testCheckBtn}
          </button>
        </form>

        {testResult && (
          <div
            className={`ixs-test-result-box ixs-tester-result ${testResult.ignored ? 'decision-ignored' : 'decision-allowed'}`}
          >
            <div className="ixs-test-top">
              <div className="ixs-test-decision-badge">
                <strong>
                  {testResult.ignored ? d.testDecisionIgnored : d.testDecisionAllowed}
                </strong>
                <span className="ixs-test-mode-tag">
                  {testResult.mode === 'allowlist' ? d.modeAllowlist : d.modeStandard}
                </span>
              </div>
              <button type="button" className="idx-btn idx-btn-sm" onClick={handleCopyTestResult}>
                {copiedTest ? d.testCopied : d.testCopyBtn}
              </button>
            </div>

            <div className="ixs-test-grid">
              <div className="ixs-test-prop">
                <span className="ixs-prop-label">{d.testLabelWinning}:</span>
                <span className="ixs-prop-val">
                  <code>
                    {testResult.winningRule?.pattern ||
                      testResult.pattern ||
                      'Mode fallback default'}
                  </code>
                  <span className="idx-muted">
                    {' '}
                    ({testResult.source || testResult.winningRule?.source || 'system'})
                  </span>
                </span>
              </div>

              {testResult.overriddenRule && (
                <div className="ixs-test-prop ixs-prop-overridden">
                  <span className="ixs-prop-label">{d.testLabelOverridden}:</span>
                  <span className="ixs-prop-val">
                    <code>{testResult.overriddenRule.pattern}</code>
                    <span className="idx-muted"> (Overridden by explicit Allow)</span>
                  </span>
                </div>
              )}

              <div className="ixs-test-prop">
                <span className="ixs-prop-label">{d.testLabelEligibility}:</span>
                <span className="ixs-prop-val">
                  {testResult.eligibility === 'outside-root'
                    ? 'Outside indexed roots'
                    : testResult.eligibility === 'unsupported'
                      ? 'Unsupported format (Admit safeguards apply)'
                      : 'Supported document format'}
                </span>
              </div>
            </div>

            <div className="ixs-test-explanation">
              <strong>{d.testLabelExplanation}:</strong>
              <p>{testResult.explanation || testResult.reason}</p>
            </div>
          </div>
        )}
      </section>

      {/* G. Embedded .genofficeignore Editor Modal / Drawer */}
      {isEditorOpen && (
        <div className="ixs-modal-backdrop" onClick={() => setIsEditorOpen(false)}>
          <div
            className="ixs-editor-drawer"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <header className="ixs-drawer-head">
              <div className="ixs-drawer-title-group">
                <h3>{d.editorTitle}</h3>
                <p>{d.editorSubtitle}</p>
              </div>
              <div className="ixs-drawer-head-actions">
                {editorContent !== editorOriginalContent && (
                  <span className="ixs-dirty-badge">{d.editorUnsavedBadge}</span>
                )}
                <button
                  type="button"
                  className="idx-btn idx-btn-sm ixs-btn-close-drawer"
                  onClick={() => setIsEditorOpen(false)}
                >
                  ✕ {d.editorCloseBtn}
                </button>
              </div>
            </header>

            <div className="ixs-drawer-controls">
              <label className="ixs-root-selector">
                <span>{d.editorRootLabel}</span>
                <select
                  className="idx-input ixs-select"
                  value={editorRoot}
                  onChange={(e) => handleEditorRootChange(e.target.value)}
                >
                  {folders.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>

              <div className="ixs-drawer-file-status">
                <span
                  className={`ixs-status-dot ${editorExists ? 'dot-active' : 'dot-inactive'}`}
                />
                <span className="idx-muted">
                  {editorExists ? d.editorFileExists : d.editorFileMissing}
                </span>
              </div>

              <div className="ixs-drawer-quick-actions">
                <button
                  type="button"
                  className="idx-btn idx-btn-sm"
                  onClick={() => setEditorContent(RECOMMENDED_ALLOWLIST_TEMPLATE)}
                >
                  📋 {d.editorTemplateBtn}
                </button>
                <button
                  type="button"
                  className="idx-btn idx-btn-sm"
                  onClick={() => setIsSyntaxGuideOpen(!isSyntaxGuideOpen)}
                >
                  ℹ️ {d.editorSyntaxBtn}
                </button>
              </div>
            </div>

            {editorConflict && (
              <div className="ixs-alert ixs-alert-warning" role="alert">
                <strong>{d.editorConflictAlert}</strong>
                <button
                  type="button"
                  className="idx-btn idx-btn-sm"
                  onClick={() => void openEditorForRoot(editorRoot)}
                >
                  {d.editorReloadBtn}
                </button>
              </div>
            )}

            {editorErrors.length > 0 && (
              <div className="ixs-alert ixs-alert-danger" role="alert">
                {editorErrors.map((err, i) => (
                  <p key={i}>{err}</p>
                ))}
              </div>
            )}

            {isSyntaxGuideOpen && (
              <div className="ixs-syntax-guide">
                <h5>GenOffice Policy Directives & Syntax:</h5>
                <ul>
                  <li>
                    <code>@mode standard</code>: Default indexing mode for this root.
                  </li>
                  <li>
                    <code>@mode allowlist</code>: Restrict to explicit Allow rules only.
                  </li>
                  <li>
                    <code>!pattern</code>: Explicit Allow (takes priority over Ignore).
                  </li>
                  <li>
                    <code>pattern</code>: Explicit Ignore (excludes matching paths).
                  </li>
                  <li>
                    <code># comments</code>: Ignored by evaluator.
                  </li>
                </ul>
              </div>
            )}

            <div className="ixs-editor-area">
              <textarea
                className="ixs-editor-textarea"
                value={editorContent}
                onChange={(e) => setEditorContent(e.target.value)}
                placeholder={RECOMMENDED_ALLOWLIST_TEMPLATE}
                rows={16}
                spellCheck={false}
              />
            </div>

            <footer className="ixs-drawer-footer">
              <div className="ixs-drawer-footer-left">
                <button
                  type="button"
                  className="idx-btn idx-btn-sm"
                  disabled={editorContent === editorOriginalContent}
                  onClick={() => setEditorContent(editorOriginalContent)}
                >
                  {d.editorDiscardBtn}
                </button>
                <button
                  type="button"
                  className="idx-btn idx-btn-sm"
                  onClick={() => void openEditorForRoot(editorRoot)}
                >
                  {d.editorReloadBtn}
                </button>
              </div>

              <div className="ixs-drawer-footer-right">
                <button
                  type="button"
                  className="idx-btn idx-btn-primary ixs-btn-save-drawer"
                  disabled={editorSaving || editorContent === editorOriginalContent}
                  onClick={() => void handleSaveEditor()}
                >
                  {editorSaving ? d.editorSaving : d.editorSaveBtn}
                </button>
              </div>
            </footer>
          </div>
        </div>
      )}

      {/* Add / Edit Rule Modal */}
      {isModalOpen && (
        <div className="ixs-modal-backdrop" onClick={() => setIsModalOpen(false)}>
          <div
            className="ixs-modal-box"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <header className="ixs-modal-head">
              <h4>{editingRule ? d.modalEditTitle : d.modalAddTitle}</h4>
              <button
                type="button"
                className="idx-btn idx-btn-sm"
                onClick={() => setIsModalOpen(false)}
              >
                ✕
              </button>
            </header>

            <form onSubmit={handleModalSubmit} className="ixs-modal-form">
              <label className="ixs-form-field">
                <span>{d.modalActionLabel}:</span>
                <select
                  className="idx-input"
                  value={formAction}
                  onChange={(e) => setFormAction(e.target.value as IndexRuleAction)}
                >
                  <option value="ignore">{d.modalActionIgnore}</option>
                  <option value="allow">{d.modalActionAllow}</option>
                </select>
              </label>

              <label className="ixs-form-field">
                <span>{d.modalPatternLabel}:</span>
                <input
                  type="text"
                  className="idx-input"
                  value={formPattern}
                  onChange={(e) => setFormPattern(e.target.value)}
                  placeholder={d.modalPatternPlaceholder}
                  required
                />
              </label>

              <label className="ixs-form-field">
                <span>{d.modalScopeLabel}:</span>
                <select
                  className="idx-input"
                  value={formScope}
                  onChange={(e) => setFormScope(e.target.value)}
                >
                  <option value="global">{d.modalScopeGlobal}</option>
                  {folders.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>

              <label className="ixs-form-field">
                <span>{d.modalDescLabel}:</span>
                <input
                  type="text"
                  className="idx-input"
                  value={formDesc}
                  onChange={(e) => setFormDesc(e.target.value)}
                  placeholder={d.modalDescPlaceholder}
                />
              </label>

              {formAction === 'allow' && isSensitivePattern(formPattern) && (
                <div className="ixs-alert ixs-alert-warning" role="alert">
                  <p>{d.sensitiveWarning}</p>
                </div>
              )}

              <footer className="ixs-modal-footer">
                <button type="button" className="idx-btn" onClick={() => setIsModalOpen(false)}>
                  {d.modalCancelBtn}
                </button>
                <button type="submit" className="idx-btn idx-btn-primary">
                  {d.modalSaveBtn}
                </button>
              </footer>
            </form>
          </div>
        </div>
      )}

      {/* Sensitive Confirmation Dialog */}
      {sensitivePendingRule && (
        <div className="ixs-modal-backdrop">
          <div className="ixs-modal-box ixs-modal-warning" role="dialog" aria-modal="true">
            <header className="ixs-modal-head">
              <h4>⚠️ {d.sensitiveConfirmQuestion}</h4>
            </header>
            <div className="ixs-modal-body">
              <p>{d.sensitiveWarning}</p>
              <code className="ixs-pattern-code">{sensitivePendingRule.pattern}</code>
            </div>
            <footer className="ixs-modal-footer">
              <button
                type="button"
                className="idx-btn"
                onClick={() => setSensitivePendingRule(null)}
              >
                {d.modalCancelBtn}
              </button>
              <button
                type="button"
                className="idx-btn idx-btn-danger"
                onClick={() => applyCandidateRule(sensitivePendingRule)}
              >
                Confirm & Allow
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {note && (
        <div
          className={`ixs-toast ${noteError ? 'ixs-toast-error' : 'ixs-toast-ok'}`}
          role="status"
        >
          {note}
        </div>
      )}
    </div>
  )
}
