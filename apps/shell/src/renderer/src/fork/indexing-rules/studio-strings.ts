/* Studio copy in English and Vietnamese. Components receive one frozen
 * dictionary (StudioStrings) so rendering stays deterministic. */
export interface StudioStrings {
  title: string
  subtitle: string
  navOverview: string
  navRules: string
  navIgnore: string
  addRule: string
  testPath: string
  modeLabel: string
  modeStandard: string
  modeAllowlist: string
  modeStandardDesc: string
  modeAllowlistDesc: string
  saving: string
  savedSuccess: string
  saveFailed: string
  loadFailed: string
  docTypesTitle: string
  docTypesHint: string
  mediaHint: string
  presetsTitle: string
  presetsManage: string
  presetsSummary: (enabled: number, total: number) => string
  customTitle: string
  customSummary: (allow: number, ignore: number, file: number) => string
  viewRules: string
  configTitle: string
  fileExists: string
  fileMissing: string
  editFile: string
  testerTitle: string
  testerPlaceholder: string
  testerCheck: string
  testerChecking: string
  testerRoot: string
  testerAuto: string
  outcomeAllowed: string
  outcomeIgnored: string
  outcomeUnsupported: string
  outcomeError: string
  outcomeErrorHint: string
  matchedRule: string
  indexedYes: string
  indexedNo: string
  searchPlaceholder: string
  filterAll: string
  filterAllow: string
  filterIgnore: string
  filtersBtn: string
  scopeLabel: string
  scopeAll: string
  scopeGlobal: string
  sourceLabel: string
  sourceAll: string
  sourceCustom: string
  sourceFile: string
  sourcePreset: string
  stateLabel: string
  stateAll: string
  stateEnabled: string
  stateDisabled: string
  colRule: string
  colAction: string
  colScope: string
  colStatus: string
  colActions: string
  selectRule: string
  selectPage: string
  selectedSummary: (count: number, editable: number) => string
  bulkEnable: string
  bulkDisable: string
  bulkDelete: string
  clearSelection: string
  pageSummary: (cur: number, total: number, count: number) => string
  rowsPerPage: string
  prevPage: string
  nextPage: string
  enable: string
  disable: string
  edit: string
  delete: string
  openFile: string
  fileReadOnlyHint: string
  presetReadOnlyHint: string
  emptyRules: string
  emptyAllRules: string
  confirmDeleteRule: (pattern: string) => string
  confirmBulkDelete: (count: number) => string
  modalAddTitle: string
  modalEditTitle: string
  actionLabel: string
  patternLabel: string
  patternPlaceholder: string
  scopeFieldLabel: string
  scopeGlobalOption: string
  descLabel: string
  descPlaceholder: string
  saveRule: string
  cancel: string
  sensitiveTitle: string
  sensitiveConfirm: string
  editorTitle: string
  editorRootLabel: string
  editorSave: string
  editorReload: string
  editorTemplate: string
  editorSyntax: string
  editorUnsavedTitle: string
  editorUnsavedMessage: string
  editorSaveBtn: string
  editorDiscardBtn: string
  editorCancelBtn: string
  editorSaved: string
  editorDirty: string
  editorClean: string
  editorConflict: string
  editorReloadConfirm: string
  editorErrorsTitle: string
  editorMissing: string
  syntaxTitle: string
  presetNames: string
}

const en: StudioStrings = {
  title: 'Indexing rules',
  subtitle: 'Decide which files GenOffice reads for search.',
  navOverview: 'Overview',
  navRules: 'Rules',
  navIgnore: '.genofficeignore',
  addRule: 'Add rule',
  testPath: 'Test path',
  modeLabel: 'Indexing mode',
  modeStandard: 'Standard',
  modeAllowlist: 'Allowlist',
  modeStandardDesc: 'Supported files are indexed unless a rule ignores them.',
  modeAllowlistDesc: 'Only patterns you allow are indexed; everything else is skipped.',
  saving: 'Saving…',
  savedSuccess: 'Policy saved.',
  saveFailed: 'Save failed — the change was not applied.',
  loadFailed: 'Could not load the indexing policy.',
  docTypesTitle: 'Document types indexed',
  docTypesHint: 'Only formats the current pipeline can read are listed.',
  mediaHint: 'Images and video are tracked as metadata only — their content is not indexed.',
  presetsTitle: 'Recommended exclusions',
  presetsManage: 'Manage presets',
  presetsSummary: (enabled, total) => `${enabled} of ${total} recommended exclusions enabled.`,
  customTitle: 'Custom policy',
  customSummary: (allow, ignore, file) =>
    `${allow} allow rules, ${ignore} ignore rules, ${file} rules from .genofficeignore files.`,
  viewRules: 'View all rules',
  configTitle: 'Configuration files',
  fileExists: 'has .genofficeignore',
  fileMissing: 'no .genofficeignore yet',
  editFile: 'Edit',
  testerTitle: 'Test a path',
  testerPlaceholder: 'e.g. drafts/report.docx',
  testerCheck: 'Check',
  testerChecking: 'Checking…',
  testerRoot: 'Indexed folder',
  testerAuto: 'Auto-detect',
  outcomeAllowed: 'Allowed',
  outcomeIgnored: 'Ignored',
  outcomeUnsupported: 'Unsupported format',
  outcomeError: 'Could not evaluate',
  outcomeErrorHint: 'The policy engine did not respond. Try again.',
  matchedRule: 'Matched rule',
  indexedYes: 'Already in search results',
  indexedNo: 'Not indexed yet',
  searchPlaceholder: 'Search rules',
  filterAll: 'All',
  filterAllow: 'Allow',
  filterIgnore: 'Ignore',
  filtersBtn: 'Filters',
  scopeLabel: 'Scope',
  scopeAll: 'All scopes',
  scopeGlobal: 'Global',
  sourceLabel: 'Source',
  sourceAll: 'All sources',
  sourceCustom: 'Custom rules',
  sourceFile: '.genofficeignore',
  sourcePreset: 'Presets',
  stateLabel: 'State',
  stateAll: 'All states',
  stateEnabled: 'Enabled',
  stateDisabled: 'Disabled',
  colRule: 'Rule',
  colAction: 'Action',
  colScope: 'Scope',
  colStatus: 'Status',
  colActions: 'Actions',
  selectRule: 'Select rule',
  selectPage: 'Select page',
  selectedSummary: (count, editable) => `${count} selected · ${editable} editable`,
  bulkEnable: 'Enable',
  bulkDisable: 'Disable',
  bulkDelete: 'Delete',
  clearSelection: 'Clear',
  pageSummary: (cur, total, count) => `Page ${cur} of ${total} · ${count} rules`,
  rowsPerPage: 'Rows per page',
  prevPage: 'Previous page',
  nextPage: 'Next page',
  enable: 'Enable',
  disable: 'Disable',
  edit: 'Edit',
  delete: 'Delete',
  openFile: 'Open file',
  fileReadOnlyHint: 'Managed in the .genofficeignore file',
  presetReadOnlyHint: 'Managed by preset toggles',
  emptyRules: 'No rules match the current filters.',
  emptyAllRules: 'No indexing rules yet. Add one or enable a preset.',
  confirmDeleteRule: (pattern) => `Delete the rule "${pattern}"?`,
  confirmBulkDelete: (count) => `Delete the ${count} selected rules?`,
  modalAddTitle: 'Add rule',
  modalEditTitle: 'Edit rule',
  actionLabel: 'Action',
  patternLabel: 'Pattern',
  patternPlaceholder: 'e.g. *.docx or drafts/**',
  scopeFieldLabel: 'Scope',
  scopeGlobalOption: 'All folders',
  descLabel: 'Description',
  descPlaceholder: 'Optional note',
  saveRule: 'Save rule',
  cancel: 'Cancel',
  sensitiveTitle: 'Sensitive location',
  sensitiveConfirm:
    'This allow rule targets a sensitive location (.ssh, .env, secrets, credentials, private). Files inside may appear in search. Allow it anyway?',
  editorTitle: '.genofficeignore editor',
  editorRootLabel: 'Indexed folder',
  editorSave: 'Save',
  editorReload: 'Reload from disk',
  editorTemplate: 'Insert template',
  editorSyntax: 'Syntax guide',
  editorUnsavedTitle: 'Unsaved changes',
  editorUnsavedMessage:
    'The .genofficeignore file has unsaved changes. What should happen to them?',
  editorSaveBtn: 'Save',
  editorDiscardBtn: 'Discard',
  editorCancelBtn: 'Cancel',
  editorSaved: 'Saved',
  editorDirty: 'Unsaved changes',
  editorClean: 'No changes',
  editorConflict:
    'The file changed on disk while you were editing. Reload to see the latest version.',
  editorReloadConfirm: 'Reloading from disk discards your unsaved changes. Continue?',
  editorErrorsTitle: 'Validation errors',
  editorMissing: 'The file does not exist yet. Save to create it.',
  syntaxTitle: 'Syntax guide',
  presetNames: 'patterns',
}

const vi: StudioStrings = {
  title: 'Quy tắc lập chỉ mục',
  subtitle: 'Quyết định những tệp GenOffice đọc để tìm kiếm.',
  navOverview: 'Tổng quan',
  navRules: 'Quy tắc',
  navIgnore: '.genofficeignore',
  addRule: 'Thêm quy tắc',
  testPath: 'Thử đường dẫn',
  modeLabel: 'Chế độ lập chỉ mục',
  modeStandard: 'Tiêu chuẩn',
  modeAllowlist: 'Allowlist',
  modeStandardDesc: 'Tệp được hỗ trợ sẽ được lập chỉ mục trừ khi quy tắc loại trừ.',
  modeAllowlistDesc: 'Chỉ những mẫu bạn cho phép mới được lập chỉ mục; còn lại bị bỏ qua.',
  saving: 'Đang lưu…',
  savedSuccess: 'Đã lưu chính sách.',
  saveFailed: 'Lưu thất bại — thay đổi không được áp dụng.',
  loadFailed: 'Không tải được chính sách lập chỉ mục.',
  docTypesTitle: 'Loại tài liệu được lập chỉ mục',
  docTypesHint: 'Chỉ liệt kê các định dạng pipeline hiện có đọc được.',
  mediaHint: 'Ảnh và video chỉ được theo dõi metadata — nội dung không được lập chỉ mục.',
  presetsTitle: 'Loại trừ khuyến nghị',
  presetsManage: 'Quản lý preset',
  presetsSummary: (enabled, total) => `${enabled}/${total} loại trừ khuyến nghị đang bật.`,
  customTitle: 'Chính sách tùy chỉnh',
  customSummary: (allow, ignore, file) =>
    `${allow} quy tắc cho phép, ${ignore} quy tắc loại trừ, ${file} quy tắc từ tệp .genofficeignore.`,
  viewRules: 'Xem tất cả quy tắc',
  configTitle: 'Tệp cấu hình',
  fileExists: 'có .genofficeignore',
  fileMissing: 'chưa có .genofficeignore',
  editFile: 'Sửa',
  testerTitle: 'Thử đường dẫn',
  testerPlaceholder: 'vd: drafts/report.docx',
  testerCheck: 'Kiểm tra',
  testerChecking: 'Đang kiểm tra…',
  testerRoot: 'Thư mục chỉ mục',
  testerAuto: 'Auto-detect',
  outcomeAllowed: 'Cho phép',
  outcomeIgnored: 'Bị loại trừ',
  outcomeUnsupported: 'Định dạng không hỗ trợ',
  outcomeError: 'Không đánh giá được',
  outcomeErrorHint: 'Engine chính sách không phản hồi. thử lại.',
  matchedRule: 'Quy tắc khớp',
  indexedYes: 'Đã có trong tìm kiếm',
  indexedNo: 'Chưa lập chỉ mục',
  searchPlaceholder: 'Tìm quy tắc',
  filterAll: 'Tất cả',
  filterAllow: 'Cho phép',
  filterIgnore: 'Loại trừ',
  filtersBtn: 'Bộ lọc',
  scopeLabel: 'Phạm vi',
  scopeAll: 'Mọi phạm vi',
  scopeGlobal: 'Toàn cục',
  sourceLabel: 'Nguồn',
  sourceAll: 'Mọi nguồn',
  sourceCustom: 'Quy tắc tùy chỉnh',
  sourceFile: '.genofficeignore',
  sourcePreset: 'Preset',
  stateLabel: 'Trạng thái',
  stateAll: 'Mọi trạng thái',
  stateEnabled: 'Bật',
  stateDisabled: 'Tắt',
  colRule: 'Quy tắc',
  colAction: 'Hành động',
  colScope: 'Phạm vi',
  colStatus: 'Trạng thái',
  colActions: 'Thao tác',
  selectRule: 'Chọn quy tắc',
  selectPage: 'Chọn trang',
  selectedSummary: (count, editable) => `${count} đã chọn · ${editable} sửa được`,
  bulkEnable: 'Bật',
  bulkDisable: 'Tắt',
  bulkDelete: 'Xóa',
  clearSelection: 'Bỏ chọn',
  pageSummary: (cur, total, count) => `Trang ${cur}/${total} · ${count} quy tắc`,
  rowsPerPage: 'Số dòng mỗi trang',
  prevPage: 'Trang trước',
  nextPage: 'Trang sau',
  enable: 'Bật',
  disable: 'Tắt',
  edit: 'Sửa',
  delete: 'Xóa',
  openFile: 'Mở tệp',
  fileReadOnlyHint: 'Quản lý trong tệp .genofficeignore',
  presetReadOnlyHint: 'Quản lý bằng toggle preset',
  emptyRules: 'Không có quy tắc khớp bộ lọc.',
  emptyAllRules: 'Chưa có quy tắc nào. Thêm một quy tắc hoặc bật preset.',
  confirmDeleteRule: (pattern) => `Xóa quy tắc "${pattern}"?`,
  confirmBulkDelete: (count) => `Xóa ${count} quy tắc đã chọn?`,
  modalAddTitle: 'Thêm quy tắc',
  modalEditTitle: 'Sửa quy tắc',
  actionLabel: 'Hành động',
  patternLabel: 'Mẫu',
  patternPlaceholder: 'vd: *.docx hoặc drafts/**',
  scopeFieldLabel: 'Phạm vi',
  scopeGlobalOption: 'Tất cả thư mục',
  descLabel: 'Mô tả',
  descPlaceholder: 'Ghi chú (tùy chọn)',
  saveRule: 'Lưu quy tắc',
  cancel: 'Hủy',
  sensitiveTitle: 'Vị trí nhạy cảm',
  sensitiveConfirm:
    'Quy tắc cho phép này nhắm tới vị trí nhạy cảm (.ssh, .env, secrets, credentials, private). Tệp bên trong có thể xuất hiện trong tìm kiếm. vẫn cho phép?',
  editorTitle: 'Trình chỉnh sửa .genofficeignore',
  editorRootLabel: 'Thư mục chỉ mục',
  editorSave: 'Lưu',
  editorReload: 'Tải lại từ đĩa',
  editorTemplate: 'Chèn mẫu',
  editorSyntax: 'Hướng dẫn cú pháp',
  editorUnsavedTitle: 'Thay đổi chưa lưu',
  editorUnsavedMessage: 'Tệp .genofficeignore có thay đổi chưa lưu. Bạn muốn xử lý thế nào?',
  editorSaveBtn: 'Lưu',
  editorDiscardBtn: 'Bỏ',
  editorCancelBtn: 'Hủy',
  editorSaved: 'Đã lưu',
  editorDirty: 'Chưa lưu thay đổi',
  editorClean: 'Không có thay đổi',
  editorConflict:
    'Tệp trên đĩa đã bị thay đổi trong lúc bạn chỉnh sửa. Tải lại để xem bản mới nhất.',
  editorReloadConfirm: 'Tải lại từ đĩa sẽ bỏ thay đổi chưa lưu. Tiếp tục?',
  editorErrorsTitle: 'Lỗi kiểm',
  editorMissing: 'Tệp chưa tồn tại. Lưu để tạo tệp.',
  syntaxTitle: 'Hướng dẫn cú pháp',
  presetNames: 'mẫu',
}

export const STUDIO_STRINGS: Record<string, StudioStrings> = { en, vi }

export function studioStrings(lang: string): StudioStrings {
  return STUDIO_STRINGS[lang] ?? en
}
