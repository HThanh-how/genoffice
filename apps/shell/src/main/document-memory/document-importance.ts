/**
 * File Importance Inference & Representation
 *
 * Evaluates document importance purely from local metadata and extracted text.
 * No cloud models, no open count biases, no Download-folder prejudice.
 */

export type FileImportanceOverride = 'auto' | 'important' | 'low'
export type FileImportanceSuggestion = 'unknown' | 'normal' | 'important'
export type FileImportanceEffective = 'important' | 'normal' | 'low'

export interface FileImportanceInfo {
  override: FileImportanceOverride
  suggestion: FileImportanceSuggestion
  reason: string | null
  effective: FileImportanceEffective
  updatedAt: number
}

export function computeEffectiveImportance(
  override: FileImportanceOverride,
  suggestion: FileImportanceSuggestion,
): FileImportanceEffective {
  if (override === 'important') return 'important'
  if (override === 'low') return 'low'
  if (suggestion === 'important') return 'important'
  return 'normal'
}

/** Normalized lowercase string stripped of Vietnamese diacritics and separators */
function normalizeForMatching(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[-_./\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface DocumentInferenceInput {
  name: string
  path: string
  content?: string | null
}

export interface DocumentImportanceInference {
  suggestion: FileImportanceSuggestion
  reason: string | null
}

const ID_DOC_TERMS = [
  'cccd',
  'cmnd',
  'can cuoc cong dan',
  'can cuoc',
  'chung minh nhan dan',
  'chung minh thu',
  'ho chieu',
  'passport',
  'so dinh danh ca nhan',
  'giay khai sinh',
  'citizen identity',
  'identity card',
]

const DISCHARGE_TERMS = [
  'giay ra vien',
  'giay xuat vien',
  'don xin ra vien',
  'xuat vien',
  'ra vien',
  'discharge summary',
  'hospital discharge',
]

const MEDICAL_TERMS = [
  'ho so benh an',
  'so kham benh',
  'phieu kham benh',
  'ket qua xet nghiem',
  'ket qua sieu am',
  'ket qua chup x-quang',
  'ket qua mri',
  'phieu xet nghiem',
  'don thuoc',
  'toa thuoc',
  'giay chuyen vien',
  'medical record',
  'prescription',
]

const CONTRACT_TERMS = [
  'hop dong lao dong',
  'hop dong kinh te',
  'hop dong mua ban',
  'hop dong thue nha',
  'hop dong thue',
  'hop dong chuyen nhuong',
  'hop dong dat coc',
  'hop dong',
  'thoa thuan bao mat',
  'bien ban thanh ly',
  'employment contract',
  'service agreement',
  'non-disclosure agreement',
]

function termMatches(haystack: string, term: string): boolean {
  if (term.length <= 4) {
    // Short terms like cccd, cmnd, nda need word boundary checks
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(haystack)
  }
  if (haystack.includes(term)) return true
  // Check concatenated variant (e.g. giayravien, hopdong)
  const compactHaystack = haystack.replace(/\s+/g, '')
  const compactTerm = term.replace(/\s+/g, '')
  if (compactTerm.length >= 6 && compactHaystack.includes(compactTerm)) {
    return true
  }
  return false
}

export function inferDocumentImportance(input: DocumentInferenceInput): DocumentImportanceInference {
  const normName = normalizeForMatching(input.name || '')
  const normPath = normalizeForMatching(input.path || '')
  const normContent = input.content ? normalizeForMatching(input.content) : ''

  // 1. Discharge papers (Giấy ra viện / xuất viện)
  for (const term of DISCHARGE_TERMS) {
    if (termMatches(normName, term)) {
      return { suggestion: 'important', reason: `Tên file chứa '${input.name.includes('xuất viện') || normName.includes('xuat vien') ? 'giấy xuất viện' : 'giấy ra viện'}'` }
    }
    if (normContent && termMatches(normContent, term)) {
      return { suggestion: 'important', reason: `Nội dung tài liệu chứa '${normContent.includes('xuat vien') ? 'giấy xuất viện' : 'giấy ra viện'}'` }
    }
    if (termMatches(normPath, term)) {
      return { suggestion: 'important', reason: `Đường dẫn thư mục chứa '${normPath.includes('xuat vien') ? 'giấy xuất viện' : 'giấy ra viện'}'` }
    }
  }

  // 2. ID documents (Căn cước công dân, CMND, Hộ chiếu)
  for (const term of ID_DOC_TERMS) {
    if (termMatches(normName, term)) {
      return { suggestion: 'important', reason: `Tên file chứa thông tin giấy tờ tùy thân (${term.toUpperCase()})` }
    }
    if (normContent && termMatches(normContent, term)) {
      return { suggestion: 'important', reason: `Nội dung tài liệu chứa thông tin giấy tờ tùy thân (${term.toUpperCase()})` }
    }
    if (termMatches(normPath, term)) {
      return { suggestion: 'important', reason: `Đường dẫn thư mục chứa giấy tờ tùy thân (${term.toUpperCase()})` }
    }
  }

  // 3. Medical records (Hồ sơ bệnh án, sổ khám, xét nghiệm)
  for (const term of MEDICAL_TERMS) {
    if (termMatches(normName, term)) {
      return { suggestion: 'important', reason: `Tên file chứa hồ sơ y tế / bệnh án` }
    }
    if (normContent && termMatches(normContent, term)) {
      return { suggestion: 'important', reason: `Nội dung tài liệu chứa thông tin y tế / bệnh án` }
    }
    if (termMatches(normPath, term)) {
      return { suggestion: 'important', reason: `Đường dẫn thư mục chứa hồ sơ y tế` }
    }
  }

  // 4. Contracts (Hợp đồng, thỏa thuận)
  for (const term of CONTRACT_TERMS) {
    if (termMatches(normName, term)) {
      return { suggestion: 'important', reason: `Tên file chứa văn bản hợp đồng / thỏa thuận` }
    }
    if (normContent && termMatches(normContent, term)) {
      return { suggestion: 'important', reason: `Nội dung tài liệu là văn bản hợp đồng / thỏa thuận` }
    }
    if (termMatches(normPath, term)) {
      return { suggestion: 'important', reason: `Đường dẫn thư mục chứa hợp đồng` }
    }
  }

  // Default when insufficient evidence
  return { suggestion: 'normal', reason: null }
}
