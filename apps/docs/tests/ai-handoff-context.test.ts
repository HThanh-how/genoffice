import { describe, expect, it } from 'vitest'
import { handoffModelContext } from '../src/renderer/ai/AiPanel'

describe('handoffModelContext', () => {
  it('answers in the assistant voice when the Home chat created the document', () => {
    const text = [
      'Context carried over from the Home chat "Lesson", where I (the assistant) was talking with the user.',
      'Original request: soạn giáo án lớp 6',
      'My reply to the user at the time: Đã tạo xong.',
      'I created this document in that chat: Giao an.docx (C:\\Docs\\Giao an.docx)',
    ].join('\n')
    const [first, second] = handoffModelContext(text)
    expect(first?.role).toBe('user')
    expect(first?.text).toContain('My reply to the user at the time: Đã tạo xong.')
    expect(second?.role).toBe('assistant')
    expect(second?.text).toContain('I created "Giao an.docx"')
    expect(second?.text).toContain('my own work')
  })

  it('does not claim authorship for a document that was only opened', () => {
    const text =
      'Context carried over from the Home chat "Lesson".\nThis document was opened from that chat: A.docx (C:\\A.docx)'
    const second = handoffModelContext(text)[1]
    expect(second?.text).not.toContain('I created')
  })
})
