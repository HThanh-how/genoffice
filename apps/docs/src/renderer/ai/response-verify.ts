import type { ExecutedToolCall } from '@genoffice/agent-core'

/**
 * Claimed-action guard for the Docs skill (AgentSkill.verifyResponse):
 * If a reply claims that document editing, formatting, or styling took place,
 * but no matching document-modification tool executed successfully with actual mutations,
 * this hook returns a corrective prompt forcing one extra turn in AgentLoop.
 *
 * Covers English, Vietnamese, and Chinese claim phrasings.
 */

/** Effect categories distinguishing different document and application actions */
export type DocsEffectCategory =
  | 'new_document'
  | 'page_setup'
  | 'watermark'
  | 'header_footer'
  | 'style_definition'
  | 'comment'
  | 'content'

/** Tools that modify document content/blocks/elements directly */
export const DOCS_CONTENT_MUTATING_TOOLS = new Set<string>([
  'apply_ops',
  'insert_content',
  'write_document',
  'replace_blocks',
  'replace_selection',
  'accept_changes',
  'reject_changes',
  'insert_footnote',
  'insert_endnote',
  'delete_note',
  'edit_note',
  'insert_image',
  'insert_picture',
  'generate_image',
  'insert_chart',
  'edit_chart',
  'insert_section_break',
  'insert_text_box',
])

/** Tool that creates a new standalone document file (does not mutate the current document) */
export const DOCS_CREATION_TOOLS = new Set<string>(['create_document'])

/** Tools that modify document-level metadata / configuration (not ProseMirror doc tree) */
export const DOCS_METADATA_TOOLS = new Set<string>([
  'set_page_setup',
  'define_style',
  'set_watermark',
  'set_header_footer',
])

/** Tools for comment management */
export const DOCS_COMMENT_TOOLS = new Set<string>([
  'reply_comment',
  'resolve_comment',
  'add_comment',
  'delete_comment',
])

/** All tools that alter document content, document files, or document state */
export const DOCS_MUTATING_TOOLS = new Set<string>([
  ...DOCS_CONTENT_MUTATING_TOOLS,
  ...DOCS_CREATION_TOOLS,
  ...DOCS_METADATA_TOOLS,
  ...DOCS_COMMENT_TOOLS,
])

export function getToolEffectCategory(name: string): DocsEffectCategory | null {
  if (name === 'create_document') return 'new_document'
  if (name === 'set_page_setup') return 'page_setup'
  if (name === 'set_watermark') return 'watermark'
  if (name === 'set_header_footer') return 'header_footer'
  if (name === 'define_style') return 'style_definition'
  if (DOCS_COMMENT_TOOLS.has(name)) return 'comment'
  if (DOCS_CONTENT_MUTATING_TOOLS.has(name)) return 'content'
  return null
}

/** Check if an executed tool call represents a genuine, effective action */
export function isCallEffective(call: ExecutedToolCall): boolean {
  if (!call.ok) return false
  const cat = getToolEffectCategory(call.name)
  if (!cat) return false
  if (cat === 'content') {
    return call.mutated !== false
  }
  return true
}

/** Collect verified effect categories from executed tools */
export function getVerifiedEffects(executed: readonly ExecutedToolCall[]): Set<DocsEffectCategory> {
  const verified = new Set<DocsEffectCategory>()
  for (const call of executed) {
    if (isCallEffective(call)) {
      const cat = getToolEffectCategory(call.name)
      if (cat) verified.add(cat)
    }
  }
  return verified
}

const EN_MODIFICATION_CLAIM =
  /\b(?:I(?:'ve| have)? (?:now |already |just )?(?:updated|edited|formatted|deleted|replaced|applied|inserted|added|modified|styled|adjusted|completed|changed|configured|created|built)|(?:The|This) (?:document|text|paragraph|heading|formatting|document layout|watermark|page setup|page margins?|margins?|style|styles?) (?:has been|was|is now) (?:updated|edited|formatted|deleted|replaced|applied|inserted|added|modified|styled|changed|created|built)|I have (?:successfully )?(?:made|applied|created|added) the (?:requested )?(?:changes|formatting|edits|document|file|watermark))\b/i

const VI_MODIFICATION_CLAIM =
  /(?:(?:tôi|mình|chúng tôi)\s+(?:đã|vừa)\s+[^。．.!！?？,\n]{0,25}?(?:định dạng|chỉnh sửa|chỉnh|cập nhật|thay thế|xóa|áp dụng|thêm|chèn|tạo|thiết lập|căn lề|căn|đặt|hoàn tất|hoàn thành)|(?:văn bản|tài liệu|đoạn văn|tiêu đề|trang|hình mờ|watermark|lề trang)\s+đã\s+được\s+[^。．.!！?？,\n]{0,25}?(?:định dạng|chỉnh sửa|chỉnh|cập nhật|thay thế|xóa|áp dụng|thêm|chèn|thiết lập|căn|đặt|thay đổi|tạo)|(?:^|[^\p{L}\p{N}])(?:đã|vừa)\s+[^。．.!！?？,\n]{0,25}?(?:định dạng|cập nhật|chỉnh sửa|chỉnh|thay thế|áp dụng|thiết lập|căn|đặt|tạo)\s+xong)/iu

const ZH_MODIFICATION_CLAIM =
  /(?:已[^。．.!！?？，,;；:：\n]{0,8}?(?:修改|更新|删除|替換|替换|应用|格式化|完成|调整|調整|插入|设置|設置|排版|创建|建立)(?!的)|(?:文档|文本|段落|格式|水印|页边距|页面设置)\s*已(?:成功)?(?:更新|修改|调整|调整完成|排版完成|格式化|创建|添加|设置))/u

const NEW_DOC_CLAIM_RE =
  /(?:\b(?:I(?:'ve| have)? )?(?:created?|generated?|built)\s+(?:a\s+)?(?:new\s+)?(?:document|file)\b|\bnew\s+(?:document|file)\s+(?:has\s+been|was)\s+created\b|(?:tôi|mình|chúng tôi)?\s*(?:đã|vừa)\s+tạo\s+(?:một\s+)?(?:tài liệu|văn bản|file|tệp)(?:\s+mới)?|tài liệu mới đã được tạo|(?:已|成功)?(?:创建|建立)(?:了)?(?:新文档|新文件)|新文档已创建)/iu

const PAGE_SETUP_CLAIM_RE =
  /(?:\b(?:page\s+setup|paper\s+size|page\s+orientation|margins?)\b|căn\s+lề\s+trang|lề\s+trang|khổ\s+giấy|hướng\s+giấy|thiết\s+lập\s+trang|页边距|页面设置|纸张大小|纸张方向)/iu

const WATERMARK_CLAIM_RE = /(?:\bwatermarks?\b|hình\s+mờ|watermark|水印)/iu

const HEADER_FOOTER_CLAIM_RE =
  /(?:\b(?:headers?|footers?|header\/footer)\b|đầu\s+trang|chân\s+trang|tiêu\s+đề\s+trang|页眉|页脚)/iu

const STYLE_DEF_CLAIM_RE =
  /(?:\b(?:style\s+definitions?|defined\s+(?:a\s+)?style|styles?\s+defined|styles?\s+definition)\b|định\s+nghĩa\s+kiểu|kiểu\s+định\s+dạng|样式定义|定义样式)/iu

const COMMENT_CLAIM_RE = /(?:\bcomments?\b|bình\s+luận|nhận\s+xét|批注|评论)/iu

const CONTENT_SPECIFIC_RE =
  /(?:\b(?:paragraphs?|headings?|fonts?|font\s+family|font\s+size|line\s+spacing|align(?:ment)?|indents?|indentation|bullets?|tables?|charts?|pictures?|images?|footnotes?|endnotes?|section\s+breaks?|text\s+box(?:es)?|content|text|blocks?)\b|đoạn\s+văn|tiêu\s+đề(?!\s+trang)|phông\s+chữ|font|cỡ\s+chữ|giãn\s+dòng|căn\s+lề\s+đoạn|thụt\s+lề|bảng|biểu\s+đồ|hình\s+ảnh|ảnh|chú\s+thích|hộp\s+văn\s+bản|ngắt\s+phần|nội\s+dung|段落|标题(?!页)|字体|字号|行距|对齐|缩进|表格|图表|图片|脚注|尾注|分节符|文本框|内容|正文)/iu

const GENERIC_FORMATTING_RE =
  /(?:\b(?:formatted|styled|reformatted)\b|định\s+dạng(?:\s+lại)?|排版)/iu

const FAILURE_INDICATOR_RE =
  /(?:\b(?:failed|fails?|could not|cannot|unable to|error|exception|unsuccessful|not applied|no changes)\b|thất bại|không thể|gặp lỗi|lỗi|chưa thể|không thành công|không áp dụng|chưa có thay đổi|失败|无法|不能|未能|未应用|未做修改)/i

export const DOCS_CLAIM_CORRECTION =
  '[System check] Your reply claims that document editing, formatting, or styling was completed, ' +
  'but no document-modification tool executed successfully during this run. ' +
  'Either invoke the required tool now to actually perform the action, ' +
  'or rewrite your reply so it accurately reflects what occurred without claiming changes that did not happen.'

export function claimsDocModification(text: string): boolean {
  return (
    EN_MODIFICATION_CLAIM.test(text) ||
    VI_MODIFICATION_CLAIM.test(text) ||
    ZH_MODIFICATION_CLAIM.test(text)
  )
}

/** Split text into clauses/sentences to analyze each claim context separately */
function splitIntoClauses(text: string): string[] {
  return text
    .split(
      /(?:[。．.!?！\n]+|;\s*|\b(?:however|but|yet)\b|(?:\s* tuy nhiên\s*|\s* nhưng\s*|\s* song\s*|，但是|但是))/iu,
    )
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Extract specific action effects affirmatively claimed in the reply */
export function getClaimedSpecificEffects(text: string): Set<DocsEffectCategory> {
  const claimed = new Set<DocsEffectCategory>()
  const clauses = splitIntoClauses(text)

  for (const clause of clauses) {
    if (FAILURE_INDICATOR_RE.test(clause)) {
      continue
    }
    const hasNewDoc = NEW_DOC_CLAIM_RE.test(clause)
    const hasPageSetup = PAGE_SETUP_CLAIM_RE.test(clause)
    const hasWatermark = WATERMARK_CLAIM_RE.test(clause)
    const hasHeaderFooter = HEADER_FOOTER_CLAIM_RE.test(clause)
    const hasStyleDef = STYLE_DEF_CLAIM_RE.test(clause)
    const hasComment = COMMENT_CLAIM_RE.test(clause)

    if (hasNewDoc) claimed.add('new_document')
    if (hasPageSetup) claimed.add('page_setup')
    if (hasWatermark) claimed.add('watermark')
    if (hasHeaderFooter) claimed.add('header_footer')
    if (hasStyleDef) claimed.add('style_definition')
    if (hasComment) claimed.add('comment')

    // Content modification is claimed if explicit content elements are mentioned,
    // or if a generic formatting verb was used without being bound to a specific metadata target.
    const hasContentSpecific = CONTENT_SPECIFIC_RE.test(clause)
    const hasGenericFormatting = GENERIC_FORMATTING_RE.test(clause)
    const hasOtherTarget =
      hasNewDoc || hasPageSetup || hasWatermark || hasHeaderFooter || hasStyleDef || hasComment

    if (hasContentSpecific || (hasGenericFormatting && !hasOtherTarget)) {
      claimed.add('content')
    }
  }

  return claimed
}

/** verifyResponse implementation for the docs skill; returns corrective string or null. */
export function verifyDocsResponse(
  finalText: string,
  executed: readonly ExecutedToolCall[],
): string | null {
  if (!claimsDocModification(finalText)) return null

  const verified = getVerifiedEffects(executed)
  const claimedSpecific = getClaimedSpecificEffects(finalText)

  // If specific modification effects were claimed, every claimed specific effect
  // must have corresponding evidence in verified effects.
  if (claimedSpecific.size > 0) {
    for (const cat of claimedSpecific) {
      if (!verified.has(cat)) {
        return DOCS_CLAIM_CORRECTION
      }
    }
    return null
  }

  // General modification claim (no specific effect singled out):
  // At least one meaningful modification or new-document creation or comment must have succeeded.
  if (verified.size > 0) {
    return null
  }

  return DOCS_CLAIM_CORRECTION
}

/**
 * Deterministic truthful fallback for the Docs skill when the model repeats
 * an unverified completion claim after a corrective retry turn.
 */
export function fallbackDocsResponse(
  finalText: string,
  executed: readonly ExecutedToolCall[],
): string {
  const isZh = /[\p{sc=Han}]/u.test(finalText)
  const isVi =
    !isZh &&
    /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(finalText)

  // Meaningful successfully completed modifications / actions
  const effectiveSucceeded = executed.filter(isCallEffective)
  // Failed tool calls
  const failed = executed.filter((c) => !c.ok)
  const dryRun = executed.find(
    (c) => c.name === 'apply_ops' && (c.input?.dryRun === true || c.output?.includes('Dry run')),
  )
  const zeroChanged = executed.find(
    (c) =>
      c.name === 'apply_ops' &&
      c.ok &&
      c.mutated === false &&
      !c.input?.dryRun &&
      !c.output?.includes('Dry run'),
  )

  const cleanError = (c: ExecutedToolCall): string => {
    if (c.output) {
      const firstLine = c.output.split('\n')[0].trim()
      if (firstLine) return firstLine.slice(0, 200)
    }
    return c.summary ?? c.name
  }

  // Case 1: Partial success (at least one meaningful modification succeeded, and some tool failed)
  if (effectiveSucceeded.length > 0 && failed.length > 0) {
    const succList = [...new Set(effectiveSucceeded.map((c) => c.name))].join(', ')
    const failList = failed.map((c) => `- ${c.name}: ${cleanError(c)}`).join('\n')
    if (isVi) {
      return (
        `Thao tác được thực hiện một phần:\n` +
        `- Đã hoàn thành: ${succList}\n` +
        `- Gặp lỗi:\n${failList}`
      )
    }
    if (isZh) {
      return `操作已部分完成：\n` + `- 已完成：${succList}\n` + `- 失败项：\n${failList}`
    }
    return (
      `The operation was partially completed:\n` +
      `- Succeeded: ${succList}\n` +
      `- Failed:\n${failList}`
    )
  }

  // Case 2: One or more tools failed, and NO modifications succeeded
  // (e.g. read_blocks succeeded + apply_ops failed, dryRun + apply_ops failed, or all failed)
  if (failed.length > 0) {
    const failList = failed.map((c) => `- ${c.name}: ${cleanError(c)}`).join('\n')
    if (isVi) {
      return `Không thể hoàn tất thao tác do các công cụ thực hiện không thành công:\n${failList}`
    }
    if (isZh) {
      return `由于工具执行失败，无法完成所请求的操作：\n${failList}`
    }
    return `The requested operation could not be completed because the tool execution failed:\n${failList}`
  }

  // Case 3: Dry-run only (no failures, but no changes applied)
  if (dryRun) {
    if (isVi) {
      return 'Thao tác chỉ chạy ở chế độ kiểm tra trước (dryRun), chưa có thay đổi nào được áp dụng vào tài liệu.'
    }
    if (isZh) {
      return '操作仅在预览模式（dryRun）下运行，未对文档应用任何更改。'
    }
    return 'The operation was executed in dry-run mode; no changes were applied to the document.'
  }

  // Case 4: No targets matched / 0 changed
  if (zeroChanged) {
    if (isVi) {
      return 'Không có thay đổi nào được áp dụng do không tìm thấy nội dung hoặc đoạn văn phù hợp trong tài liệu.'
    }
    if (isZh) {
      return '未应用任何更改，因为在文档中未找到匹配的内容或段落。'
    }
    return 'No changes were applied because no matching content or paragraphs were found in the document.'
  }

  // Case 5: No tools executed
  if (executed.length === 0) {
    if (isVi) {
      return 'Yêu cầu không được thực hiện do không có công cụ sửa đổi tài liệu nào được gọi.'
    }
    if (isZh) {
      return '由于未调用任何文档修改工具，请求未执行。'
    }
    return 'The request could not be completed because no document-modifying tools were invoked.'
  }

  // Case 6: Only read-only tools executed without errors, but modification was claimed
  if (isVi) {
    return 'Không có thay đổi nào được áp dụng vì không có công cụ sửa đổi tài liệu nào được thực hiện.'
  }
  if (isZh) {
    return '由于未执行任何文档修改工具，未对文档应用任何更改。'
  }
  return 'No changes were applied because no document-modifying tools were executed.'
}
