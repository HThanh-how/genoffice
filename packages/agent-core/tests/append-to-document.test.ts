import { describe, expect, it, vi } from 'vitest'
import {
  APPEND_TO_DOCUMENT_MAX_CALLS,
  APPEND_TO_DOCUMENT_TOOL,
  CREATE_DOCUMENT_MAX_CHARS,
  CREATE_DOCUMENT_TOOL,
  createDocumentSkill,
  createDocumentSystemPrompt,
  type CreateDocumentRewriteRequest,
} from '../src/create-document-skill'

const PATH = '/Users/me/GenOffice/Giao an.docx'

function setup(options: { turn?: () => string | undefined; session?: () => string } = {}) {
  const rewrites: CreateDocumentRewriteRequest[] = []
  const opens: string[] = []
  const rewrite = vi.fn(async (request: CreateDocumentRewriteRequest) => {
    rewrites.push(request)
    return { path: request.path }
  })
  const skill = createDocumentSkill({
    getSessionId: options.session ?? (() => 'sess-1'),
    getUserTurnId: options.turn ?? (() => 'turn-1'),
    create: async () => ({ path: PATH }),
    rewrite,
    open: async (path) => {
      opens.push(path)
      return true
    },
  })
  return { skill, rewrites, opens, rewrite }
}

let seq = 0
const create = (input: Record<string, unknown>) => ({
  id: `c-${++seq}`,
  name: CREATE_DOCUMENT_TOOL,
  input: { title: 'Giao an', format: 'docx', ...input },
})
const append = (input: Record<string, unknown>, id = `a-${++seq}`) => ({
  id,
  name: APPEND_TO_DOCUMENT_TOOL,
  input: { path: PATH, ...input },
})

describe('append_to_document', () => {
  it('is offered with its own prompt only when the host can rewrite', () => {
    const { skill } = setup()
    expect(skill.tools.map((t) => t.name)).toEqual([CREATE_DOCUMENT_TOOL, APPEND_TO_DOCUMENT_TOOL])
    expect(skill.systemPrompt).toBe(createDocumentSystemPrompt(true))
    expect(skill.systemPrompt).toContain('append_to_document')
    expect(skill.systemPrompt).toContain(`at most ${APPEND_TO_DOCUMENT_MAX_CALLS}`)

    const plain = createDocumentSkill({ create: async () => ({ path: PATH }) })
    expect(plain.tools.map((t) => t.name)).toEqual([CREATE_DOCUMENT_TOOL])
    expect(plain.systemPrompt).toContain('call create_document ONCE')
    expect(plain.systemPrompt).not.toContain('append_to_document')
  })

  it('appends sections in order, rewriting the whole Markdown, with checklist progress', async () => {
    const { skill, rewrites, opens } = setup()
    const created = await skill.executeTool(
      create({
        content: '# Giao an\n\n## Muc tieu\n\nA',
        outline: ['Muc tieu', 'Noi dung', 'Danh gia'],
      }),
    )
    expect(created.isError).toBeUndefined()
    expect(created.output).toContain(
      'section 1 of 3 written; next: append_to_document with "Noi dung"',
    )
    expect(opens).toEqual([PATH])

    const r1 = await skill.executeTool(append({ heading: 'Noi dung', content: 'B' }))
    expect(r1.isError).toBeUndefined()
    expect(r1.output).toContain('section 2 of 3 written; next: append_to_document with "Danh gia"')
    const r2 = await skill.executeTool(append({ content: '## Danh gia\n\nC' }))
    expect(r2.output).toContain('all 3 sections written')

    expect(rewrites).toHaveLength(2)
    expect(rewrites[0]).toMatchObject({
      path: PATH,
      format: 'docx',
      sessionId: 'sess-1',
      userTurnId: 'turn-1',
    })
    expect(rewrites[0]!.content).toBe('# Giao an\n\n## Muc tieu\n\nA\n\n## Noi dung\n\nB\n')
    expect(rewrites[1]!.content).toBe(
      '# Giao an\n\n## Muc tieu\n\nA\n\n## Noi dung\n\nB\n\n## Danh gia\n\nC\n',
    )
    // appends never open another editor tab
    expect(opens).toEqual([PATH])
    expect(
      skill.verifyResponse!('I have saved it.', [{ name: APPEND_TO_DOCUMENT_TOOL, ok: true }]),
    ).toBeNull()
  })

  it('a retried call with the same id does not duplicate content, nor does a re-sent section', async () => {
    const { skill, rewrites } = setup()
    await skill.executeTool(create({ content: '# T' }))
    const first = skill.executeTool(append({ content: '## S\n\nbody' }, 'same-id'))
    const concurrent = skill.executeTool(append({ content: '## S\n\nbody' }, 'same-id'))
    const [a, b] = await Promise.all([first, concurrent])
    const replay = await skill.executeTool(append({ content: '## S\n\nbody' }, 'same-id'))
    expect(rewrites).toHaveLength(1)
    expect(a.output).toBe(b.output)
    expect(replay.output).toBe(a.output)

    const resent = await skill.executeTool(append({ content: '## S\n\nbody' }, 'new-id'))
    expect(resent.isError).toBeUndefined()
    expect(resent.output).toContain('already in')
    expect(rewrites).toHaveLength(1)
  })

  it('refuses a path this session did not create and a document of an earlier request', async () => {
    let turn = 'turn-1'
    const { skill, rewrite } = setup({ turn: () => turn })
    const foreign = await skill.executeTool(
      append({ path: 'C:/Users/me/Documents/payroll.docx', content: 'x' }),
    )
    expect(foreign.isError).toBe(true)
    expect(foreign.output).toContain('create_document')

    await skill.executeTool(create({ content: '# T' }))
    turn = 'turn-2'
    const later = await skill.executeTool(append({ content: '## Late' }))
    expect(later.isError).toBe(true)
    expect(later.output).toContain('earlier request')
    expect(rewrite).not.toHaveBeenCalled()
  })

  it(`stops after ${APPEND_TO_DOCUMENT_MAX_CALLS} appends in one request with a clear error`, async () => {
    const { skill, rewrites } = setup()
    await skill.executeTool(create({ content: '# T' }))
    for (let i = 0; i < APPEND_TO_DOCUMENT_MAX_CALLS; i++) {
      const r = await skill.executeTool(append({ content: `## Part ${i}` }))
      expect(r.isError).toBeUndefined()
    }
    const over = await skill.executeTool(append({ content: '## One too many' }))
    expect(over.isError).toBe(true)
    expect(over.output).toContain('append limit reached')
    expect(rewrites).toHaveLength(APPEND_TO_DOCUMENT_MAX_CALLS)
  })

  it('keeps the total under the single write cap', async () => {
    const { skill, rewrites } = setup()
    await skill.executeTool(create({ content: 'x'.repeat(CREATE_DOCUMENT_MAX_CHARS - 10) }))
    const r = await skill.executeTool(append({ content: 'y'.repeat(50) }))
    expect(r.isError).toBe(true)
    expect(r.output).toContain(String(CREATE_DOCUMENT_MAX_CHARS))
    expect(rewrites).toHaveLength(0)
  })

  it('a failed write is reported, not recorded, and can be retried with the same id', async () => {
    let fail = true
    const skill = createDocumentSkill({
      getSessionId: () => 's',
      getUserTurnId: () => 't',
      create: async () => ({ path: PATH }),
      rewrite: async (request) => {
        if (fail) throw new Error('the document was changed outside this chat')
        return { path: request.path }
      },
    })
    await skill.executeTool(create({ content: '# T', open: false }))
    const r1 = await skill.executeTool(append({ content: '## A' }, 'retry-id'))
    expect(r1.isError).toBe(true)
    expect(r1.output).toContain('changed outside this chat')
    fail = false
    const r2 = await skill.executeTool(append({ content: '## A' }, 'retry-id'))
    expect(r2.isError).toBeUndefined()
    expect(r2.output).toContain('added a section')
  })
})
