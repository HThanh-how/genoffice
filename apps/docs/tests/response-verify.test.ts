import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { AgentLoop, type AgentStreamCallbacks, type AgentTransport } from '@genoffice/agent-core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { createDocsSkill } from '../src/renderer/ai/docs-skill'
import {
  claimsDocModification,
  verifyDocsResponse,
  fallbackDocsResponse,
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
    expect(correction).toBe(DOCS_CLAIM_CORRECTION)
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
    expect(mismatchCorrection).toBe(DOCS_CLAIM_CORRECTION)
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
})
