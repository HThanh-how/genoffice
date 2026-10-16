import type { ExecutedToolCall } from '@genoffice/agent-core'

/**
 * Claimed-action guard for the Docs skill (AgentSkill.verifyResponse):
 * If a reply claims that document editing, formatting, or styling took place,
 * but no matching document-modification tool executed successfully with actual mutations,
 * this hook returns a corrective prompt forcing one extra turn in AgentLoop.
 *
 * Covers English, Vietnamese, and Chinese claim phrasings.
 */

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
  'create_document',
])

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

/** All tools that alter document content or document state */
export const DOCS_MUTATING_TOOLS = new Set<string>([
  ...DOCS_CONTENT_MUTATING_TOOLS,
  ...DOCS_METADATA_TOOLS,
  ...DOCS_COMMENT_TOOLS,
])

const EN_MODIFICATION_CLAIM =
  /\b(?:I(?:'ve| have)? (?:now |already |just )?(?:updated|edited|formatted|deleted|replaced|applied|inserted|modified|styled|adjusted|completed|changed|configured)|(?:The|This) (?:document|text|paragraph|heading|formatting|document layout) (?:has been|was|is now) (?:updated|edited|formatted|deleted|replaced|applied|inserted|modified|styled|changed)|I have (?:successfully )?(?:made|applied) the (?:requested )?(?:changes|formatting|edits))\b/i

const VI_MODIFICATION_CLAIM =
  /(?:(?:tôi|mình|chúng tôi)\s+(?:đã|vừa)\s+[^。．.!！?？,\n]{0,25}?(?:định dạng|chỉnh sửa|cập nhật|thay thế|xóa|áp dụng|thêm|chèn|tạo|thiết lập|hoàn tất|hoàn thành)|(?:văn bản|tài liệu|đoạn văn|tiêu đề|trang)\s+đã\s+được\s+[^。．.!！?？,\n]{0,25}?(?:định dạng|chỉnh sửa|cập nhật|thay thế|xóa|áp dụng|thêm|chèn|thiết lập|thay đổi)|(?:^|[^\p{L}\p{N}])(?:đã|vừa)\s+[^。．.!！?？,\n]{0,25}?(?:định dạng|cập nhật|chỉnh sửa|thay thế|áp dụng|thiết lập)\s+xong)/iu

const ZH_MODIFICATION_CLAIM =
  /(?:已[^。．.!！?？，,;；:：\n]{0,8}?(?:修改|更新|删除|替換|替换|应用|格式化|完成|调整|調整|插入|设置|設置|排版)(?!的)|(?:文档|文本|段落|格式)\s*已(?:成功)?(?:更新|修改|调整|调整完成|排版完成|格式化))/u

const STRICT_CONTENT_CLAIM_RE =
  /(?:paragraph|heading|font|line spacing|alignment|indent|spacing|bullet|table|chart|picture|image|footnote|endnote|section break|text box|đoạn văn|tiêu đề|phông chữ|font|cỡ chữ|giãn dòng|căn lề đoạn|căn lề dòng|thụt lề|nội dung|chữ|bảng|biểu đồ|hình ảnh|chú thích|hộp văn bản|ngắt phần|段落|标题|字体|字号|行距|对齐|缩进|表格|图表|图片|脚注|尾注|分节符|文本框)/i

const METADATA_CLAIM_RE =
  /(?:page setup|margins?|page orientation|paper size|page layout|watermark|headers?|footers?|style definitions?|define style|styles?|căn lề trang|lề trang|khổ giấy|hướng giấy|cỡ giấy|hình mờ|watermark|đầu trang|chân trang|tiêu đề trang|kiểu định dạng|định nghĩa kiểu|页边距|边距|页面设置|纸张大小|纸张方向|水印|页眉|页脚|样式定义|定义样式|样式)/i

const COMMENT_CLAIM_RE = /(?:bình luận|nhận xét|comment|comments|批注|评论)/i

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

/** Check if an executed call represents a real content mutation (not dry-run or changed=0). */
function isContentMutated(call: ExecutedToolCall): boolean {
  if (!call.ok) return false
  if (!DOCS_CONTENT_MUTATING_TOOLS.has(call.name)) return false
  if (call.mutated === false) return false
  return true
}

/** verifyResponse implementation for the docs skill; returns corrective string or null. */
export function verifyDocsResponse(
  finalText: string,
  executed: readonly ExecutedToolCall[],
): string | null {
  if (!claimsDocModification(finalText)) return null

  const hasContentMutation = executed.some(isContentMutated)
  const hasMetadataSuccess = executed.some((call) => DOCS_METADATA_TOOLS.has(call.name) && call.ok)
  const hasCommentSuccess = executed.some((call) => DOCS_COMMENT_TOOLS.has(call.name) && call.ok)

  const claimsStrictContent = STRICT_CONTENT_CLAIM_RE.test(finalText)
  const claimsMetadata = METADATA_CLAIM_RE.test(finalText)
  const claimsComment = COMMENT_CLAIM_RE.test(finalText)

  // Pure metadata claim (e.g. page setup, watermark, styles)
  if (claimsMetadata && !claimsStrictContent) {
    if (hasMetadataSuccess || hasContentMutation) return null
    return DOCS_CLAIM_CORRECTION
  }

  // Pure comment claim
  if (claimsComment && !claimsStrictContent && !claimsMetadata) {
    if (hasCommentSuccess) return null
    return DOCS_CLAIM_CORRECTION
  }

  // Content or general formatting claim:
  // Requires at least one content mutating tool with actual mutation (not dryRun, not 0 changed)
  if (hasContentMutation) return null

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

  const succeeded = executed.filter((c) => c.ok)
  const failed = executed.filter((c) => !c.ok)
  const dryRun = executed.find(
    (c) => c.name === 'apply_ops' && (c.input?.dryRun === true || c.output?.includes('Dry run')),
  )
  const zeroChanged = executed.find(
    (c) => c.name === 'apply_ops' && c.ok && c.mutated === false && !c.input?.dryRun,
  )

  const cleanError = (c: ExecutedToolCall): string => {
    if (c.output) {
      const firstLine = c.output.split('\n')[0].trim()
      if (firstLine) return firstLine.slice(0, 200)
    }
    return c.summary ?? c.name
  }

  // Case 1: Partial success (some tools succeeded, some failed)
  if (succeeded.length > 0 && failed.length > 0) {
    const succList = [...new Set(succeeded.map((c) => c.name))].join(', ')
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

  // Case 2: All executed tools failed
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

  // Case 3: Dry-run only
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

  // Fallback default
  if (isVi) {
    return 'Không thể xác nhận các thay đổi trên tài liệu.'
  }
  if (isZh) {
    return '无法确认对文档所做的更改。'
  }
  return 'The requested document changes could not be verified.'
}
