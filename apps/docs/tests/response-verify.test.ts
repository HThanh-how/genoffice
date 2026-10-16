import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { AgentLoop, type AgentStreamCallbacks, type AgentTransport } from '@genoffice/agent-core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { createDocsSkill } from '../src/renderer/ai/docs-skill'
import type { AiDocExtras } from '../src/renderer/ai/tools'
import {
  claimsDocModification,
  verifyDocsResponse,
  fallbackDocsResponse,
  getClaimedSpecificEffects,
  DOCS_CLAIM_CORRECTION,
  DOCS_MUTATING_TOOLS,
} from '../src/renderer/ai/response-verify'

interface JsonNode {
  type: string
  attrs?: Record<string, unknown>
  content?: JsonNode[]
  text?: string
}

const text = (t: string): JsonNode => ({ type: 'text', text: t })
const para = (t: string): JsonNode => ({
  type: 'docParagraph',
  attrs: { docxIndex: null },
  content: [text(t)],
})

const liveEditors: Editor[] = []

function createEditor(content: JsonNode[]): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: { type: 'doc', content },
  })
  liveEditors.push(editor)
  return editor
}

afterEach(() => {
  for (const editor of liveEditors.splice(0)) editor.destroy()
})

function scriptedTransport(script: Array<(cb: AgentStreamCallbacks) => void>): AgentTransport & {
  requests: unknown[]
} {
  let turn = 0
  const requests: unknown[] = []
  return {
    requests,
    stream(request, cb) {
      requests.push(request)
      const step = script[turn++]
      if (step) queueMicrotask(() => step(cb))
      return { cancel: () => queueMicrotask(() => cb.onDone()) }
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const NUM_IDS = { bullet: null, ordered: null }

describe('claimsDocModification', () => {
  it('detects Vietnamese editing and formatting claims', () => {
    expect(
      claimsDocModification(
        'Tôi đã định dạng lại văn bản theo chuẩn thể thức văn bản hành chính Việt Nam.',
      ),
    ).toBe(true)
    expect(claimsDocModification('Mình đã cập nhật font chữ thành Times New Roman 13pt.')).toBe(
      true,
    )
    expect(claimsDocModification('Văn bản đã được chỉnh sửa theo yêu cầu của bạn.')).toBe(true)
    expect(claimsDocModification('Đã thiết lập xong căn lề trang.')).toBe(true)
    expect(claimsDocModification('Đã tạo tài liệu mới.')).toBe(true)
    expect(claimsDocModification('Tài liệu mới đã được tạo.')).toBe(true)
    expect(claimsDocModification('Tôi đã tạo tài liệu mới.')).toBe(true)
  })

  it('detects English editing and formatting claims', () => {
    expect(claimsDocModification('I have updated the document formatting as requested.')).toBe(true)
    expect(claimsDocModification("I've formatted the paragraphs with 1.15 line spacing.")).toBe(
      true,
    )
    expect(claimsDocModification('The document has been formatted with Decree 30 margins.')).toBe(
      true,
    )
    expect(claimsDocModification('I have applied the requested changes.')).toBe(true)
    expect(claimsDocModification('The new document has been created.')).toBe(true)
    expect(claimsDocModification('A new document was created.')).toBe(true)
    expect(claimsDocModification('I created a new document.')).toBe(true)
  })

  it('detects Chinese editing and formatting claims', () => {
    expect(claimsDocModification('已完成文档排版和格式调整。')).toBe(true)
    expect(claimsDocModification('文档格式已成功更新。')).toBe(true)
    expect(claimsDocModification('已修改段落行距为1.15倍。')).toBe(true)
  })

  it('ignores informational, explanatory, or read-only answers', () => {
    expect(
      claimsDocModification(
        'Theo Nghị định 30/2020/NĐ-CP, lề trên và dưới là 20-25mm, lề trái 30-35mm, lề phải 15-20mm.',
      ),
    ).toBe(false)
    expect(
      claimsDocModification(
        'Here is the summary of the document: it contains three main sections discussing budgeting.',
      ),
    ).toBe(false)
    expect(
      claimsDocModification(
        'To change the margins in GenOffice, you can use the Page Setup dialog from the Layout tab.',
      ),
    ).toBe(false)
    expect(claimsDocModification('文档共有4个标题和12个段落。')).toBe(false)
    expect(claimsDocModification('To create a new document, choose File > New.')).toBe(false)
    expect(claimsDocModification('You can create a new document from the File menu.')).toBe(false)
    expect(claimsDocModification('When you create a new document, choose a template.')).toBe(false)
    expect(claimsDocModification('To generate a new file, open the export dialog.')).toBe(false)
    expect(claimsDocModification('Do you want me to create a new document?')).toBe(false)
    expect(claimsDocModification('I can create a new document if you want.')).toBe(false)
    expect(claimsDocModification('Để tạo tài liệu mới, hãy chọn File > New.')).toBe(false)
  })
})

describe('verifyDocsResponse unit tests', () => {
  it('returns correction when reply claims modification but no mutating tools executed', () => {
    const correction = verifyDocsResponse(
      'Tôi đã định dạng lại văn bản theo chuẩn thể thức văn bản hành chính Việt Nam.',
      [],
    )
    expect(correction).toBe(DOCS_CLAIM_CORRECTION)
  })

  it('returns correction when mutating tool failed (ok: false)', () => {
    const correction = verifyDocsResponse('I have updated the document formatting as requested.', [
      { name: 'apply_ops', ok: false },
    ])
    expect(correction).toBe(DOCS_CLAIM_CORRECTION)
  })

  it('returns correction when only read-only tools executed', () => {
    const correction = verifyDocsResponse('Đã định dạng xong văn bản.', [
      { name: 'get_document_context', ok: true },
      { name: 'read_blocks', ok: true },
    ])
    expect(correction).toBe(DOCS_CLAIM_CORRECTION)
  })

  it('accepts reply when a mutating tool succeeded (ok: true)', () => {
    const correction = verifyDocsResponse(
      'Tôi đã định dạng lại văn bản theo chuẩn thể thức văn bản hành chính Việt Nam.',
      [{ name: 'apply_ops', ok: true }],
    )
    expect(correction).toBeNull()
  })

  it('accepts reply on partial success when at least one mutating tool succeeded', () => {
    const correction = verifyDocsResponse(
      'I have formatted the document, though some blocks could not be updated.',
      [
        { name: 'set_page_setup', ok: false },
        { name: 'apply_ops', ok: true },
      ],
    )
    expect(correction).toBeNull()
  })

  it('accepts read-only and informational responses without tools', () => {
    const correction = verifyDocsResponse('Tài liệu bao gồm 2 trang với 3 đề mục chính.', [])
    expect(correction).toBeNull()
  })

  it('covers core document-mutating tools', () => {
    expect(DOCS_MUTATING_TOOLS.has('apply_ops')).toBe(true)
    expect(DOCS_MUTATING_TOOLS.has('insert_content')).toBe(true)
    expect(DOCS_MUTATING_TOOLS.has('set_page_setup')).toBe(true)
    expect(DOCS_MUTATING_TOOLS.has('get_document_context')).toBe(false)
    expect(DOCS_MUTATING_TOOLS.has('read_blocks')).toBe(false)
  })

  it('rejects claim when apply_ops ran with dryRun: true (mutated: false)', () => {
    const correction = verifyDocsResponse(
      'Tôi đã định dạng lại văn bản theo chuẩn thể thức văn bản hành chính Việt Nam.',
      [{ name: 'apply_ops', ok: true, mutated: false, input: { dryRun: true } }],
    )
    expect(correction).toBe(DOCS_CLAIM_CORRECTION)
  })

  it('rejects claim when apply_ops matched zero blocks (mutated: false)', () => {
    const correction = verifyDocsResponse(
      'Tôi đã định dạng lại văn bản theo chuẩn thể thức văn bản hành chính Việt Nam.',
      [{ name: 'apply_ops', ok: true, mutated: false }],
    )
    expect(correction).toBe(DOCS_CLAIM_CORRECTION)
  })

  it('accepts claim when apply_ops actually mutated document (mutated: true)', () => {
    const correction = verifyDocsResponse(
      'Tôi đã định dạng lại văn bản theo chuẩn thể thức văn bản hành chính Việt Nam.',
      [{ name: 'apply_ops', ok: true, mutated: true }],
    )
    expect(correction).toBeNull()
  })

  it('rejects paragraph formatting claim when only comments succeeded', () => {
    const correction = verifyDocsResponse('I have formatted the paragraphs as requested.', [
      { name: 'apply_ops', ok: false },
      { name: 'reply_comment', ok: true, mutated: true },
    ])
    expect(correction).toContain('reply_comment')
    expect(correction).toContain('content')
  })

  it('accepts truthful page setup claim when set_page_setup succeeded', () => {
    const viCorrection = verifyDocsResponse('Đã thiết lập xong căn lề trang.', [
      { name: 'set_page_setup', ok: true, mutated: false },
    ])
    expect(viCorrection).toBeNull()

    const enCorrection = verifyDocsResponse(
      'The document has been formatted with Decree 30 margins.',
      [{ name: 'set_page_setup', ok: true, mutated: false }],
    )
    expect(enCorrection).toBeNull()
  })

  it('accepts metadata-only changes when matching metadata tool succeeded', () => {
    const wmCorrection = verifyDocsResponse('Watermark has been added to the document.', [
      { name: 'set_watermark', ok: true, mutated: false },
    ])
    expect(wmCorrection).toBeNull()

    const styleCorrection = verifyDocsResponse(
      'Style definition for CustomHeading has been updated.',
      [{ name: 'define_style', ok: true, mutated: false }],
    )
    expect(styleCorrection).toBeNull()

    // Rejects content formatting claim if only metadata succeeded
    const mismatchCorrection = verifyDocsResponse(
      'I have formatted the paragraphs and updated fonts.',
      [{ name: 'set_watermark', ok: true, mutated: false }],
    )
    expect(mismatchCorrection).toContain('set_watermark')
    expect(mismatchCorrection).toContain('content')
  })

  it('accepts all creation claim variants when create_document actually succeeded', () => {
    const creationClaims = [
      'The new document has been created.',
      'A new document was created.',
      'Đã tạo tài liệu mới.',
      'Tài liệu mới đã được tạo.',
      'Tôi đã tạo tài liệu mới.',
      'I created a new document.',
      '已创建新文档。',
      '新文档已创建。',
    ]
    for (const claim of creationClaims) {
      const res = verifyDocsResponse(claim, [{ name: 'create_document', ok: true, mutated: false }])
      expect(res).toBeNull()
    }
  })

  it('rejects all creation claim variants when create_document failed', () => {
    const creationClaims = [
      'The new document has been created.',
      'A new document was created.',
      'Đã tạo tài liệu mới.',
      'Tài liệu mới đã được tạo.',
      'Tôi đã tạo tài liệu mới.',
      'I created a new document.',
      '已创建新文档。',
      '新文档已创建。',
    ]
    for (const claim of creationClaims) {
      const res = verifyDocsResponse(claim, [
        { name: 'create_document', ok: false, mutated: false },
      ])
      expect(res).toBe(DOCS_CLAIM_CORRECTION)
    }
  })

  it('rejects all creation claim variants when create_document was never called', () => {
    const creationClaims = [
      'The new document has been created.',
      'A new document was created.',
      'Đã tạo tài liệu mới.',
      'Tài liệu mới đã được tạo.',
      'Tôi đã tạo tài liệu mới.',
      'I created a new document.',
      '已创建新文档。',
      '新文档已创建。',
    ]
    for (const claim of creationClaims) {
      const res = verifyDocsResponse(claim, [])
      expect(res).toBe(DOCS_CLAIM_CORRECTION)
    }
  })

  it('rejects all creation claim variants when only unrelated tools succeeded', () => {
    const creationClaims = [
      'The new document has been created.',
      'A new document was created.',
      'Đã tạo tài liệu mới.',
      'Tài liệu mới đã được tạo.',
      'Tôi đã tạo tài liệu mới.',
      'I created a new document.',
      '已创建新文档。',
      '新文档已创建。',
    ]
    for (const claim of creationClaims) {
      // Unrelated metadata tool (set_watermark)
      const resWm = verifyDocsResponse(claim, [{ name: 'set_watermark', ok: true, mutated: false }])
      expect(resWm).toContain('set_watermark')
      expect(resWm).toContain('new_document')

      // Unrelated content tool (apply_ops)
      const resOps = verifyDocsResponse(claim, [{ name: 'apply_ops', ok: true, mutated: true }])
      expect(resOps).toContain('apply_ops')
      expect(resOps).toContain('new_document')

      // Unrelated comment tool (reply_comment)
      const resComment = verifyDocsResponse(claim, [
        { name: 'reply_comment', ok: true, mutated: false },
      ])
      expect(resComment).toContain('reply_comment')
      expect(resComment).toContain('new_document')
    }
  })

  it('accepts instructional, hypothetical, and explanatory creation responses without tools', () => {
    const instructional = [
      'To create a new document, choose File > New.',
      'You can create a new document from the File menu.',
      'When you create a new document, choose a template.',
      'To generate a new file, open the export dialog.',
      'Do you want me to create a new document?',
      'I can create a new document if you want.',
      'Để tạo tài liệu mới, hãy chọn File > New.',
      '如何创建新文档：点击文件 > 新建。',
      '你可以创建新文档。',
      '要创建新文件，请选择模板。',
    ]
    for (const statement of instructional) {
      expect(verifyDocsResponse(statement, [])).toBeNull()
    }
  })

  it('verifies completed style-definition claims against define_style execution', () => {
    const styleClaims = [
      'I defined a new style definition for headings.',
      'I have defined the CustomHeading style.',
      'Style definition for CustomHeading has been updated.',
      'Tôi đã định nghĩa kiểu định dạng Heading 1.',
      'Đã tạo kiểu định dạng mới cho tiêu đề.',
      'I defined a Heading 1 style for paragraphs.',
      '已定义新样式。',
      '新样式已成功创建。',
      '定义了新样式。',
    ]
    for (const claim of styleClaims) {
      // Success => accepted
      expect(
        verifyDocsResponse(claim, [{ name: 'define_style', ok: true, mutated: false }]),
      ).toBeNull()

      // Failure => rejected
      expect(verifyDocsResponse(claim, [{ name: 'define_style', ok: false, mutated: false }])).toBe(
        DOCS_CLAIM_CORRECTION,
      )

      // No tools => rejected
      expect(verifyDocsResponse(claim, [])).toBe(DOCS_CLAIM_CORRECTION)

      // Unrelated tool => rejected with dynamic correction acknowledging the tool
      expect(
        verifyDocsResponse(claim, [{ name: 'set_watermark', ok: true, mutated: false }]),
      ).toContain('set_watermark')
      expect(verifyDocsResponse(claim, [{ name: 'apply_ops', ok: true, mutated: true }])).toContain(
        'apply_ops',
      )
    }
  })

  it('distinguishes pure style definitions from content formatting and combined claims', () => {
    // Formatting existing headings requires content mutation
    expect(
      verifyDocsResponse('I formatted the headings.', [
        { name: 'define_style', ok: true, mutated: false },
      ]),
    ).toContain('define_style')

    expect(
      verifyDocsResponse('I formatted the headings.', [
        { name: 'apply_ops', ok: true, mutated: true },
      ]),
    ).toBeNull()

    expect(
      verifyDocsResponse('I formatted the headings.', [
        { name: 'apply_ops', ok: true, mutated: false },
      ]),
    ).toBe(DOCS_CLAIM_CORRECTION)

    // Combined claim requires BOTH define_style AND content mutation
    const combined = 'I defined a style and formatted paragraphs.'
    expect(
      verifyDocsResponse(combined, [{ name: 'define_style', ok: true, mutated: false }]),
    ).toContain('define_style')

    expect(
      verifyDocsResponse(combined, [{ name: 'apply_ops', ok: true, mutated: true }]),
    ).toContain('apply_ops')

    expect(
      verifyDocsResponse(combined, [
        { name: 'define_style', ok: true, mutated: false },
        { name: 'apply_ops', ok: true, mutated: true },
      ]),
    ).toBeNull()

    // Informational style explanation does not require tools
    expect(verifyDocsResponse('To define a new style, open the Styles panel.', [])).toBeNull()

    expect(verifyDocsResponse('I can define a new style for your headings.', [])).toBeNull()

    // Chinese instructional style explanations do not require tools
    expect(verifyDocsResponse('若要在文档中设置样式，请打开样式面板。', [])).toBeNull()
    expect(verifyDocsResponse('你可以为段落定义样式。', [])).toBeNull()
    expect(verifyDocsResponse('如何创建样式：', [])).toBeNull()
    expect(verifyDocsResponse('在 GenOffice 中，您可以轻松创建新样式。', [])).toBeNull()
    expect(verifyDocsResponse('要定义新样式，请打开样式面板。', [])).toBeNull()

    // Explicit failure report does not claim completed modification
    expect(
      verifyDocsResponse('I could not define the new style.', [
        { name: 'define_style', ok: false, mutated: false },
      ]),
    ).toBeNull()
  })

  it('rejects false current document formatting claim when only create_document succeeded', () => {
    const enRes = verifyDocsResponse('I formatted the current document.', [
      { name: 'create_document', ok: true, mutated: false },
    ])
    expect(enRes).toContain('create_document')
    expect(enRes).toContain('content')

    const viRes = verifyDocsResponse('Tôi đã định dạng lại văn bản.', [
      { name: 'create_document', ok: true, mutated: false },
    ])
    expect(viRes).toContain('create_document')
    expect(viRes).toContain('content')
  })

  it('rejects false new document creation claim when only apply_ops succeeded on current document', () => {
    const viRes = verifyDocsResponse('Tôi đã tạo tài liệu mới.', [
      { name: 'apply_ops', ok: true, mutated: true },
    ])
    expect(viRes).toContain('apply_ops')
    expect(viRes).toContain('new_document')

    const enRes = verifyDocsResponse('I created a new document.', [
      { name: 'apply_ops', ok: true, mutated: true },
    ])
    expect(enRes).toContain('apply_ops')
    expect(enRes).toContain('new_document')
  })

  it('enforces specific claim-to-effect matching across metadata tools', () => {
    // watermark success + false margins claim => rejected with dynamic prompt
    const wmToMargins = verifyDocsResponse('I have updated the page margins.', [
      { name: 'set_watermark', ok: true, mutated: false },
    ])
    expect(wmToMargins).toContain('set_watermark')
    expect(wmToMargins).toContain('page_setup')

    // margins success + truthful margins claim => accepted
    const marginsTruth = verifyDocsResponse('I have updated the page margins.', [
      { name: 'set_page_setup', ok: true, mutated: false },
    ])
    expect(marginsTruth).toBeNull()

    // header/footer success + false watermark claim => rejected with dynamic prompt
    const hfToWm = verifyDocsResponse('I added a watermark to the document.', [
      { name: 'set_header_footer', ok: true, mutated: false },
    ])
    expect(hfToWm).toContain('set_header_footer')
    expect(hfToWm).toContain('watermark')

    // style definition success + truthful style claim => accepted
    const styleTruth = verifyDocsResponse('I defined a new style definition for headings.', [
      { name: 'define_style', ok: true, mutated: false },
    ])
    expect(styleTruth).toBeNull()

    // comment success + false formatting claim => rejected with dynamic prompt
    const commentToFmt = verifyDocsResponse('Tôi đã định dạng lại các đoạn văn.', [
      { name: 'reply_comment', ok: true, mutated: false },
    ])
    expect(commentToFmt).toContain('reply_comment')
    expect(commentToFmt).toContain('content')

    // content change success + false page setup claim => rejected with dynamic prompt
    const contentToMargins = verifyDocsResponse('Tôi đã căn lề trang thành 3cm.', [
      { name: 'apply_ops', ok: true, mutated: true },
    ])
    expect(contentToMargins).toContain('apply_ops')
    expect(contentToMargins).toContain('page_setup')

    // multiple successful tools + accurate combined claim => accepted
    const combinedTruth = verifyDocsResponse('I updated the page margins and added a watermark.', [
      { name: 'set_page_setup', ok: true, mutated: false },
      { name: 'set_watermark', ok: true, mutated: false },
    ])
    expect(combinedTruth).toBeNull()

    // partial success + accurate partial completion message => accepted
    const partialExplanation = verifyDocsResponse(
      'I added the watermark, but updating the page margins failed.',
      [
        { name: 'set_watermark', ok: true, mutated: false },
        { name: 'set_page_setup', ok: false, mutated: false },
      ],
    )
    expect(partialExplanation).toBeNull()

    const partialExplanationVi = verifyDocsResponse(
      'Đã thêm hình mờ thành công, tuy nhiên căn lề trang thất bại.',
      [
        { name: 'set_watermark', ok: true, mutated: false },
        { name: 'set_page_setup', ok: false, mutated: false },
      ],
    )
    expect(partialExplanationVi).toBeNull()

    // informational response mentioning margins without claiming a modification => accepted
    const infoOnly = verifyDocsResponse('The current page margins are 2.5cm on all sides.', [])
    expect(infoOnly).toBeNull()
  })
})

describe('fallbackDocsResponse unit tests', () => {
  it('produces accurate partial success fallback message', () => {
    const fallback = fallbackDocsResponse('I have updated the document.', [
      { name: 'set_page_setup', ok: true, mutated: false },
      { name: 'apply_ops', ok: false, output: 'op execution failed: target not found' },
    ])
    expect(fallback).toContain('partially completed')
    expect(fallback).toContain('set_page_setup')
    expect(fallback).toContain('apply_ops')
    expect(fallback).toContain('target not found')
  })

  it('produces accurate dry-run fallback message', () => {
    const fallback = fallbackDocsResponse('Tôi đã định dạng lại văn bản.', [
      { name: 'apply_ops', ok: true, mutated: false, input: { dryRun: true } },
    ])
    expect(fallback).toContain('dryRun')
  })

  it('produces accurate zero-changed fallback message', () => {
    const fallback = fallbackDocsResponse('Tôi đã định dạng lại văn bản.', [
      { name: 'apply_ops', ok: true, mutated: false },
    ])
    expect(fallback).toContain('Không có thay đổi nào được áp dụng')
  })

  it('handles Case 1: read_blocks succeeds, apply_ops fails => editing failed, not partial editing success', () => {
    const fallback = fallbackDocsResponse('I updated the document.', [
      { name: 'read_blocks', ok: true, mutated: false },
      { name: 'apply_ops', ok: false, output: 'Syntax error in ops' },
    ])
    expect(fallback).not.toContain('partially completed')
    expect(fallback).not.toContain('read_blocks')
    expect(fallback).toContain('could not be completed')
    expect(fallback).toContain('apply_ops')
    expect(fallback).toContain('Syntax error in ops')
  })

  it('handles Case 2: apply_ops dryRun succeeds, apply_ops fails => no applied modification', () => {
    const fallback = fallbackDocsResponse('I updated the document.', [
      { name: 'apply_ops', ok: true, mutated: false, input: { dryRun: true } },
      { name: 'apply_ops', ok: false, output: 'Invalid block target' },
    ])
    expect(fallback).not.toContain('partially completed')
    expect(fallback).toContain('could not be completed')
    expect(fallback).toContain('apply_ops')
  })

  it('handles Case 3: apply_ops changed=0, another apply_ops fails => no applied modification', () => {
    const fallback = fallbackDocsResponse('I updated the document.', [
      { name: 'apply_ops', ok: true, mutated: false },
      { name: 'apply_ops', ok: false, output: 'Block out of range' },
    ])
    expect(fallback).not.toContain('partially completed')
    expect(fallback).toContain('could not be completed')
    expect(fallback).toContain('apply_ops')
  })

  it('handles Case 4: set_page_setup succeeds, apply_ops fails => legitimate partial success, identify both effects', () => {
    const fallback = fallbackDocsResponse('I updated the document.', [
      { name: 'set_page_setup', ok: true, mutated: false },
      { name: 'apply_ops', ok: false, output: 'Failed to format paragraph' },
    ])
    expect(fallback).toContain('partially completed')
    expect(fallback).toContain('set_page_setup')
    expect(fallback).toContain('apply_ops')
    expect(fallback).toContain('Failed to format paragraph')
  })

  it('handles Case 5: reply_comment succeeds, apply_ops fails => comment succeeded, formatting failed', () => {
    const fallback = fallbackDocsResponse('I updated the document.', [
      { name: 'reply_comment', ok: true, mutated: false },
      { name: 'apply_ops', ok: false, output: 'No blocks matched' },
    ])
    expect(fallback).toContain('partially completed')
    expect(fallback).toContain('reply_comment')
    expect(fallback).toContain('apply_ops')
  })

  it('handles Case 6: create_document succeeds, apply_ops fails => new document created, current document edit failed', () => {
    const fallback = fallbackDocsResponse('I updated the document.', [
      { name: 'create_document', ok: true, mutated: false },
      { name: 'apply_ops', ok: false, output: 'Failed to write content' },
    ])
    expect(fallback).toContain('partially completed')
    expect(fallback).toContain('create_document')
    expect(fallback).toContain('apply_ops')
  })

  it('handles Case 7: all modifying tools fail => clear failure', () => {
    const fallback = fallbackDocsResponse('I updated the document.', [
      { name: 'apply_ops', ok: false, output: 'Fatal execution error' },
      { name: 'set_page_setup', ok: false, output: 'Invalid margin parameter' },
    ])
    expect(fallback).not.toContain('partially completed')
    expect(fallback).toContain('could not be completed')
    expect(fallback).toContain('apply_ops')
    expect(fallback).toContain('set_page_setup')
  })

  it('handles Case 8: no tools executed => no modification claim permitted', () => {
    const fallback = fallbackDocsResponse('I updated the document.', [])
    expect(fallback).toContain('no document-modifying tools were invoked')
  })
})

describe('AgentLoop + Docs skill completion claim guard integration', () => {
  it('detects false completion claim on tool error and forces corrective turn', async () => {
    const editor = createEditor([para('Văn bản hành chính')])
    const transport = scriptedTransport([
      // Turn 1: Model calls apply_ops with invalid op, which fails
      (cb) => {
        cb.onToolCall({
          id: 'call_1',
          name: 'apply_ops',
          input: {
            ops: [
              {
                op: 'non_existent_op_for_test',
              },
            ],
          },
        })
        cb.onDone()
      },
      // Turn 2: Model falsely claims formatting succeeded despite the error
      (cb) => {
        cb.onDelta('Tôi đã định dạng lại văn bản theo chuẩn thể thức văn bản hành chính Việt Nam.')
        cb.onDone()
      },
      // Turn 3 (Corrective turn): Model receives [System check] and admits the failure
      (cb) => {
        cb.onDelta(
          'Không thể định dạng văn bản do thao tác gặp lỗi (chỉ số đoạn văn không tồn tại). Vui lòng thử lại.',
        )
        cb.onDone()
      },
    ])

    let finalAnswer = ''
    const loop = new AgentLoop({
      transport,
      skill: createDocsSkill(
        () => editor,
        () => NUM_IDS,
      ),
      events: { onDone: (r) => (finalAnswer = r.text) },
    })

    loop.run('Định dạng văn bản theo Nghị định 30')
    for (let i = 0; i < 8; i++) await flush()

    // The false claim was detected and intercepted; corrective turn produced the final answer
    expect(finalAnswer).toContain('Không thể định dạng văn bản do thao tác gặp lỗi')
    expect(finalAnswer).not.toContain('Tôi đã định dạng lại văn bản theo chuẩn')

    // History verifies that [System check] was inserted between the false claim and the correction
    const messages = loop.messages
    expect(messages.some((m) => m.role === 'user' && m.text.includes('[System check]'))).toBe(true)
  })

  it('allows completion message when tool executes successfully', async () => {
    const editor = createEditor([para('Văn bản hành chính')])
    const transport = scriptedTransport([
      // Turn 1: Model calls apply_ops successfully
      (cb) => {
        cb.onToolCall({
          id: 'call_1',
          name: 'apply_ops',
          input: {
            ops: [
              {
                op: 'setParagraphFormat',
                target: { blockIndexes: [0] },
                align: 'center',
              },
            ],
          },
        })
        cb.onDone()
      },
      // Turn 2: Model claims formatting succeeded
      (cb) => {
        cb.onDelta('Tôi đã định dạng lại văn bản theo chuẩn thể thức văn bản hành chính Việt Nam.')
        cb.onDone()
      },
    ])

    let finalAnswer = ''
    const loop = new AgentLoop({
      transport,
      skill: createDocsSkill(
        () => editor,
        () => NUM_IDS,
      ),
      events: { onDone: (r) => (finalAnswer = r.text) },
    })

    loop.run('Căn giữa đoạn 0')
    for (let i = 0; i < 6; i++) await flush()

    expect(finalAnswer).toBe(
      'Tôi đã định dạng lại văn bản theo chuẩn thể thức văn bản hành chính Việt Nam.',
    )
    expect(editor.state.doc.child(0).attrs.align).toBe('center')
  })

  it('allows completion message on partial success when at least one mutating tool succeeds', async () => {
    const editor = createEditor([para('Đoạn văn')])
    const transport = scriptedTransport([
      // Turn 1: Two tools called: first fails, second succeeds
      (cb) => {
        cb.onToolCall({
          id: 'call_fail',
          name: 'apply_ops',
          input: { ops: [{ op: 'non_existent_op' }] },
        })
        cb.onToolCall({
          id: 'call_ok',
          name: 'apply_ops',
          input: {
            ops: [{ op: 'setFont', target: { blockIndexes: [0] }, bold: true }],
          },
        })
        cb.onDone()
      },
      // Turn 2: Model explains partial success
      (cb) => {
        cb.onDelta('I have applied the bold formatting to the document, but the custom op failed.')
        cb.onDone()
      },
    ])

    let finalAnswer = ''
    const loop = new AgentLoop({
      transport,
      skill: createDocsSkill(
        () => editor,
        () => NUM_IDS,
      ),
      events: { onDone: (r) => (finalAnswer = r.text) },
    })

    loop.run('Apply formatting')
    for (let i = 0; i < 6; i++) await flush()

    expect(finalAnswer).toBe(
      'I have applied the bold formatting to the document, but the custom op failed.',
    )
  })

  it('allows read-only request without triggering claim guard', async () => {
    const editor = createEditor([para('Báo cáo doanh thu quý 3')])
    const transport = scriptedTransport([
      // Turn 1: Model reads blocks
      (cb) => {
        cb.onToolCall({ id: 'call_read', name: 'read_blocks', input: { blockIndexes: [0] } })
        cb.onDone()
      },
      // Turn 2: Model summarizes
      (cb) => {
        cb.onDelta('Tài liệu là một bản báo cáo doanh thu quý 3.')
        cb.onDone()
      },
    ])

    let finalAnswer = ''
    const loop = new AgentLoop({
      transport,
      skill: createDocsSkill(
        () => editor,
        () => NUM_IDS,
      ),
      events: { onDone: (r) => (finalAnswer = r.text) },
    })

    loop.run('Tài liệu nói về cái gì?')
    for (let i = 0; i < 6; i++) await flush()

    expect(finalAnswer).toBe('Tài liệu là một bản báo cáo doanh thu quý 3.')
  })

  it('allows no-tool informational request without triggering claim guard', async () => {
    const editor = createEditor([para('Nội dung')])
    const transport = scriptedTransport([
      (cb) => {
        cb.onDelta('Theo Nghị định 30, kích thước trang chuẩn là A4 (210mm x 297mm).')
        cb.onDone()
      },
    ])

    let finalAnswer = ''
    const loop = new AgentLoop({
      transport,
      skill: createDocsSkill(
        () => editor,
        () => NUM_IDS,
      ),
      events: { onDone: (r) => (finalAnswer = r.text) },
    })

    loop.run('Quy định khổ giấy là gì?')
    for (let i = 0; i < 4; i++) await flush()

    expect(finalAnswer).toBe('Theo Nghị định 30, kích thước trang chuẩn là A4 (210mm x 297mm).')
  })

  it('enforces verification retry limits and does not loop infinitely', async () => {
    const editor = createEditor([para('Nội dung')])
    const transport = scriptedTransport([
      // Turn 1: Tool fails
      (cb) => {
        cb.onToolCall({
          id: 'call_1',
          name: 'apply_ops',
          input: { ops: [{ op: 'unknown_op' }] },
        })
        cb.onDone()
      },
      // Turn 2: Model falsely claims success
      (cb) => {
        cb.onDelta('Tôi đã định dạng lại văn bản.')
        cb.onDone()
      },
      // Turn 3: Model receives [System check] but stubbornly repeats the claim
      (cb) => {
        cb.onDelta('Tôi đã định dạng lại văn bản.')
        cb.onDone()
      },
    ])

    let doneCount = 0
    let finalAnswer = ''
    let lastStreamedText = ''
    const loop = new AgentLoop({
      transport,
      skill: createDocsSkill(
        () => editor,
        () => NUM_IDS,
      ),
      events: {
        onText: (t) => {
          lastStreamedText = t
        },
        onDone: (r) => {
          doneCount++
          finalAnswer = r.text
        },
      },
    })

    loop.run('Format document')
    for (let i = 0; i < 8; i++) await flush()

    // AgentLoop enforces verifyRetryUsed: only 1 corrective turn attempted
    expect(doneCount).toBe(1)
    expect(transport.requests.length).toBe(3)
    // The repeated false claim is replaced with truthful fallback
    expect(finalAnswer).not.toBe('Tôi đã định dạng lại văn bản.')
    expect(finalAnswer).toContain(
      'Không thể hoàn tất thao tác do các công cụ thực hiện không thành công',
    )
    expect(finalAnswer).toContain('apply_ops')
    expect(finalAnswer).toContain('unknown op "unknown_op"')
    // Chat UI text was updated with final fallback
    expect(lastStreamedText).toBe(finalAnswer)
  })

  it('intercepts apply_ops dryRun and produces truthful fallback on repeated claim', async () => {
    const editor = createEditor([para('Nội dung')])
    const transport = scriptedTransport([
      // Turn 1: Tool runs with dryRun: true
      (cb) => {
        cb.onToolCall({
          id: 'call_dry',
          name: 'apply_ops',
          input: {
            dryRun: true,
            ops: [{ op: 'setFont', target: { blockIndexes: [0] }, bold: true }],
          },
        })
        cb.onDone()
      },
      // Turn 2: Model falsely claims formatting happened
      (cb) => {
        cb.onDelta('Tôi đã định dạng lại văn bản.')
        cb.onDone()
      },
      // Turn 3: Model repeats claim after [System check]
      (cb) => {
        cb.onDelta('Tôi đã định dạng lại văn bản.')
        cb.onDone()
      },
    ])

    let finalAnswer = ''
    const loop = new AgentLoop({
      transport,
      skill: createDocsSkill(
        () => editor,
        () => NUM_IDS,
      ),
      events: { onDone: (r) => (finalAnswer = r.text) },
    })

    loop.run('Format document')
    for (let i = 0; i < 8; i++) await flush()

    expect(transport.requests.length).toBe(3)
    expect(finalAnswer).toContain('dryRun')
  })

  it('intercepts apply_ops changed=0 and forces corrective turn', async () => {
    const editor = createEditor([para('Nội dung')])
    const transport = scriptedTransport([
      // Turn 1: Tool targets non-existent block index 99
      (cb) => {
        cb.onToolCall({
          id: 'call_noop',
          name: 'apply_ops',
          input: {
            ops: [{ op: 'setFont', target: { blockIndexes: [99] }, bold: true }],
          },
        })
        cb.onDone()
      },
      // Turn 2: Model falsely claims formatting happened
      (cb) => {
        cb.onDelta('Tôi đã định dạng lại văn bản.')
        cb.onDone()
      },
      // Turn 3: Model repeats claim
      (cb) => {
        cb.onDelta('Tôi đã định dạng lại văn bản.')
        cb.onDone()
      },
    ])

    let finalAnswer = ''
    const loop = new AgentLoop({
      transport,
      skill: createDocsSkill(
        () => editor,
        () => NUM_IDS,
      ),
      events: { onDone: (r) => (finalAnswer = r.text) },
    })

    loop.run('Format document')
    for (let i = 0; i < 8; i++) await flush()

    expect(transport.requests.length).toBe(3)
    expect(finalAnswer).toContain('Không có thay đổi nào được áp dụng')
  })

  it('rejects false formatting claim when only comments succeeded and formatting failed', async () => {
    const editor = createEditor([para('Nội dung')])
    const mockComments = {
      list: () => [{ id: 'c1', parentId: null, text: 'Hello' }],
      reply: () => true,
    }
    const transport = scriptedTransport([
      // Turn 1: formatting fails, comment reply succeeds
      (cb) => {
        cb.onToolCall({
          id: 'call_fail',
          name: 'apply_ops',
          input: { ops: [{ op: 'unknown_op' }] },
        })
        cb.onToolCall({
          id: 'call_comment',
          name: 'reply_comment',
          input: { parentId: 'c1', text: 'My reply' },
        })
        cb.onDone()
      },
      // Turn 2: Model claims formatting succeeded
      (cb) => {
        cb.onDelta('I have formatted the paragraphs as requested.')
        cb.onDone()
      },
      // Turn 3: Model repeats false formatting claim
      (cb) => {
        cb.onDelta('I have formatted the paragraphs as requested.')
        cb.onDone()
      },
    ])

    let finalAnswer = ''
    const loop = new AgentLoop({
      transport,
      skill: createDocsSkill(
        () => editor,
        () => NUM_IDS,
        undefined,
        () => mockComments as any,
      ),
      events: { onDone: (r) => (finalAnswer = r.text) },
    })

    loop.run('Format document')
    for (let i = 0; i < 8; i++) await flush()

    expect(transport.requests.length).toBe(3)
    expect(finalAnswer).toContain('partially completed')
    expect(finalAnswer).toContain('reply_comment')
    expect(finalAnswer).toContain('apply_ops')
  })

  it('allows truthful create_document completion without extra corrective turns', async () => {
    const editor = createEditor([para('Nội dung')])
    ;(window as any).desktop = {
      createDocument: vi.fn(async () => ({ ok: true, path: '/tmp/new_doc.docx' })),
    }

    const transport = scriptedTransport([
      // Turn 1: tool call create_document
      (cb) => {
        cb.onToolCall({
          id: 'call_create',
          name: 'create_document',
          input: { type: 'docx', title: 'New Doc', content: '<p>Xin chào</p>' },
        })
        cb.onDone()
      },
      // Turn 2: Truthful creation claim
      (cb) => {
        cb.onDelta('Tôi đã tạo tài liệu mới.')
        cb.onDone()
      },
    ])

    let finalAnswer = ''
    let onTextLast = ''
    const loop = new AgentLoop({
      transport,
      skill: createDocsSkill(
        () => editor,
        () => NUM_IDS,
      ),
      events: {
        onText: (t) => (onTextLast = t),
        onDone: (r) => (finalAnswer = r.text),
      },
    })

    loop.run('Tạo văn bản mới')
    for (let i = 0; i < 8; i++) await flush()

    expect(transport.requests.length).toBe(2)
    expect(finalAnswer).toBe('Tôi đã tạo tài liệu mới.')
    expect(onTextLast).toBe('Tôi đã tạo tài liệu mới.')
  })

  it('reports truthful partial completion when create_document succeeds but apply_ops fails', async () => {
    const editor = createEditor([para('Nội dung')])
    ;(window as any).desktop = {
      createDocument: vi.fn(async () => ({ ok: true, path: '/tmp/new_doc.docx' })),
    }

    const transport = scriptedTransport([
      // Turn 1: create_document succeeds, apply_ops fails
      (cb) => {
        cb.onToolCall({
          id: 'call_create',
          name: 'create_document',
          input: { type: 'docx', title: 'New Doc', content: '<p>Xin chào</p>' },
        })
        cb.onToolCall({
          id: 'call_fail',
          name: 'apply_ops',
          input: { ops: [{ op: 'unknown_op' }] },
        })
        cb.onDone()
      },
      // Turn 2: Model falsely claims formatting happened
      (cb) => {
        cb.onDelta('Tôi đã định dạng lại văn bản và tạo tài liệu mới.')
        cb.onDone()
      },
      // Turn 3: Model repeats claim
      (cb) => {
        cb.onDelta('Tôi đã định dạng lại văn bản và tạo tài liệu mới.')
        cb.onDone()
      },
    ])

    let finalAnswer = ''
    let onTextLast = ''
    const loop = new AgentLoop({
      transport,
      skill: createDocsSkill(
        () => editor,
        () => NUM_IDS,
      ),
      events: {
        onText: (t) => (onTextLast = t),
        onDone: (r) => (finalAnswer = r.text),
      },
    })

    loop.run('Tạo tài liệu mới và định dạng văn bản hiện tại')
    for (let i = 0; i < 8; i++) await flush()

    expect(transport.requests.length).toBe(3)
    expect(finalAnswer).toContain('Thao tác được thực hiện một phần')
    expect(finalAnswer).toContain('create_document')
    expect(finalAnswer).toContain('apply_ops')
    expect(onTextLast).toBe(finalAnswer)
  })

  it('does not report read_blocks as partial success when editing fails', async () => {
    const editor = createEditor([para('Nội dung')])
    const transport = scriptedTransport([
      // Turn 1: read_blocks succeeds, apply_ops fails
      (cb) => {
        cb.onToolCall({
          id: 'call_read',
          name: 'read_blocks',
          input: { startBlockIndex: 0, endBlockIndex: 0 },
        })
        cb.onToolCall({
          id: 'call_fail',
          name: 'apply_ops',
          input: { ops: [{ op: 'unknown_op' }] },
        })
        cb.onDone()
      },
      // Turn 2: Model falsely claims formatting
      (cb) => {
        cb.onDelta('I have formatted the document as requested.')
        cb.onDone()
      },
      // Turn 3: Model repeats false formatting claim
      (cb) => {
        cb.onDelta('I have formatted the document as requested.')
        cb.onDone()
      },
    ])

    let finalAnswer = ''
    let onTextLast = ''
    const loop = new AgentLoop({
      transport,
      skill: createDocsSkill(
        () => editor,
        () => NUM_IDS,
      ),
      events: {
        onText: (t) => (onTextLast = t),
        onDone: (r) => (finalAnswer = r.text),
      },
    })

    loop.run('Read and format')
    for (let i = 0; i < 8; i++) await flush()

    expect(transport.requests.length).toBe(3)
    expect(finalAnswer).not.toContain('partially completed')
    expect(finalAnswer).not.toContain('read_blocks')
    expect(finalAnswer).toContain('could not be completed')
    expect(finalAnswer).toContain('apply_ops')
    expect(onTextLast).toBe(finalAnswer)
  })

  it('allows instructional response on how to create a document without triggering claim guard', async () => {
    const editor = createEditor([para('Nội dung')])
    const transport = scriptedTransport([
      (cb) => {
        cb.onDelta('To create a new document, choose File > New from the menu.')
        cb.onDone()
      },
    ])

    let finalAnswer = ''
    const loop = new AgentLoop({
      transport,
      skill: createDocsSkill(
        () => editor,
        () => NUM_IDS,
      ),
      events: { onDone: (r) => (finalAnswer = r.text) },
    })

    loop.run('How do I create a new document?')
    for (let i = 0; i < 4; i++) await flush()

    expect(transport.requests.length).toBe(1)
    expect(finalAnswer).toBe('To create a new document, choose File > New from the menu.')
  })

  it('allows truthful define_style completion without extra corrective turns', async () => {
    const editor = createEditor([para('Nội dung')])
    const mockExtras: AiDocExtras = {
      styles: {
        list: () => [],
        upsert: () => null,
      },
    }

    const transport = scriptedTransport([
      // Turn 1: define_style tool call
      (cb) => {
        cb.onToolCall({
          id: 'call_style',
          name: 'define_style',
          input: {
            styleId: 'CustomHeading',
            type: 'paragraph',
            paragraph: { align: 'center' },
          },
        })
        cb.onDone()
      },
      // Turn 2: Model reports style defined
      (cb) => {
        cb.onDelta('I defined a new style definition for headings.')
        cb.onDone()
      },
    ])

    let finalAnswer = ''
    const loop = new AgentLoop({
      transport,
      skill: createDocsSkill(
        () => editor,
        () => NUM_IDS,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => mockExtras,
      ),
      events: { onDone: (r) => (finalAnswer = r.text) },
    })

    loop.run('Define a new style')
    for (let i = 0; i < 6; i++) await flush()

    expect(transport.requests.length).toBe(2)
    expect(finalAnswer).toBe('I defined a new style definition for headings.')
  })

  it('rejects false paragraph formatting claim when only define_style succeeded', async () => {
    const editor = createEditor([para('Nội dung')])
    const mockExtras: AiDocExtras = {
      styles: {
        list: () => [],
        upsert: () => null,
      },
    }

    const transport = scriptedTransport([
      // Turn 1: define_style tool call
      (cb) => {
        cb.onToolCall({
          id: 'call_style',
          name: 'define_style',
          input: { styleId: 'CustomHeading', type: 'paragraph' },
        })
        cb.onDone()
      },
      // Turn 2: Model falsely claims heading paragraphs were reformatted
      (cb) => {
        cb.onDelta('I formatted the headings.')
        cb.onDone()
      },
      // Turn 3: Model receives [System check] and repeats claim
      (cb) => {
        cb.onDelta('I formatted the headings.')
        cb.onDone()
      },
    ])

    let finalAnswer = ''
    const loop = new AgentLoop({
      transport,
      skill: createDocsSkill(
        () => editor,
        () => NUM_IDS,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => mockExtras,
      ),
      events: { onDone: (r) => (finalAnswer = r.text) },
    })

    loop.run('Define style and format headings')
    for (let i = 0; i < 8; i++) await flush()

    expect(transport.requests.length).toBe(3)
    expect(finalAnswer).not.toBe('I formatted the headings.')
  })
})

describe('Defect A Regression Matrix: truthful fallback when tools succeeded but claim unverified', () => {
  it('A01: watermark success + unsupported margins claim', () => {
    const claim = 'I have updated the page margins.'
    const tools = [{ name: 'set_watermark', ok: true, mutated: false }]
    const res = verifyDocsResponse(claim, tools)
    expect(res).toContain('set_watermark')
    expect(res).toContain('page_setup')
    const fb = fallbackDocsResponse(claim, tools)
    expect(fb).toMatch(/set_watermark/)
    expect(fb).not.toMatch(/no document-modifying tools were executed/i)
    expect(fb).not.toMatch(/no changes were applied/i)
    expect(fb).not.toMatch(/page margins have been updated/i)
  })

  it('A02: create_document success + unsupported formatting claim', () => {
    const claim = 'I formatted the current document.'
    const tools = [{ name: 'create_document', ok: true, mutated: false }]
    const res = verifyDocsResponse(claim, tools)
    expect(res).toContain('create_document')
    expect(res).toContain('content')
    const fb = fallbackDocsResponse(claim, tools)
    expect(fb).toMatch(/create_document/)
    expect(fb).not.toMatch(/no document-modifying tools were executed/i)
    expect(fb).not.toMatch(/no changes were applied/i)
  })

  it('A03: define_style success + unsupported paragraph-format claim', () => {
    const claim = 'I reformatted all existing headings.'
    const tools = [{ name: 'define_style', ok: true, mutated: false }]
    const res = verifyDocsResponse(claim, tools)
    expect(res).toContain('define_style')
    expect(res).toContain('content')
    const fb = fallbackDocsResponse(claim, tools)
    expect(fb).toMatch(/define_style/)
    expect(fb).not.toMatch(/no document-modifying tools were executed/i)
    expect(fb).not.toMatch(/no changes were applied/i)
  })

  it('A04: metadata success + unrelated tool failure', () => {
    const claim = 'I updated the page margins and watermark.'
    const tools = [
      { name: 'set_watermark', ok: true, mutated: false },
      { name: 'set_page_setup', ok: false, mutated: false, output: 'Page setup failed' },
    ]
    const fb = fallbackDocsResponse(claim, tools)
    expect(fb).toMatch(/set_watermark/)
    expect(fb).toMatch(/set_page_setup/)
    expect(fb).not.toMatch(/no document-modifying tools were executed/i)
  })

  it('A05: content mutation success + false metadata claim', () => {
    const claim = 'I added a watermark to the document.'
    const tools = [{ name: 'apply_ops', ok: true, mutated: true }]
    const res = verifyDocsResponse(claim, tools)
    expect(res).toContain('apply_ops')
    expect(res).toContain('watermark')
    const fb = fallbackDocsResponse(claim, tools)
    expect(fb).toMatch(/apply_ops/)
    expect(fb).not.toMatch(/no document-modifying tools were executed/i)
    expect(fb).not.toMatch(/no changes were applied/i)
  })

  it('A06: read_blocks success + failed apply_ops', () => {
    const claim = 'I formatted the paragraphs.'
    const tools = [
      { name: 'read_blocks', ok: true },
      { name: 'apply_ops', ok: false, output: 'Formatting error' },
    ]
    const fb = fallbackDocsResponse(claim, tools)
    expect(fb).toMatch(/apply_ops/)
    expect(fb).not.toMatch(/read_blocks/)
  })

  it('A07: dryRun + failed apply_ops', () => {
    const claim = 'I reformatted the document.'
    const tools = [
      { name: 'apply_ops', ok: true, mutated: false, input: { dryRun: true } },
      { name: 'apply_ops', ok: false, output: 'Execution failure' },
    ]
    const fb = fallbackDocsResponse(claim, tools)
    expect(fb).toMatch(/apply_ops/)
    expect(fb).toMatch(/failed/i)
  })

  it('A08: changed=0 + no actual content mutation', () => {
    const claim = 'I updated the document paragraphs.'
    const tools = [{ name: 'apply_ops', ok: true, mutated: false }]
    const fb = fallbackDocsResponse(claim, tools)
    expect(fb).toMatch(/no matching content or paragraphs/i)
  })

  it('A09: no tools at all', () => {
    const claim = 'I edited the document.'
    const fb = fallbackDocsResponse(claim, [])
    expect(fb).toMatch(/no document-modifying tools were invoked/i)
  })

  it('A10: all tools failed', () => {
    const claim = 'I updated the document.'
    const tools = [
      { name: 'apply_ops', ok: false, output: 'Op error' },
      { name: 'set_page_setup', ok: false, output: 'Setup error' },
    ]
    const fb = fallbackDocsResponse(claim, tools)
    expect(fb).toMatch(/tool execution failed/i)
    expect(fb).toMatch(/apply_ops/)
    expect(fb).toMatch(/set_page_setup/)
  })

  it('A11: multiple independent successful actions, followed by one unsupported claim', () => {
    const claim = 'I updated the page margins.'
    const tools = [
      { name: 'set_watermark', ok: true, mutated: false },
      { name: 'define_style', ok: true, mutated: false },
    ]
    const res = verifyDocsResponse(claim, tools)
    expect(res).toContain('set_watermark')
    expect(res).toContain('define_style')
    expect(res).toContain('page_setup')
    const fb = fallbackDocsResponse(claim, tools)
    expect(fb).toMatch(/set_watermark/)
    expect(fb).toMatch(/define_style/)
    expect(fb).not.toMatch(/no document-modifying tools were executed/i)
  })

  it('A12: truthful partial-success reporting', () => {
    const claim = 'I applied all requested changes.'
    const tools = [
      { name: 'set_watermark', ok: true, mutated: false },
      { name: 'apply_ops', ok: false, output: 'Invalid op' },
    ]
    const fb = fallbackDocsResponse(claim, tools)
    expect(fb).toMatch(/partially completed/i)
    expect(fb).toMatch(/set_watermark/)
    expect(fb).toMatch(/apply_ops/)
  })
})

describe('Defect B Regression Matrix: style claims and content actions', () => {
  it('B01: pure style definition + define_style success => ACCEPT', () => {
    const claim = 'I defined a Heading 1 style for paragraphs.'
    const tools = [{ name: 'define_style', ok: true, mutated: false }]
    expect(verifyDocsResponse(claim, tools)).toBeNull()
  })

  it('B02: pure style definition + apply_ops only => REJECT', () => {
    const claim = 'I defined a Heading 1 style for paragraphs.'
    const tools = [{ name: 'apply_ops', ok: true, mutated: true }]
    const res = verifyDocsResponse(claim, tools)
    expect(res).toContain('apply_ops')
    expect(res).toContain('style_definition')
  })

  it('B03: pure content formatting + define_style only => REJECT', () => {
    const claim = 'I formatted the existing headings.'
    const tools = [{ name: 'define_style', ok: true, mutated: false }]
    const res = verifyDocsResponse(claim, tools)
    expect(res).toContain('define_style')
    expect(res).toContain('content')
  })

  it('B04: pure content formatting + apply_ops mutated:true => ACCEPT', () => {
    const claim = 'I formatted the existing headings.'
    const tools = [{ name: 'apply_ops', ok: true, mutated: true }]
    expect(verifyDocsResponse(claim, tools)).toBeNull()
  })

  it('B05: combined style/content + define_style only => REJECT', () => {
    const claim = 'I defined a Heading style and formatted the existing headings.'
    const tools = [{ name: 'define_style', ok: true, mutated: false }]
    const res = verifyDocsResponse(claim, tools)
    expect(res).toContain('define_style')
    expect(res).toContain('content')
  })

  it('B06: combined style/content + apply_ops only => REJECT', () => {
    const claim = 'I defined a Heading style and formatted the existing headings.'
    const tools = [{ name: 'apply_ops', ok: true, mutated: true }]
    const res = verifyDocsResponse(claim, tools)
    expect(res).toContain('apply_ops')
    expect(res).toContain('style_definition')
  })

  it('B07: combined style/content + both effective tools => ACCEPT', () => {
    const claim = 'I defined a Heading style and formatted the existing headings.'
    const tools = [
      { name: 'define_style', ok: true, mutated: false },
      { name: 'apply_ops', ok: true, mutated: true },
    ]
    expect(verifyDocsResponse(claim, tools)).toBeNull()
  })

  it('B08: updated font size + define_style only => REJECT', () => {
    const claim = 'I defined a Heading style and updated the font size of the document.'
    const tools = [{ name: 'define_style', ok: true, mutated: false }]
    const res = verifyDocsResponse(claim, tools)
    expect(res).toContain('define_style')
    expect(res).toContain('content')
  })

  it('B09: updated font size + both effective tools => ACCEPT', () => {
    const claim = 'I defined a Heading style and updated the font size of the document.'
    const tools = [
      { name: 'define_style', ok: true, mutated: false },
      { name: 'apply_ops', ok: true, mutated: true },
    ]
    expect(verifyDocsResponse(claim, tools)).toBeNull()
  })

  it('B10: set paragraph alignment + define_style only => REJECT', () => {
    const claim = 'I defined a Heading style and set the paragraph alignment to center.'
    const tools = [{ name: 'define_style', ok: true, mutated: false }]
    const res = verifyDocsResponse(claim, tools)
    expect(res).toContain('define_style')
    expect(res).toContain('content')
  })

  it('B11: set paragraph alignment + both effective tools => ACCEPT', () => {
    const claim = 'I defined a Heading style and set the paragraph alignment to center.'
    const tools = [
      { name: 'define_style', ok: true, mutated: false },
      { name: 'apply_ops', ok: true, mutated: true },
    ]
    expect(verifyDocsResponse(claim, tools)).toBeNull()
  })

  it('B12: Vietnamese combined claim + define_style only => REJECT', () => {
    const claim = 'Tôi đã định nghĩa kiểu định dạng Heading 1 và cập nhật cỡ chữ của các đoạn văn.'
    const tools = [{ name: 'define_style', ok: true, mutated: false }]
    const res = verifyDocsResponse(claim, tools)
    expect(res).toContain('define_style')
    expect(res).toContain('content')
  })

  it('B13: Vietnamese combined claim + both effective tools => ACCEPT', () => {
    const claim = 'Tôi đã định nghĩa kiểu định dạng Heading 1 và cập nhật cỡ chữ của các đoạn văn.'
    const tools = [
      { name: 'define_style', ok: true, mutated: false },
      { name: 'apply_ops', ok: true, mutated: true },
    ]
    expect(verifyDocsResponse(claim, tools)).toBeNull()
  })

  it('B14: style definition updated only => ACCEPT with define_style', () => {
    const claim = 'I updated the definition of the Heading style.'
    const tools = [{ name: 'define_style', ok: true, mutated: false }]
    expect(verifyDocsResponse(claim, tools)).toBeNull()
  })

  it('B15: style created but explicitly not applied => ACCEPT with define_style', () => {
    const claim = 'I created a Heading style but did not apply it to the existing paragraphs.'
    const tools = [{ name: 'define_style', ok: true, mutated: false }]
    expect(verifyDocsResponse(claim, tools)).toBeNull()
  })

  it('B16: informational style guidance => ACCEPT without tools', () => {
    const claim = 'To define a Heading style, open Styles in the toolbar.'
    expect(verifyDocsResponse(claim, [])).toBeNull()
  })

  it('B17: successful watermark does not validate content formatting', () => {
    const claim = 'I formatted the headings.'
    const tools = [{ name: 'set_watermark', ok: true, mutated: false }]
    const res = verifyDocsResponse(claim, tools)
    expect(res).toContain('set_watermark')
    expect(res).toContain('content')
  })

  it('B18: successful page_setup does not validate style definition', () => {
    const claim = 'I defined a Heading style.'
    const tools = [{ name: 'set_page_setup', ok: true, mutated: false }]
    const res = verifyDocsResponse(claim, tools)
    expect(res).toContain('set_page_setup')
    expect(res).toContain('style_definition')
  })
})

describe('Defect C Regression Matrix: failure language and affirmative claims', () => {
  it('C01: affirmative watermark + negative margins + unrelated success => REJECT', () => {
    const claim = 'I added a watermark and could not update the page margins.'
    const tools = [{ name: 'reply_comment', ok: true, mutated: false }]
    const res = verifyDocsResponse(claim, tools)
    expect(res).toContain('reply_comment')
    expect(res).toContain('watermark')
  })

  it('C02: affirmative watermark + negative margins + watermark success => ACCEPT', () => {
    const claim = 'I added a watermark and could not update the page margins.'
    const tools = [
      { name: 'set_watermark', ok: true, mutated: false },
      { name: 'set_page_setup', ok: false, mutated: false },
    ]
    expect(verifyDocsResponse(claim, tools)).toBeNull()
  })

  it('C03: negative margins + affirmative watermark + unrelated success => REJECT', () => {
    const claim = 'I could not update the page margins, but I added the watermark.'
    const tools = [{ name: 'reply_comment', ok: true, mutated: false }]
    const res = verifyDocsResponse(claim, tools)
    expect(res).toContain('reply_comment')
    expect(res).toContain('watermark')
  })

  it('C04: negative margins + affirmative watermark + watermark success => ACCEPT', () => {
    const claim = 'I could not update the page margins, but I added the watermark.'
    const tools = [{ name: 'set_watermark', ok: true, mutated: false }]
    expect(verifyDocsResponse(claim, tools)).toBeNull()
  })

  it('C05: affirmative watermark + failed formatting + corresponding partial execution => ACCEPT', () => {
    const claim = 'I added a watermark but failed to format the headings.'
    const tools = [
      { name: 'set_watermark', ok: true, mutated: false },
      { name: 'apply_ops', ok: false, mutated: false },
    ]
    expect(verifyDocsResponse(claim, tools)).toBeNull()
  })

  it('C06: negative creation statement only => ACCEPT as failure report', () => {
    const claim = 'The document was not created.'
    expect(verifyDocsResponse(claim, [])).toBeNull()
  })

  it('C07: negative style definition only => ACCEPT as failure report', () => {
    const claim = 'I could not define the style.'
    expect(verifyDocsResponse(claim, [])).toBeNull()
  })

  it('C08: Vietnamese affirmative + negative mixed clause => correct classification', () => {
    const claim = 'Tôi đã thêm hình mờ nhưng không thể cập nhật căn lề trang.'
    const unrelated = [{ name: 'reply_comment', ok: true, mutated: false }]
    const res = verifyDocsResponse(claim, unrelated)
    expect(res).toContain('reply_comment')
    expect(res).toContain('watermark')
    const correct = [{ name: 'set_watermark', ok: true, mutated: false }]
    expect(verifyDocsResponse(claim, correct)).toBeNull()
  })

  it('C09: Vietnamese negative + affirmative mixed clause => correct classification', () => {
    const claim = 'Tôi chưa cập nhật được căn lề, nhưng đã thêm hình mờ.'
    const unrelated = [{ name: 'reply_comment', ok: true, mutated: false }]
    const res = verifyDocsResponse(claim, unrelated)
    expect(res).toContain('reply_comment')
    expect(res).toContain('watermark')
    const correct = [{ name: 'set_watermark', ok: true, mutated: false }]
    expect(verifyDocsResponse(claim, correct)).toBeNull()
  })

  it('C10: combined legitimate success claims without failure => require all effects', () => {
    const claim = 'I added a watermark and updated the page margins.'
    const onlyWatermark = [{ name: 'set_watermark', ok: true, mutated: false }]
    const res = verifyDocsResponse(claim, onlyWatermark)
    expect(res).toContain('set_watermark')
    expect(res).toContain('page_setup')
    const both = [
      { name: 'set_watermark', ok: true, mutated: false },
      { name: 'set_page_setup', ok: true, mutated: false },
    ]
    expect(verifyDocsResponse(claim, both)).toBeNull()
  })

  it('C11: "bold and italic" must not be treated as two unrelated tool effects', () => {
    const claim = 'I formatted the text with bold and italic styling.'
    const tools = [{ name: 'apply_ops', ok: true, mutated: true }]
    expect(verifyDocsResponse(claim, tools)).toBeNull()
  })

  it('C12: informational response mentioning a previous failure => no unnecessary retry', () => {
    const claim =
      'In the previous run, the watermark could not be applied because of a network error.'
    expect(verifyDocsResponse(claim, [])).toBeNull()
  })
})

describe('Defect H: Corrective prompt history truthfulness', () => {
  it('H01: returns standard static correction when no tools executed', () => {
    const res = verifyDocsResponse('I updated the document.', [])
    expect(res).toBe(DOCS_CLAIM_CORRECTION)
    expect(res).toContain('no document-modification tool executed successfully')
  })

  it('H02: returns standard static correction when only failed tools executed', () => {
    const res = verifyDocsResponse('I updated the document.', [
      { name: 'apply_ops', ok: false, mutated: false },
    ])
    expect(res).toBe(DOCS_CLAIM_CORRECTION)
  })

  it('H03: acknowledges set_watermark when margins were unverified', () => {
    const res = verifyDocsResponse('I updated the page margins.', [
      { name: 'set_watermark', ok: true, mutated: false },
    ])
    expect(res).not.toBe(DOCS_CLAIM_CORRECTION)
    expect(res).toContain('While the following tool(s) completed successfully: set_watermark')
    expect(res).toContain('page_setup')
    expect(res).not.toContain('no document-modification tool executed successfully')
  })

  it('H04: acknowledges reply_comment when formatting was unverified', () => {
    const res = verifyDocsResponse('I formatted the paragraphs.', [
      { name: 'reply_comment', ok: true, mutated: false },
    ])
    expect(res).toContain('reply_comment')
    expect(res).toContain('content')
  })

  it('H05: acknowledges multiple successful tools', () => {
    const res = verifyDocsResponse('I defined a style and formatted the paragraphs.', [
      { name: 'set_watermark', ok: true, mutated: false },
      { name: 'define_style', ok: true, mutated: false },
    ])
    expect(res).toContain('set_watermark')
    expect(res).toContain('define_style')
    expect(res).toContain('content')
  })
})

describe('Defect L: Disambiguate comment locations, document topics, and quotations', () => {
  it('L01: comment location does not claim content modification', () => {
    const effects = getClaimedSpecificEffects('I added a comment to paragraph 1.')
    expect(effects.has('comment')).toBe(true)
    expect(effects.has('content')).toBe(false)
  })

  it('L02: comment location in Vietnamese does not claim content modification', () => {
    const effects = getClaimedSpecificEffects('Tôi đã thêm nhận xét vào đoạn văn 1.')
    expect(effects.has('comment')).toBe(true)
    expect(effects.has('content')).toBe(false)
  })

  it('L03: verifyDocsResponse accepts truthful comment location claim with add_comment', () => {
    const res = verifyDocsResponse('I added a comment to paragraph 1.', [
      { name: 'add_comment', ok: true, mutated: false },
    ])
    expect(res).toBeNull()
  })

  it('L04: comment location with explicit content edit requires both tools', () => {
    const effects = getClaimedSpecificEffects(
      'I added a comment to paragraph 1 and edited the content.',
    )
    expect(effects.has('comment')).toBe(true)
    expect(effects.has('content')).toBe(true)
  })

  it('L05: new document topic does not claim current document content edit', () => {
    const effects = getClaimedSpecificEffects(
      'I created a new document about paragraph formatting.',
    )
    expect(effects.has('new_document')).toBe(true)
    expect(effects.has('content')).toBe(false)
  })

  it('L06: verifyDocsResponse accepts new document topic with create_document', () => {
    const res = verifyDocsResponse('I created a new document about paragraph formatting.', [
      { name: 'create_document', ok: true, mutated: false },
    ])
    expect(res).toBeNull()
  })

  it('L07: quotation of user message is not treated as assistant claim', () => {
    const res = verifyDocsResponse('The user wrote: "I defined a Heading style".', [])
    expect(res).toBeNull()
  })

  it('L08: single-quoted linguistic sentence is not treated as assistant claim', () => {
    const res = verifyDocsResponse(
      "The sentence 'I have updated the document' is in the present perfect tense.",
      [],
    )
    expect(res).toBeNull()
  })

  it('L09: curly-quoted sentence in Vietnamese is not treated as assistant claim', () => {
    const res = verifyDocsResponse('Câu “Tôi đã cập nhật văn bản” là câu trần thuật.', [])
    expect(res).toBeNull()
  })

  it('L10: actual claim outside quotation is still detected and verified', () => {
    const res = verifyDocsResponse('The user said: "Please help". I have updated the document.', [])
    expect(res).toBe(DOCS_CLAIM_CORRECTION)
  })

  describe('Regression R1: apostrophes in contractions preserved and distinguished from quotes', () => {
    it('R1-01: recognizes completion claim with contractions: I\'ve and it\'s', () => {
      const claim = "I've updated the page margins, and it's done."
      expect(claimsDocModification(claim)).toBe(true)
      expect(verifyDocsResponse(claim, [])).toBe(DOCS_CLAIM_CORRECTION)
    })

    it('R1-02: recognizes watermark claim with contractions: I\'ve and it\'s', () => {
      const claim = "I've added a watermark; it's visible."
      expect(claimsDocModification(claim)).toBe(true)
      expect(getClaimedSpecificEffects(claim).has('watermark')).toBe(true)
      expect(verifyDocsResponse(claim, [])).toBe(DOCS_CLAIM_CORRECTION)
      expect(
        verifyDocsResponse(claim, [{ name: 'set_page_setup', ok: true, mutated: false }]),
      ).toContain('watermark')
    })

    it('R1-03: recognizes headings formatting claim with haven\'t', () => {
      const claim = "I've formatted the headings, and I haven't changed the footer."
      expect(claimsDocModification(claim)).toBe(true)
      expect(getClaimedSpecificEffects(claim).has('content')).toBe(true)
      expect(verifyDocsResponse(claim, [])).toBe(DOCS_CLAIM_CORRECTION)
      expect(
        verifyDocsResponse(claim, [{ name: 'set_watermark', ok: true, mutated: false }]),
      ).toContain('content')
    })

    it('R1-04: strips single-quoted examples containing contractions without treating them as assistant claims', () => {
      const negative1 = "The user asked for: 'I\\'ve updated the margins' but I did not apply it."
      expect(claimsDocModification(negative1)).toBe(false)
      expect(verifyDocsResponse(negative1, [])).toBeNull()

      const negative2 = "The guideline says 'don\\'t format the document' here."
      expect(claimsDocModification(negative2)).toBe(false)
      expect(verifyDocsResponse(negative2, [])).toBeNull()

      const negative3 = "Note that 'it\\'s completed' was only a placeholder."
      expect(claimsDocModification(negative3)).toBe(false)
      expect(verifyDocsResponse(negative3, [])).toBeNull()
    })

    it('R1-05: verifies claim with contraction when matching tool executed', () => {
      const claim = "I've added a watermark; it's visible."
      const res = verifyDocsResponse(claim, [{ name: 'set_watermark', ok: true, mutated: false }])
      expect(res).toBeNull()
    })

    it('R1-06: recognizes completion claim with typographic curly apostrophes (U+2019)', () => {
      const claim = 'I’ve updated the page margins, and it’s done.'
      expect(claimsDocModification(claim)).toBe(true)
      expect(verifyDocsResponse(claim, [])).toBe(DOCS_CLAIM_CORRECTION)
    })
  })

  describe('Regression R4: mixed claims preserve all affirmative effects', () => {
    it('R4-01: comment and changed font size claims both comment and content', () => {
      const effects = getClaimedSpecificEffects('I added a comment and changed the font size.')
      expect(effects.has('comment')).toBe(true)
      expect(effects.has('content')).toBe(true)

      // Verified by add_comment alone must fail because content was also claimed
      const resCommentOnly = verifyDocsResponse('I added a comment and changed the font size.', [
        { name: 'add_comment', ok: true, mutated: false },
      ])
      expect(resCommentOnly).toContain('add_comment')
      expect(resCommentOnly).toContain('content')

      // Verified by both tools succeeds
      const resBoth = verifyDocsResponse('I added a comment and changed the font size.', [
        { name: 'add_comment', ok: true, mutated: false },
        { name: 'apply_ops', ok: true, mutated: true },
      ])
      expect(resBoth).toBeNull()
    })

    it('R4-02: comment and bolded headings claims both comment and content', () => {
      const effects = getClaimedSpecificEffects('I added a comment and bolded the headings.')
      expect(effects.has('comment')).toBe(true)
      expect(effects.has('content')).toBe(true)
    })

    it('R4-03: comment and adjusted paragraph indentation claims both comment and content', () => {
      const effects = getClaimedSpecificEffects(
        'I added a comment and adjusted paragraph indentation.',
      )
      expect(effects.has('comment')).toBe(true)
      expect(effects.has('content')).toBe(true)
    })

    it('R4-04: new document and changed font size of current doc claims both new_doc and content', () => {
      const effects = getClaimedSpecificEffects(
        'I created a new document and changed the font size of the current document.',
      )
      expect(effects.has('new_document')).toBe(true)
      expect(effects.has('content')).toBe(true)

      // Only create_document must fail because content of current document was claimed
      const resCreateOnly = verifyDocsResponse(
        'I created a new document and changed the font size of the current document.',
        [{ name: 'create_document', ok: true, mutated: false }],
      )
      expect(resCreateOnly).toContain('create_document')
      expect(resCreateOnly).toContain('content')
    })

    it('R4-05: comment target location does not claim content', () => {
      const effects = getClaimedSpecificEffects('I added a comment to paragraph 1.')
      expect(effects.has('comment')).toBe(true)
      expect(effects.has('content')).toBe(false)
    })

    it('R4-06: new document topic does not claim content', () => {
      const effects = getClaimedSpecificEffects('I created a document about paragraph formatting.')
      expect(effects.has('new_document')).toBe(true)
      expect(effects.has('content')).toBe(false)
    })

    it('R4-07: style definition target scope does not claim content', () => {
      const effects = getClaimedSpecificEffects('I defined a Heading style for paragraphs.')
      expect(effects.has('style_definition')).toBe(true)
      expect(effects.has('content')).toBe(false)
    })

    it('R4-08: Chinese compound claim with 并且 without spaces requires both comment and content', () => {
      const effects = getClaimedSpecificEffects('我添加了批注并且修改了正文字体。')
      expect(effects.has('comment')).toBe(true)
      expect(effects.has('content')).toBe(true)
    })

    it('R4-09: Vietnamese comment target on tiêu đề does not claim content', () => {
      const effects = getClaimedSpecificEffects('Tôi đã thêm nhận xét vào tiêu đề.')
      expect(effects.has('comment')).toBe(true)
      expect(effects.has('content')).toBe(false)
    })
  })

  describe('Docs fallback: distinguishing already-matching target from no target', () => {
    it('distinguishes target already matching formatting from no matching content in fallback', () => {
      const callAlready = {
        name: 'apply_ops',
        ok: true,
        mutated: false,
        output: 'setFont: 0 (0 changed; 1 target(s) already matched the requested formatting)',
      }
      expect(fallbackDocsResponse('I formatted the document.', [callAlready])).toContain(
        'already has the requested formatting',
      )

      const callNoTarget = {
        name: 'apply_ops',
        ok: true,
        mutated: false,
        output: 'setFont: 0',
      }
      expect(fallbackDocsResponse('I formatted the document.', [callNoTarget])).toContain(
        'no matching content or paragraphs were found',
      )
    })
  })
})
