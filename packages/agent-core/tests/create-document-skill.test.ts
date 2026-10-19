import { describe, expect, it } from 'vitest'
import {
  CREATE_DOCUMENT_MAX_CHARS,
  createDocumentSkill,
  type CreateDocumentRequest,
} from '../src/create-document-skill'
import { createKnowledgeBaseSkill, kbCiteHref } from '../src/knowledge-base-skill'

function makeSkill(create?: (r: CreateDocumentRequest) => Promise<{ path: string }>) {
  const requests: CreateDocumentRequest[] = []
  const skill = createDocumentSkill({
    create: async (r) => {
      requests.push(r)
      return create ? create(r) : { path: `/Users/me/GenOffice/${r.title}.${r.format}` }
    },
  })
  return { skill, requests }
}

const call = (input: Record<string, unknown>) => ({ id: 't1', name: 'create_document', input })

describe('createDocumentSkill', () => {
  it('writes through deps and returns the path with its cite link', async () => {
    const { skill, requests } = makeSkill()
    const result = await skill.executeTool(
      call({ title: 'Q3 summary', format: 'docx', content: '# Q3\n\ntext' }),
    )
    expect(result.isError).toBeUndefined()
    expect(requests).toEqual([{ title: 'Q3 summary', format: 'docx', content: '# Q3\n\ntext' }])
    expect(result.output).toContain('/Users/me/GenOffice/Q3 summary.docx')
    expect(result.output).toContain(kbCiteHref('/Users/me/GenOffice/Q3 summary.docx'))
    expect(skill.createdPaths()).toEqual(['/Users/me/GenOffice/Q3 summary.docx'])
  })

  it('rejects a bad format, empty content and oversized content before writing', async () => {
    const { skill, requests } = makeSkill()
    expect(
      (await skill.executeTool(call({ title: 'a', format: 'pdf', content: 'x' }))).isError,
    ).toBe(true)
    expect(
      (await skill.executeTool(call({ title: 'a', format: 'md', content: '  ' }))).isError,
    ).toBe(true)
    const huge = 'x'.repeat(CREATE_DOCUMENT_MAX_CHARS + 1)
    expect(
      (await skill.executeTool(call({ title: 'a', format: 'md', content: huge }))).isError,
    ).toBe(true)
    expect(requests).toEqual([])
  })

  it('defaults a missing title and reports a write failure as a tool error', async () => {
    const { skill, requests } = makeSkill(async () => {
      throw new Error('disk full')
    })
    const result = await skill.executeTool(call({ format: 'md', content: 'x' }))
    expect(requests[0]!.title).toBe('Untitled')
    expect(result.isError).toBe(true)
    expect(result.output).toContain('disk full')
    expect(skill.createdPaths()).toEqual([])
  })

  it('normalizes Word formats and forwards open flag', async () => {
    const { skill, requests } = makeSkill()
    const r1 = await skill.executeTool(
      call({ title: 'Plan', type: 'docx', content: '# Plan', open: true }),
    )
    expect(r1.isError).toBeUndefined()
    expect(requests[0]).toEqual({ title: 'Plan', format: 'docx', content: '# Plan', open: true })

    const r2 = await skill.executeTool(call({ title: 'Memo', format: 'word', content: '# Memo' }))
    expect(r2.isError).toBeUndefined()
    expect(requests[1]).toEqual({ title: 'Memo', format: 'docx', content: '# Memo' })

    const r3 = await skill.executeTool(
      call({ title: 'Notes', format: '.DOCX', content: '# Notes' }),
    )
    expect(r3.isError).toBeUndefined()
    expect(requests[2]).toEqual({ title: 'Notes', format: 'docx', content: '# Notes' })
  })

  it('verifyResponse pushes back on a saved claim without a successful call', () => {
    const { skill } = makeSkill()
    expect(skill.verifyResponse!('I have saved the summary as report.docx.', [])).toContain(
      'create_document',
    )
    expect(
      skill.verifyResponse!('I have saved the summary.', [{ name: 'create_document', ok: true }]),
    ).toBeNull()
    expect(
      skill.verifyResponse!('The handbook was created in 2019.', [
        { name: 'read_knowledge_file', ok: true },
      ]),
    ).toBeNull()
    expect(skill.verifyResponse!('The document has been saved as notes.md.', [])).toContain(
      'create_document',
    )
    expect(skill.verifyResponse!('The lease runs until 2027.', [])).toBeNull()
    for (const fact of [
      'The document was created by HR and the file was generated monthly.',
      'I created a table from the handbook figures below.',
      'The report says the backup is saved nightly.',
    ]) {
      expect(skill.verifyResponse!(fact, [])).toBeNull()
    }
    expect(skill.verifyResponse!('I saved it to the GenOffice folder.', [])).toContain(
      'create_document',
    )
    expect(skill.verifyResponse!('Saved as q3-summary.docx in your folder.', [])).toContain(
      'create_document',
    )
  })

  it('the knowledge-base citation guard accepts a path the document skill wrote', async () => {
    const { skill } = makeSkill()
    const kb = createKnowledgeBaseSkill({
      listFiles: () => [],
      search: async () => [],
      read: async () => ({ text: '', totalChars: 0, offset: 0 }),
      alsoCitable: () => skill.createdPaths(),
    })
    const href = kbCiteHref('/Users/me/GenOffice/notes.md')
    expect(kb.verifyResponse!(`Saved: [notes.md](${href})`, [])).not.toBeNull()
    await skill.executeTool(call({ title: 'notes', format: 'md', content: '- a' }))
    expect(kb.verifyResponse!(`Saved: [notes.md](${href})`, [])).toBeNull()
  })

  it('reports created-vs-opened status in tool output', async () => {
    const { skill } = makeSkill(async (r) => ({
      path: `/Users/me/GenOffice/${r.title}.${r.format}`,
      opened: true,
    }))
    const r1 = await skill.executeTool(call({ title: 'Doc', format: 'docx', content: '# Content' }))
    expect(r1.output).toContain('opened in editor')
    expect(r1.output).toContain('opened: true')

    const { skill: skill2 } = makeSkill(async (r) => ({
      path: `/Users/me/GenOffice/${r.title}.${r.format}`,
      opened: false,
    }))
    const r2 = await skill2.executeTool(
      call({ title: 'Doc', format: 'docx', content: '# Content' }),
    )
    expect(r2.output).toContain('saved to disk (not opened)')
    expect(r2.output).toContain('opened: false')
  })

  it('deduplicates concurrent in-flight calls with the same identity key', async () => {
    let callCount = 0
    let resolveFirst!: (value: { path: string }) => void
    const barrier = new Promise<{ path: string }>((res) => {
      resolveFirst = res
    })

    const { skill } = makeSkill(async () => {
      callCount++
      return barrier
    })

    const callPayload = {
      title: 'Report',
      format: 'docx',
      content: '# Content',
      sessionId: 'sess-1',
      userTurnId: 'turn-1',
      documentSlot: 'primary',
    }

    const p1 = skill.executeTool(call(callPayload))
    const p2 = skill.executeTool(call(callPayload))

    resolveFirst({ path: '/Users/me/GenOffice/Report.docx' })
    const [r1, r2] = await Promise.all([p1, p2])

    expect(callCount).toBe(1)
    expect(r1.output).toContain('/Users/me/GenOffice/Report.docx')
    expect(r2.output).toContain('/Users/me/GenOffice/Report.docx')
  })

  it('returns committed result for repeated calls with same identity key', async () => {
    let callCount = 0
    const { skill } = makeSkill(async () => {
      callCount++
      return { path: '/Users/me/GenOffice/Report.docx' }
    })

    const callPayload = {
      title: 'Report',
      format: 'docx',
      content: '# Content',
      sessionId: 'sess-1',
      userTurnId: 'turn-1',
      documentSlot: 'primary',
    }

    const r1 = await skill.executeTool(call(callPayload))
    expect(callCount).toBe(1)
    expect(r1.output).toContain('/Users/me/GenOffice/Report.docx')

    const r2 = await skill.executeTool(call(callPayload))
    expect(callCount).toBe(1)
    expect(r2.output).toContain('/Users/me/GenOffice/Report.docx')

    // Different slot should execute
    const _r3 = await skill.executeTool(call({ ...callPayload, documentSlot: 'annex' }))
    expect(callCount).toBe(2)
  })

  it('forwards documentType and documentSlot to deps.create', async () => {
    const { skill, requests } = makeSkill()
    await skill.executeTool(
      call({
        title: 'Science Report',
        format: 'docx',
        content: '# Research',
        documentType: 'scientific-report',
        documentSlot: 'primary',
        sessionId: 's1',
        userTurnId: 't1',
      }),
    )
    expect(requests[0]).toMatchObject({
      title: 'Science Report',
      format: 'docx',
      documentType: 'scientific-report',
      documentSlot: 'primary',
      sessionId: 's1',
      userTurnId: 't1',
    })
  })
})
