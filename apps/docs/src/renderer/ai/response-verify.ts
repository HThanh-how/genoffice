import type { ExecutedToolCall } from '@genoffice/agent-core'

/**
 * Claimed-action guard for the Docs skill (AgentSkill.verifyResponse):
 * If a reply claims that document editing, formatting, or styling took place,
 * but no document-modification tool executed successfully during this run,
 * this hook returns a corrective prompt forcing one extra turn in AgentLoop.
 *
 * Covers English, Vietnamese, and Chinese claim phrasings.
 */

export const DOCS_MUTATING_TOOLS = new Set<string>([
  'apply_ops',
  'insert_content',
  'write_document',
  'replace_blocks',
  'replace_selection',
  'accept_changes',
  'reject_changes',
  'reply_comment',
  'resolve_comment',
  'insert_footnote',
  'insert_endnote',
  'delete_note',
  'edit_note',
  'add_comment',
  'delete_comment',
  'insert_image',
  'insert_picture',
  'generate_image',
  'insert_chart',
  'edit_chart',
  'set_header_footer',
  'create_document',
  'set_page_setup',
  'insert_section_break',
  'define_style',
  'set_watermark',
  'insert_text_box',
])

const EN_MODIFICATION_CLAIM =
  /\b(?:I(?:'ve| have)? (?:now |already |just )?(?:updated|edited|formatted|deleted|replaced|applied|inserted|modified|styled|adjusted|completed|changed|configured)|(?:The|This) (?:document|text|paragraph|heading|formatting|document layout) (?:has been|was|is now) (?:updated|edited|formatted|deleted|replaced|applied|inserted|modified|styled|changed)|I have (?:successfully )?(?:made|applied) the (?:requested )?(?:changes|formatting|edits))\b/i

const VI_MODIFICATION_CLAIM =
  /(?:(?:tôi|mình|chúng tôi)\s+(?:đã|vừa)\s+[^。．.!！?？,\n]{0,25}?(?:định dạng|chỉnh sửa|cập nhật|thay thế|xóa|áp dụng|thêm|chèn|tạo|thiết lập|hoàn tất|hoàn thành)|(?:văn bản|tài liệu|đoạn văn|tiêu đề|trang)\s+đã\s+được\s+[^。．.!！?？,\n]{0,25}?(?:định dạng|chỉnh sửa|cập nhật|thay thế|xóa|áp dụng|thêm|chèn|thiết lập|thay đổi)|(?:^|[^\p{L}\p{N}])(?:đã|vừa)\s+[^。．.!！?？,\n]{0,25}?(?:định dạng|cập nhật|chỉnh sửa|thay thế|áp dụng|thiết lập)\s+xong)/iu

const ZH_MODIFICATION_CLAIM =
  /(?:已[^。．.!！?？，,;；:：\n]{0,8}?(?:修改|更新|删除|替換|替换|应用|格式化|完成|调整|調整|插入|设置|設置|排版)(?!的)|(?:文档|文本|段落|格式)\s*已(?:成功)?(?:更新|修改|调整|调整完成|排版完成|格式化))/u

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

/** verifyResponse implementation for the docs skill; returns corrective string or null. */
export function verifyDocsResponse(
  finalText: string,
  executed: readonly ExecutedToolCall[],
): string | null {
  if (!claimsDocModification(finalText)) return null
  const anySuccess = executed.some((call) => DOCS_MUTATING_TOOLS.has(call.name) && call.ok)
  if (anySuccess) return null
  return DOCS_CLAIM_CORRECTION
}
