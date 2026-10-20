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

const call = (input: Record<string, unknown>, id?: string) => ({
  id: id !== undefined ? id : typeof input.callId === 'string' ? input.callId : '',
  name: 'create_document',
  input,
})

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

  it('forwards explicit identity metadata (callId, documentSlot) when provided in call.input', async () => {
    const { skill, requests } = makeSkill()
    const r = await skill.executeTool(
      call({
        title: 'Plan',
        format: 'docx',
        content: '# Plan',
        open: true,
        documentSlot: 'plan-slot',
        callId: 'call-plan',
      }),
    )
    expect(r.isError).toBeUndefined()
    expect(requests[0]).toEqual({
      title: 'Plan',
      format: 'docx',
      content: '# Plan',
      open: true,
      documentSlot: 'plan-slot',
      callId: 'call-plan',
    })
  })

  it('forwards provider call.id as callId to deps.create when input.callId is omitted', async () => {
    const { skill, requests } = makeSkill()
    const r = await skill.executeTool(
      call({ title: 'Plan', format: 'docx', content: '# Plan' }, 'provider-call-999'),
    )
    expect(r.isError).toBeUndefined()
    expect(requests[0]).toEqual({
      title: 'Plan',
      format: 'docx',
      content: '# Plan',
      callId: 'provider-call-999',
    })
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

  it('creates multiple distinct documents in one turn without slot collision when slot is omitted', async () => {
    let callCount = 0
    const skill = createDocumentSkill({
      getSessionId: () => 'sess-1',
      getUserTurnId: () => 'turn-1',
      create: async (r) => {
        callCount++
        return { path: `/Users/me/GenOffice/${r.title}.${r.format}` }
      },
    })

    const r1 = await skill.executeTool(call({ title: 'Doc A', format: 'docx', content: '# A' }))
    const r2 = await skill.executeTool(call({ title: 'Doc B', format: 'docx', content: '# B' }))

    expect(callCount).toBe(2)
    expect(r1.output).toContain('Doc A.docx')
    expect(r2.output).toContain('Doc B.docx')
  })

  it('does not cache failed operations in committedSlots allowing subsequent retry', async () => {
    let attempts = 0
    const skill = createDocumentSkill({
      getSessionId: () => 'sess-1',
      getUserTurnId: () => 'turn-1',
      create: async (r) => {
        attempts++
        if (attempts === 1) throw new Error('disk full')
        return { path: `/Users/me/GenOffice/${r.title}.${r.format}` }
      },
    })

    const r1 = await skill.executeTool(call({ title: 'Doc', format: 'docx', content: '# A' }))
    expect(r1.isError).toBe(true)
    expect(attempts).toBe(1)

    const r2 = await skill.executeTool(call({ title: 'Doc', format: 'docx', content: '# A' }))
    expect(r2.isError).toBeUndefined()
    expect(attempts).toBe(2)
    expect(r2.output).toContain('Doc.docx')
  })

  it('resolves sessionId and userTurnId from deps when omitted from call.input', async () => {
    let recordedReq: CreateDocumentRequest | null = null
    const skill = createDocumentSkill({
      getSessionId: () => 'host-session-123',
      getUserTurnId: () => 'host-turn-456',
      create: async (r) => {
        recordedReq = r
        return { path: `/Users/me/GenOffice/${r.title}.${r.format}` }
      },
    })

    await skill.executeTool(call({ title: 'AutoIdDoc', format: 'docx', content: '# Auto' }))
    expect(recordedReq).not.toBeNull()
    expect(recordedReq!.sessionId).toBe('host-session-123')
    expect(recordedReq!.userTurnId).toBe('host-turn-456')
  })

  it('TEST 1: same logical operation delivered twice concurrently returns one file', async () => {
    let callCount = 0
    let resolveFirst!: (res: { path: string }) => void
    const barrier = new Promise<{ path: string }>((res) => {
      resolveFirst = res
    })

    const skill = createDocumentSkill({
      getSessionId: () => 'sess-1',
      getUserTurnId: () => 'turn-1',
      create: async (_r) => {
        callCount++
        return barrier
      },
    })

    const opCall = call({ title: 'Report', format: 'docx', content: '# Content' }, 'op-unique-1')
    const p1 = skill.executeTool(opCall)
    const p2 = skill.executeTool(opCall)

    resolveFirst({ path: '/Users/me/GenOffice/Report.docx' })
    const [r1, r2] = await Promise.all([p1, p2])

    expect(callCount).toBe(1)
    expect(r1.output).toContain('/Users/me/GenOffice/Report.docx')
    expect(r2.output).toContain('/Users/me/GenOffice/Report.docx')
  })

  it('TEST 2: same logical operation replayed after completion returns committed file without duplicate', async () => {
    let callCount = 0
    const skill = createDocumentSkill({
      getSessionId: () => 'sess-1',
      getUserTurnId: () => 'turn-1',
      create: async (r) => {
        callCount++
        return { path: `/Users/me/GenOffice/${r.title}.${r.format}` }
      },
    })

    const opCall = call({ title: 'Report', format: 'docx', content: '# Content' }, 'op-unique-2')
    const r1 = await skill.executeTool(opCall)
    expect(callCount).toBe(1)

    const r2 = await skill.executeTool(opCall)
    expect(callCount).toBe(1)
    expect(r1.output).toBe(r2.output)
  })

  it('TEST 3: three distinct documents in the same user turn produce three files', async () => {
    let callCount = 0
    const created: string[] = []
    const skill = createDocumentSkill({
      getSessionId: () => 'sess-1',
      getUserTurnId: () => 'turn-1',
      create: async (r) => {
        callCount++
        const path = `/Users/me/GenOffice/${r.title}.${r.format}`
        created.push(path)
        return { path }
      },
    })

    const r1 = await skill.executeTool(call({ title: 'Doc 1', format: 'docx', content: '# 1' }))
    const r2 = await skill.executeTool(call({ title: 'Doc 2', format: 'docx', content: '# 2' }))
    const r3 = await skill.executeTool(call({ title: 'Doc 3', format: 'docx', content: '# 3' }))

    expect(callCount).toBe(3)
    expect(created).toHaveLength(3)
    expect(r1.output).toContain('Doc 1.docx')
    expect(r2.output).toContain('Doc 2.docx')
    expect(r3.output).toContain('Doc 3.docx')
  })

  it('TEST 4: two distinct documents sharing the same title produce two files', async () => {
    let callCount = 0
    const created: string[] = []
    const skill = createDocumentSkill({
      getSessionId: () => 'sess-1',
      getUserTurnId: () => 'turn-1',
      create: async (r) => {
        callCount++
        const path =
          callCount === 1
            ? `/Users/me/GenOffice/${r.title}.docx`
            : `/Users/me/GenOffice/${r.title} (1).docx`
        created.push(path)
        return { path }
      },
    })

    const r1 = await skill.executeTool(
      call({ title: 'Research Report', format: 'docx', content: '# Vietnamese version' }),
    )
    const r2 = await skill.executeTool(
      call({ title: 'Research Report', format: 'docx', content: '# English version' }),
    )

    expect(callCount).toBe(2)
    expect(created).toEqual([
      '/Users/me/GenOffice/Research Report.docx',
      '/Users/me/GenOffice/Research Report (1).docx',
    ])
    expect(r1.output).toContain('Research Report.docx')
    expect(r2.output).toContain('Research Report (1).docx')
  })

  it('TEST 5: two explicitly requested copies with identical content produce two files', async () => {
    let callCount = 0
    const skill = createDocumentSkill({
      getSessionId: () => 'sess-1',
      getUserTurnId: () => 'turn-1',
      create: async (_r) => {
        callCount++
        return { path: `/Users/me/GenOffice/Copy_${callCount}.docx` }
      },
    })

    const r1 = await skill.executeTool(
      call({ title: 'Invoice', format: 'docx', content: '# Invoice 101' }),
    )
    const r2 = await skill.executeTool(
      call({ title: 'Invoice', format: 'docx', content: '# Invoice 101' }),
    )

    expect(callCount).toBe(2)
    expect(r1.output).toContain('Copy_1.docx')
    expect(r2.output).toContain('Copy_2.docx')
  })

  it('TEST 6: a new user turn requesting another document with same title and content produces a new file', async () => {
    let callCount = 0
    let currentTurn = 'turn-1'
    const skill = createDocumentSkill({
      getSessionId: () => 'sess-1',
      getUserTurnId: () => currentTurn,
      create: async (r) => {
        callCount++
        return { path: `/Users/me/GenOffice/${r.title}_${currentTurn}.docx` }
      },
    })

    const r1 = await skill.executeTool(
      call({ title: 'Report', format: 'docx', content: '# Content' }, 'op-fixed-id'),
    )
    expect(callCount).toBe(1)
    expect(r1.output).toContain('Report_turn-1.docx')

    currentTurn = 'turn-2'
    const r2 = await skill.executeTool(
      call({ title: 'Report', format: 'docx', content: '# Content' }, 'op-fixed-id'),
    )
    expect(callCount).toBe(2)
    expect(r2.output).toContain('Report_turn-2.docx')
  })

  it('TEST 7: failed write followed by retry succeeds without cached failure', async () => {
    let attempts = 0
    const skill = createDocumentSkill({
      getSessionId: () => 'sess-1',
      getUserTurnId: () => 'turn-1',
      create: async (r) => {
        attempts++
        if (attempts === 1) throw new Error('EACCES: permission denied')
        return { path: `/Users/me/GenOffice/${r.title}.docx` }
      },
    })

    const r1 = await skill.executeTool(
      call({ title: 'Doc', format: 'docx', content: '# A' }, 'op-fail-retry'),
    )
    expect(r1.isError).toBe(true)
    expect(r1.output).toContain('EACCES')

    const r2 = await skill.executeTool(
      call({ title: 'Doc', format: 'docx', content: '# A' }, 'op-fail-retry'),
    )
    expect(r2.isError).toBeUndefined()
    expect(attempts).toBe(2)
    expect(r2.output).toContain('Doc.docx')
  })

  it('TEST 8: deleted output followed by legitimate retry triggers re-creation', async () => {
    let createCalls = 0
    let fileExistsOnDisk = true
    const skill = createDocumentSkill({
      getSessionId: () => 'sess-1',
      getUserTurnId: () => 'turn-1',
      fileExists: () => fileExistsOnDisk,
      create: async (r) => {
        createCalls++
        return { path: `/Users/me/GenOffice/${r.title}.docx` }
      },
    })

    const r1 = await skill.executeTool(
      call({ title: 'Memo', format: 'docx', content: '# Hi' }, 'memo-op'),
    )
    expect(createCalls).toBe(1)
    expect(r1.output).toContain('Memo.docx')

    // Delete output from disk
    fileExistsOnDisk = false

    // Retrying the same operation must re-create the missing document
    const r2 = await skill.executeTool(
      call({ title: 'Memo', format: 'docx', content: '# Hi' }, 'memo-op'),
    )
    expect(createCalls).toBe(2)
    expect(r2.output).toContain('Memo.docx')
  })

  it('Section 5: session-identity race test (sequential and concurrent variants)', async () => {
    // Sequential variant:
    // 1. Conversation starts without persisted ID
    let persistedId: string | null = null
    const executionId = 'exec-stable-uuid'
    let createCalls = 0
    const skill = createDocumentSkill({
      getSessionId: () => persistedId || executionId,
      getUserTurnId: () => 'turn-1',
      create: async () => {
        createCalls++
        return { path: '/Users/me/GenOffice/Report.docx' }
      },
    })

    // 2. Document creation starts with executionId
    const opCall = call({ title: 'Report', format: 'docx', content: '# Report' }, 'op-race-1')
    const r1 = await skill.executeTool(opCall)
    expect(createCalls).toBe(1)

    // 3. History persistence assigns an ID
    persistedId = 'persisted-server-id-456'

    // 4. If executionId remains stable host-side, retry preserves single physical document
    const r2 = await skill.executeTool({
      ...opCall,
      input: { ...opCall.input, sessionId: executionId },
    })
    expect(createCalls).toBe(1)
    expect(r2.output).toBe(r1.output)

    // Concurrent variant:
    let concurrentCalls = 0
    let resolveDelayedCreate!: (res: { path: string }) => void
    const delayedBarrier = new Promise<{ path: string }>((res) => {
      resolveDelayedCreate = res
    })
    const concurrentSkill = createDocumentSkill({
      getSessionId: () => executionId,
      getUserTurnId: () => 'turn-1',
      create: async () => {
        concurrentCalls++
        return delayedBarrier
      },
    })

    const p1 = concurrentSkill.executeTool(opCall)
    // Mid-flight persistence completes
    persistedId = 'persisted-server-id-789'
    const p2 = concurrentSkill.executeTool({
      ...opCall,
      input: { ...opCall.input, sessionId: executionId },
    })

    resolveDelayedCreate({ path: '/Users/me/GenOffice/Report.docx' })
    const [cr1, cr2] = await Promise.all([p1, p2])
    expect(concurrentCalls).toBe(1)
    expect(cr1.output).toBe(cr2.output)
  })

  it('Section 6: bounds committedSlots cache to 100 entries with FIFO eviction', async () => {
    let createCalls = 0
    const skill = createDocumentSkill({
      getSessionId: () => 'sess-1',
      getUserTurnId: () => 'turn-1',
      create: async (r) => {
        createCalls++
        return { path: `/Users/me/GenOffice/${r.title}.docx` }
      },
    })

    // Insert 100 entries: slot-0 to slot-99
    for (let i = 0; i < 100; i++) {
      await skill.executeTool(
        call(
          { title: `Doc ${i}`, format: 'docx', content: 'text', documentSlot: `slot-${i}` },
          `slot-${i}`,
        ),
      )
    }
    expect(createCalls).toBe(100)

    // Insert 101st entry: slot-100. This must evict the oldest entry (slot-0)
    await skill.executeTool(
      call(
        { title: 'Doc 100', format: 'docx', content: 'text', documentSlot: 'slot-100' },
        'slot-100',
      ),
    )
    expect(createCalls).toBe(101)

    // Replaying slot-0 (evicted) must trigger create again
    await skill.executeTool(
      call({ title: 'Doc 0', format: 'docx', content: 'text', documentSlot: 'slot-0' }, 'slot-0'),
    )
    expect(createCalls).toBe(102)

    // Replaying slot-100 (recent, in cache) must NOT trigger create again
    await skill.executeTool(
      call(
        { title: 'Doc 100', format: 'docx', content: 'text', documentSlot: 'slot-100' },
        'slot-100',
      ),
    )
    expect(createCalls).toBe(102)
  })

  describe('mandatory document operation identity precedence & collision prevention', () => {
    it('1. two different call IDs with the same documentSlot produce two distinct documents', async () => {
      let callCount = 0
      const created: string[] = []
      const skill = createDocumentSkill({
        getSessionId: () => 'sess-1',
        getUserTurnId: () => 'turn-1',
        create: async (r) => {
          callCount++
          const path = `/Users/me/GenOffice/${r.title}.docx`
          created.push(path)
          return { path }
        },
      })
      const r1 = await skill.executeTool(
        call(
          { title: 'Vietnamese Report', format: 'docx', content: '# VI', documentSlot: 'primary' },
          'call-A',
        ),
      )
      const r2 = await skill.executeTool(
        call(
          { title: 'English Report', format: 'docx', content: '# EN', documentSlot: 'primary' },
          'call-B',
        ),
      )
      expect(callCount).toBe(2)
      expect(created).toEqual([
        '/Users/me/GenOffice/Vietnamese Report.docx',
        '/Users/me/GenOffice/English Report.docx',
      ])
      expect(r1.output).toContain('Vietnamese Report.docx')
      expect(r2.output).toContain('English Report.docx')
    })

    it('2. two different call IDs with different documentSlots produce two distinct documents', async () => {
      let callCount = 0
      const skill = createDocumentSkill({
        getSessionId: () => 'sess-1',
        getUserTurnId: () => 'turn-1',
        create: async (r) => {
          callCount++
          return { path: `/Users/me/GenOffice/${r.title}.docx` }
        },
      })
      const r1 = await skill.executeTool(
        call({ title: 'Report', format: 'docx', content: '# A', documentSlot: 'slot-1' }, 'call-A'),
      )
      const r2 = await skill.executeTool(
        call(
          { title: 'Appendix', format: 'docx', content: '# B', documentSlot: 'slot-2' },
          'call-B',
        ),
      )
      expect(callCount).toBe(2)
      expect(r1.output).toContain('Report.docx')
      expect(r2.output).toContain('Appendix.docx')
    })

    it('3. two different call IDs with identical titles produce two distinct documents', async () => {
      let callCount = 0
      const created: string[] = []
      const skill = createDocumentSkill({
        getSessionId: () => 'sess-1',
        getUserTurnId: () => 'turn-1',
        create: async (r) => {
          callCount++
          const path =
            callCount === 1
              ? `/Users/me/GenOffice/${r.title}.docx`
              : `/Users/me/GenOffice/${r.title} (1).docx`
          created.push(path)
          return { path }
        },
      })
      const r1 = await skill.executeTool(
        call({ title: 'Summary', format: 'docx', content: '# Part 1' }, 'call-id-1'),
      )
      const r2 = await skill.executeTool(
        call({ title: 'Summary', format: 'docx', content: '# Part 2' }, 'call-id-2'),
      )
      expect(callCount).toBe(2)
      expect(created).toEqual([
        '/Users/me/GenOffice/Summary.docx',
        '/Users/me/GenOffice/Summary (1).docx',
      ])
      expect(r1.output).toContain('Summary.docx')
      expect(r2.output).toContain('Summary (1).docx')
    })

    it('4. the same call ID delivered twice returns committed result without duplicate creation', async () => {
      let callCount = 0
      const skill = createDocumentSkill({
        getSessionId: () => 'sess-1',
        getUserTurnId: () => 'turn-1',
        create: async (r) => {
          callCount++
          return { path: `/Users/me/GenOffice/${r.title}.docx` }
        },
      })
      const opCall = call({ title: 'Report', format: 'docx', content: '# Content' }, 'call-id-dup')
      const r1 = await skill.executeTool(opCall)
      expect(callCount).toBe(1)
      const r2 = await skill.executeTool(opCall)
      expect(callCount).toBe(1)
      expect(r2.output).toBe(r1.output)
    })

    it('5. concurrent duplicate delivery of the same call deduplicates to a single flight', async () => {
      let callCount = 0
      let resolveBarrier!: (res: { path: string }) => void
      const barrier = new Promise<{ path: string }>((res) => {
        resolveBarrier = res
      })
      const skill = createDocumentSkill({
        getSessionId: () => 'sess-1',
        getUserTurnId: () => 'turn-1',
        create: async () => {
          callCount++
          return barrier
        },
      })
      const opCall = call(
        { title: 'Report', format: 'docx', content: '# Content' },
        'call-id-barrier',
      )
      const p1 = skill.executeTool(opCall)
      const p2 = skill.executeTool(opCall)
      resolveBarrier({ path: '/Users/me/GenOffice/Report.docx' })
      const [r1, r2] = await Promise.all([p1, p2])
      expect(callCount).toBe(1)
      expect(r1.output).toBe(r2.output)
    })

    it('6. different user turns using the same call ID produce distinct documents', async () => {
      let callCount = 0
      let currentTurn = 'turn-1'
      const skill = createDocumentSkill({
        getSessionId: () => 'sess-1',
        getUserTurnId: () => currentTurn,
        create: async (r) => {
          callCount++
          return { path: `/Users/me/GenOffice/${r.title}_${currentTurn}.docx` }
        },
      })
      const r1 = await skill.executeTool(
        call({ title: 'Report', format: 'docx', content: '# Content' }, 'reused-call-id'),
      )
      expect(callCount).toBe(1)
      expect(r1.output).toContain('Report_turn-1.docx')

      currentTurn = 'turn-2'
      const r2 = await skill.executeTool(
        call({ title: 'Report', format: 'docx', content: '# Content' }, 'reused-call-id'),
      )
      expect(callCount).toBe(2)
      expect(r2.output).toContain('Report_turn-2.docx')
    })

    it('7. explicit requests for identical document copies produce two files', async () => {
      let callCount = 0
      const skill = createDocumentSkill({
        getSessionId: () => 'sess-1',
        getUserTurnId: () => 'turn-1',
        create: async () => {
          callCount++
          return { path: `/Users/me/GenOffice/Copy_${callCount}.docx` }
        },
      })
      const r1 = await skill.executeTool(
        call({ title: 'Invoice', format: 'docx', content: '# Invoice 101' }, 'copy-call-1'),
      )
      const r2 = await skill.executeTool(
        call({ title: 'Invoice', format: 'docx', content: '# Invoice 101' }, 'copy-call-2'),
      )
      expect(callCount).toBe(2)
      expect(r1.output).toContain('Copy_1.docx')
      expect(r2.output).toContain('Copy_2.docx')
    })
  })

  describe('editor open and retry integration (open / isOpen deps)', () => {
    it('Create succeeds, open fails, retry succeeds', async () => {
      let createCount = 0
      let openCount = 0
      const openedPaths: string[] = []

      const skill = createDocumentSkill({
        getSessionId: () => 'sess-1',
        getUserTurnId: () => 'turn-1',
        create: async (r) => {
          createCount++
          return { path: `/Users/me/GenOffice/${r.title}.${r.format}` }
        },
        open: async (filePath) => {
          openCount++
          openedPaths.push(filePath)
          return openCount > 1
        },
      })

      const req = call({ title: 'Doc', format: 'docx', content: '# Content' }, 'call-retry-open')

      // Initial call: create succeeds, open fails
      const r1 = await skill.executeTool(req)
      expect(r1.isError).toBeUndefined()
      expect(createCount).toBe(1)
      expect(openCount).toBe(1)
      expect(openedPaths).toEqual(['/Users/me/GenOffice/Doc.docx'])
      expect(r1.output).toContain('saved to disk (not opened)')
      expect(r1.output).toContain('opened: false')

      // Replay/retry call with same identity: create is NOT called, open is called again and succeeds
      const r2 = await skill.executeTool(req)
      expect(r2.isError).toBeUndefined()
      expect(createCount).toBe(1)
      expect(openCount).toBe(2)
      expect(openedPaths).toEqual(['/Users/me/GenOffice/Doc.docx', '/Users/me/GenOffice/Doc.docx'])
      expect(r2.output).toContain('opened in editor')
      expect(r2.output).toContain('opened: true')
    })

    it('Open returns false', async () => {
      let createCount = 0
      let openCount = 0

      const skill = createDocumentSkill({
        getSessionId: () => 'sess-1',
        getUserTurnId: () => 'turn-1',
        create: async (r) => {
          createCount++
          return { path: `/Users/me/GenOffice/${r.title}.${r.format}` }
        },
        open: async () => {
          openCount++
          return false
        },
      })

      const result = await skill.executeTool(
        call({ title: 'Doc', format: 'docx', content: '# Content' }, 'call-open-false'),
      )

      expect(createCount).toBe(1)
      expect(openCount).toBe(1)
      expect(result.isError).toBeUndefined()
      expect(result.output).toContain('saved to disk (not opened)')
      expect(result.output).toContain('opened: false')
    })

    it('Open throws', async () => {
      let createCount = 0
      let openCount = 0

      const skill = createDocumentSkill({
        getSessionId: () => 'sess-1',
        getUserTurnId: () => 'turn-1',
        create: async (r) => {
          createCount++
          return { path: `/Users/me/GenOffice/${r.title}.${r.format}` }
        },
        open: () => {
          openCount++
          throw new Error('editor unavailable')
        },
      })

      const result = await skill.executeTool(
        call({ title: 'Doc', format: 'docx', content: '# Content' }, 'call-open-throws'),
      )

      expect(createCount).toBe(1)
      expect(openCount).toBe(1)
      expect(result.isError).toBeUndefined()
      expect(result.output).toContain('saved to disk (not opened)')
      expect(result.output).toContain('opened: false')
    })

    it('Open succeeds, tab closes, reopen succeeds', async () => {
      let createCount = 0
      let openCount = 0
      let isTabOpen = false

      const skill = createDocumentSkill({
        getSessionId: () => 'sess-1',
        getUserTurnId: () => 'turn-1',
        create: async (r) => {
          createCount++
          return { path: `/Users/me/GenOffice/${r.title}.${r.format}` }
        },
        open: async () => {
          openCount++
          isTabOpen = true
          return true
        },
        isOpen: async () => isTabOpen,
      })

      const req = call({ title: 'Doc', format: 'docx', content: '# Content' }, 'call-tab-cycle')

      // Initial call: opens successfully
      const r1 = await skill.executeTool(req)
      expect(r1.isError).toBeUndefined()
      expect(createCount).toBe(1)
      expect(openCount).toBe(1)
      expect(isTabOpen).toBe(true)
      expect(r1.output).toContain('opened in editor')
      expect(r1.output).toContain('opened: true')

      // Tab closes: isOpen returns false
      isTabOpen = false

      // Replay when tab is closed: invokes open to reopen, create is NOT called
      const r2 = await skill.executeTool(req)
      expect(r2.isError).toBeUndefined()
      expect(createCount).toBe(1)
      expect(openCount).toBe(2)
      expect(isTabOpen).toBe(true)
      expect(r2.output).toContain('opened in editor')
      expect(r2.output).toContain('opened: true')
    })

    it('Retry creates zero additional physical documents', async () => {
      let createCount = 0
      const createdPaths: string[] = []

      const skill = createDocumentSkill({
        getSessionId: () => 'sess-1',
        getUserTurnId: () => 'turn-1',
        create: async (r) => {
          createCount++
          const path = `/Users/me/GenOffice/${r.title}.${r.format}`
          createdPaths.push(path)
          return { path }
        },
        open: async () => true,
      })

      const req = call(
        { title: 'PhysicalDoc', format: 'docx', content: '# Content' },
        'call-id-triple',
      )

      const r1 = await skill.executeTool(req)
      const r2 = await skill.executeTool(req)
      const r3 = await skill.executeTool(req)

      expect(createCount).toBe(1)
      expect(createdPaths).toEqual(['/Users/me/GenOffice/PhysicalDoc.docx'])
      expect(r1.isError).toBeUndefined()
      expect(r2.isError).toBeUndefined()
      expect(r3.isError).toBeUndefined()
      expect(r1.output).toContain('PhysicalDoc.docx')
      expect(r2.output).toContain('PhysicalDoc.docx')
      expect(r3.output).toContain('PhysicalDoc.docx')
      expect(skill.createdPaths()).toEqual(['/Users/me/GenOffice/PhysicalDoc.docx'])
    })

    it('supports openDocument and isDocumentOpen aliases', async () => {
      let createCount = 0
      let openCount = 0
      let isTabOpen = false

      const skill = createDocumentSkill({
        getSessionId: () => 'sess-1',
        getUserTurnId: () => 'turn-1',
        create: async (r) => {
          createCount++
          return { path: `/Users/me/GenOffice/${r.title}.${r.format}` }
        },
        openDocument: async () => {
          openCount++
          isTabOpen = true
          return true
        },
        isDocumentOpen: () => isTabOpen,
      })

      const req = call(
        { title: 'AliasDoc', format: 'docx', content: '# Content' },
        'call-alias-test',
      )

      const r1 = await skill.executeTool(req)
      expect(r1.isError).toBeUndefined()
      expect(createCount).toBe(1)
      expect(openCount).toBe(1)
      expect(r1.output).toContain('opened in editor')
      expect(r1.output).toContain('opened: true')

      isTabOpen = false

      const r2 = await skill.executeTool(req)
      expect(r2.isError).toBeUndefined()
      expect(createCount).toBe(1)
      expect(openCount).toBe(2)
      expect(r2.output).toContain('opened in editor')
      expect(r2.output).toContain('opened: true')
    })
  })

  describe('P1-A: Host identity authority & stability (ID-01 through ID-12)', () => {
    it('ID-01: host session is authoritative and model forged-session is rejected', async () => {
      let recordedReq: CreateDocumentRequest | null = null
      let createCalls = 0
      const skill = createDocumentSkill({
        getSessionId: () => 'real-session',
        getUserTurnId: () => 'real-turn',
        create: async (r) => {
          createCalls++
          recordedReq = r
          return { path: `/Users/me/GenOffice/${r.title}.docx` }
        },
      })

      const req = call(
        { title: 'Doc', format: 'docx', content: '# Content', sessionId: 'forged-session' },
        'call-id-01',
      )
      const res = await skill.executeTool(req)
      expect(res.isError).toBeUndefined()
      expect(createCalls).toBe(1)
      expect(recordedReq!.sessionId).toBe('real-session')

      // Replay with forged session hits the authoritative cache
      const replay = await skill.executeTool(req)
      expect(replay.isError).toBeUndefined()
      expect(createCalls).toBe(1)
    })

    it('ID-02: host user turn is authoritative and model forged-turn is rejected', async () => {
      let recordedReq: CreateDocumentRequest | null = null
      let createCalls = 0
      const skill = createDocumentSkill({
        getSessionId: () => 'real-session',
        getUserTurnId: () => 'real-turn',
        create: async (r) => {
          createCalls++
          recordedReq = r
          return { path: `/Users/me/GenOffice/${r.title}.docx` }
        },
      })

      const req = call(
        { title: 'Doc', format: 'docx', content: '# Content', userTurnId: 'forged-turn' },
        'call-id-02',
      )
      const res = await skill.executeTool(req)
      expect(res.isError).toBeUndefined()
      expect(createCalls).toBe(1)
      expect(recordedReq!.userTurnId).toBe('real-turn')
    })

    it('ID-03: sequential replay of the same operation creates exactly one physical document', async () => {
      let createCalls = 0
      const skill = createDocumentSkill({
        getSessionId: () => 'session-id-03',
        getUserTurnId: () => 'turn-id-03',
        create: async (r) => {
          createCalls++
          return { path: `/Users/me/GenOffice/${r.title}.docx` }
        },
      })

      const req = call({ title: 'Report', format: 'docx', content: '# Content' }, 'call-id-03')
      const r1 = await skill.executeTool(req)
      const r2 = await skill.executeTool(req)

      expect(createCalls).toBe(1)
      expect(r1.output).toBe(r2.output)
    })

    it('ID-04: concurrent replay of the same operation coalesces to one create call', async () => {
      let createCalls = 0
      let resolveCreate!: (res: { path: string }) => void
      const barrier = new Promise<{ path: string }>((res) => {
        resolveCreate = res
      })

      const skill = createDocumentSkill({
        getSessionId: () => 'session-id-04',
        getUserTurnId: () => 'turn-id-04',
        create: async () => {
          createCalls++
          return barrier
        },
      })

      const req = call({ title: 'Report', format: 'docx', content: '# Content' }, 'call-id-04')
      const p1 = skill.executeTool(req)
      const p2 = skill.executeTool(req)

      resolveCreate({ path: '/Users/me/GenOffice/Report.docx' })
      const [r1, r2] = await Promise.all([p1, p2])

      expect(createCalls).toBe(1)
      expect(r1.output).toBe(r2.output)
    })

    it('ID-05: operation under stable execution ID survives history persistence midway', async () => {
      let persistedId: string | null = null
      const executionId = 'stable-exec-id-05'
      let createCalls = 0

      const skill = createDocumentSkill({
        getExecutionId: () => executionId,
        getSessionId: () => persistedId || executionId,
        getUserTurnId: () => 'turn-id-05',
        create: async (r) => {
          createCalls++
          return { path: `/Users/me/GenOffice/${r.title}.docx` }
        },
      })

      const req = call({ title: 'Memo', format: 'docx', content: '# Memo' }, 'call-id-05')
      const r1 = await skill.executeTool(req)
      expect(createCalls).toBe(1)

      // History persistence runs and assigns an ID
      persistedId = 'persisted-server-id-05'

      // Replay must recognize stable bound identity and not re-create
      const r2 = await skill.executeTool(req)
      expect(createCalls).toBe(1)
      expect(r1.output).toBe(r2.output)
    })

    it('ID-06: identical title and content in turn B after history persistence creates distinct file', async () => {
      let currentTurn = 'turn-A'
      let createCalls = 0

      const skill = createDocumentSkill({
        getSessionId: () => 'session-id-06',
        getUserTurnId: () => currentTurn,
        create: async (r) => {
          createCalls++
          return { path: `/Users/me/GenOffice/${r.title}_${currentTurn}.docx` }
        },
      })

      const reqA = call({ title: 'Doc', format: 'docx', content: '# Content' }, 'call-A')
      const r1 = await skill.executeTool(reqA)
      expect(createCalls).toBe(1)
      expect(r1.output).toContain('Doc_turn-A.docx')

      // Turn B with identical content but new turn ID
      currentTurn = 'turn-B'
      const reqB = call({ title: 'Doc', format: 'docx', content: '# Content' }, 'call-B')
      const r2 = await skill.executeTool(reqB)
      expect(createCalls).toBe(2)
      expect(r2.output).toContain('Doc_turn-B.docx')
    })

    it('ID-07: two genuinely distinct requested documents in the same turn produce two files', async () => {
      let createCalls = 0
      const skill = createDocumentSkill({
        getSessionId: () => 'session-id-07',
        getUserTurnId: () => 'turn-id-07',
        create: async (r) => {
          createCalls++
          return { path: `/Users/me/GenOffice/${r.title}.docx` }
        },
      })

      const doc1 = call({ title: 'Vietnamese_Report', format: 'docx', content: '# VN' }, 'call-vn')
      const doc2 = call({ title: 'English_Report', format: 'docx', content: '# EN' }, 'call-en')

      const r1 = await skill.executeTool(doc1)
      const r2 = await skill.executeTool(doc2)

      expect(createCalls).toBe(2)
      expect(r1.output).toContain('Vietnamese_Report.docx')
      expect(r2.output).toContain('English_Report.docx')
    })

    it('ID-08: same provider call ID reused in a new turn produces two distinct files', async () => {
      let currentTurn = 'turn-1'
      let createCalls = 0

      const skill = createDocumentSkill({
        getSessionId: () => 'session-id-08',
        getUserTurnId: () => currentTurn,
        create: async (r) => {
          createCalls++
          return { path: `/Users/me/GenOffice/${r.title}_${currentTurn}.docx` }
        },
      })

      const req = call({ title: 'Shared', format: 'docx', content: '# Shared' }, 'call-reused')
      const r1 = await skill.executeTool(req)
      expect(createCalls).toBe(1)

      currentTurn = 'turn-2'
      const r2 = await skill.executeTool(req)
      expect(createCalls).toBe(2)
      expect(r1.output).toContain('Shared_turn-1.docx')
      expect(r2.output).toContain('Shared_turn-2.docx')
    })

    it('ID-09: missing host identity with forged model identity does not promote forged context', async () => {
      let recordedReq: CreateDocumentRequest | null = null
      let createCalls = 0

      const skill = createDocumentSkill({
        getSessionId: () => undefined,
        getUserTurnId: () => undefined,
        create: async (r) => {
          createCalls++
          recordedReq = r
          return { path: `/Users/me/GenOffice/${r.title}.docx` }
        },
      })

      const req = call(
        { title: 'Doc', format: 'docx', content: '# Content', sessionId: 'forged-session' },
        'call-id-09',
      )
      const res = await skill.executeTool(req)
      expect(res.isError).toBeUndefined()
      expect(createCalls).toBe(1)
      // Forged session is not promoted to authoritative request identity
      expect(recordedReq!.sessionId).toBeUndefined()
    })

    it('ID-10: failed creation followed by legitimate retry succeeds without caching error', async () => {
      let attempts = 0
      const skill = createDocumentSkill({
        getSessionId: () => 'session-id-10',
        getUserTurnId: () => 'turn-id-10',
        create: async (r) => {
          attempts++
          if (attempts === 1) throw new Error('EACCES: permission denied')
          return { path: `/Users/me/GenOffice/${r.title}.docx` }
        },
      })

      const req = call({ title: 'RetryDoc', format: 'docx', content: '# Retry' }, 'call-id-10')
      const r1 = await skill.executeTool(req)
      expect(r1.isError).toBe(true)
      expect(r1.output).toContain('permission denied')

      const r2 = await skill.executeTool(req)
      expect(r2.isError).toBeUndefined()
      expect(r2.output).toContain('RetryDoc.docx')
      expect(attempts).toBe(2)
    })

    it('ID-11: deleted output followed by retry triggers re-creation', async () => {
      let createCalls = 0
      let fileExistsOnDisk = true

      const skill = createDocumentSkill({
        getSessionId: () => 'session-id-11',
        getUserTurnId: () => 'turn-id-11',
        fileExists: () => fileExistsOnDisk,
        create: async (r) => {
          createCalls++
          return { path: `/Users/me/GenOffice/${r.title}.docx` }
        },
      })

      const req = call({ title: 'Ephemeral', format: 'docx', content: '# E' }, 'call-id-11')
      const r1 = await skill.executeTool(req)
      expect(createCalls).toBe(1)
      expect(r1.output).toContain('Ephemeral.docx')

      // File is deleted on disk
      fileExistsOnDisk = false

      const r2 = await skill.executeTool(req)
      expect(createCalls).toBe(2)
      expect(r2.output).toContain('Ephemeral.docx')
    })

    it('ID-12: concurrent creations from two separate conversations do not collide', async () => {
      let createCalls = 0
      const createdPaths: string[] = []

      const skill1 = createDocumentSkill({
        getSessionId: () => 'conv-1',
        getUserTurnId: () => 'turn-1',
        create: async (r) => {
          createCalls++
          const p = `/Users/me/GenOffice/${r.title}_${r.sessionId}.docx`
          createdPaths.push(p)
          return { path: p }
        },
      })

      const skill2 = createDocumentSkill({
        getSessionId: () => 'conv-2',
        getUserTurnId: () => 'turn-1',
        create: async (r) => {
          createCalls++
          const p = `/Users/me/GenOffice/${r.title}_${r.sessionId}.docx`
          createdPaths.push(p)
          return { path: p }
        },
      })

      const req1 = call(
        { title: 'SharedTitle', format: 'docx', content: '# Content' },
        'call-conv-1',
      )
      const req2 = call(
        { title: 'SharedTitle', format: 'docx', content: '# Content' },
        'call-conv-2',
      )

      const [r1, r2] = await Promise.all([skill1.executeTool(req1), skill2.executeTool(req2)])

      expect(createCalls).toBe(2)
      expect(r1.output).toContain('SharedTitle_conv-1.docx')
      expect(r2.output).toContain('SharedTitle_conv-2.docx')
      expect(createdPaths).toEqual([
        '/Users/me/GenOffice/SharedTitle_conv-1.docx',
        '/Users/me/GenOffice/SharedTitle_conv-2.docx',
      ])
    })

    describe('Super Prompt V8: Identity isolation & conflict checks (IDENTITY-V8-01 through IDENTITY-V8-13)', () => {
      it('IDENTITY-V8-01: One skill instance, same call ID, same user turn ID, two distinct host session IDs. They must not share a cached file', async () => {
        let currentSession = 'session-A'
        let createCalls = 0
        const skill = createDocumentSkill({
          getSessionId: () => currentSession,
          getUserTurnId: () => 'turn-1',
          create: async (r) => {
            createCalls++
            return { path: `/Users/me/GenOffice/${r.title}_${currentSession}.docx` }
          },
        })
        const req = call({ title: 'Report', format: 'docx', content: '# Content' }, 'call-shared')
        const r1 = await skill.executeTool(req)
        expect(createCalls).toBe(1)
        expect(r1.output).toContain('Report_session-A.docx')

        currentSession = 'session-B'
        const r2 = await skill.executeTool(req)
        expect(createCalls).toBe(2)
        expect(r2.output).toContain('Report_session-B.docx')
      })

      it('IDENTITY-V8-02: One skill instance, same call ID, two distinct user turns within one session. Two legitimate files are produced', async () => {
        let currentTurn = 'turn-1'
        let createCalls = 0
        const skill = createDocumentSkill({
          getSessionId: () => 'session-1',
          getUserTurnId: () => currentTurn,
          create: async (r) => {
            createCalls++
            return { path: `/Users/me/GenOffice/${r.title}_${currentTurn}.docx` }
          },
        })
        const req = call({ title: 'Report', format: 'docx', content: '# Content' }, 'call-same')
        const r1 = await skill.executeTool(req)
        expect(createCalls).toBe(1)
        expect(r1.output).toContain('Report_turn-1.docx')

        currentTurn = 'turn-2'
        const r2 = await skill.executeTool(req)
        expect(createCalls).toBe(2)
        expect(r2.output).toContain('Report_turn-2.docx')
      })

      it('IDENTITY-V8-03: Exact same operation delivered twice sequentially. Exactly one physical document is created', async () => {
        let createCalls = 0
        const skill = createDocumentSkill({
          getSessionId: () => 'session-seq',
          getUserTurnId: () => 'turn-seq',
          create: async (r) => {
            createCalls++
            return { path: `/Users/me/GenOffice/${r.title}.docx` }
          },
        })
        const req = call({ title: 'Sequential', format: 'docx', content: '# Content' }, 'call-seq')
        const r1 = await skill.executeTool(req)
        const r2 = await skill.executeTool(req)
        expect(createCalls).toBe(1)
        expect(r1.output).toBe(r2.output)
      })

      it('IDENTITY-V8-04: Exact same operation delivered concurrently. Exactly one physical document is created', async () => {
        let createCalls = 0
        let resolveCreate!: () => void
        const createBarrier = new Promise<void>((res) => {
          resolveCreate = res
        })
        const skill = createDocumentSkill({
          getSessionId: () => 'session-conc',
          getUserTurnId: () => 'turn-conc',
          create: async (r) => {
            createCalls++
            await createBarrier
            return { path: `/Users/me/GenOffice/${r.title}.docx` }
          },
        })
        const req = call({ title: 'Concurrent', format: 'docx', content: '# Content' }, 'call-conc')
        const p1 = skill.executeTool(req)
        const p2 = skill.executeTool(req)
        resolveCreate()
        const [r1, r2] = await Promise.all([p1, p2])
        expect(createCalls).toBe(1)
        expect(r1.output).toBe(r2.output)
      })

      it('IDENTITY-V8-05: History persistence changes the persisted record ID while the stable execution identity remains unchanged. Replay must not create a duplicate', async () => {
        let persistedId: string | null = null
        const executionId = 'stable-exec-v8'
        let createCalls = 0
        const skill = createDocumentSkill({
          getExecutionId: () => executionId,
          getSessionId: () => persistedId || executionId,
          getUserTurnId: () => 'turn-v8-05',
          create: async (r) => {
            createCalls++
            return { path: `/Users/me/GenOffice/${r.title}.docx` }
          },
        })
        const req = call(
          { title: 'PersistedDoc', format: 'docx', content: '# Persist' },
          'call-v8-05',
        )
        const r1 = await skill.executeTool(req)
        expect(createCalls).toBe(1)

        persistedId = 'persisted-record-12345'
        const r2 = await skill.executeTool(req)
        expect(createCalls).toBe(1)
        expect(r1.output).toBe(r2.output)
      })

      it('IDENTITY-V8-06: Forged model session ID cannot override the host session', async () => {
        let forwardedSessionId: string | undefined
        const skill = createDocumentSkill({
          getSessionId: () => 'host-session-real',
          getUserTurnId: () => 'turn-v8-06',
          create: async (r) => {
            forwardedSessionId = r.sessionId
            return { path: `/Users/me/GenOffice/${r.title}.docx` }
          },
        })
        const req = call(
          { title: 'Doc', format: 'docx', content: '# C', sessionId: 'forged-session-id' },
          'call-v8-06',
        )
        await skill.executeTool(req)
        expect(forwardedSessionId).toBe('host-session-real')
      })

      it('IDENTITY-V8-07: Forged model user turn ID cannot override the host user turn', async () => {
        let forwardedTurnId: string | undefined
        const skill = createDocumentSkill({
          getSessionId: () => 'host-session-real',
          getUserTurnId: () => 'host-turn-real',
          create: async (r) => {
            forwardedTurnId = r.userTurnId
            return { path: `/Users/me/GenOffice/${r.title}.docx` }
          },
        })
        const req = call(
          { title: 'Doc', format: 'docx', content: '# C', userTurnId: 'forged-turn-id' },
          'call-v8-07',
        )
        await skill.executeTool(req)
        expect(forwardedTurnId).toBe('host-turn-real')
      })

      it('IDENTITY-V8-08: Missing host identity must not promote forged model identity into a trusted owner', async () => {
        let forwardedReq: CreateDocumentRequest | null = null
        let createCalls = 0
        const skill = createDocumentSkill({
          getSessionId: () => undefined,
          getUserTurnId: () => undefined,
          create: async (r) => {
            createCalls++
            forwardedReq = r
            return { path: `/Users/me/GenOffice/${r.title}.docx` }
          },
        })
        const req = call(
          {
            title: 'Doc',
            format: 'docx',
            content: '# C',
            sessionId: 'forged-session-id',
            userTurnId: 'forged-turn-id',
          },
          'call-v8-08',
        )
        const res = await skill.executeTool(req)
        expect(res.isError).toBeUndefined()
        expect(createCalls).toBe(1)
        expect(forwardedReq!.sessionId).toBeUndefined()
        expect(forwardedReq!.userTurnId).toBeUndefined()
      })

      it('IDENTITY-V8-09: Two legitimate document requests with identical titles but different call IDs generate distinct files', async () => {
        let createCalls = 0
        const skill = createDocumentSkill({
          getSessionId: () => 'session-v8-09',
          getUserTurnId: () => 'turn-v8-09',
          create: async (r) => {
            createCalls++
            return { path: `/Users/me/GenOffice/${r.title}_${r.callId}.docx` }
          },
        })
        const doc1 = call({ title: 'Report', format: 'docx', content: '# Version 1' }, 'call-1')
        const doc2 = call({ title: 'Report', format: 'docx', content: '# Version 2' }, 'call-2')
        const r1 = await skill.executeTool(doc1)
        const r2 = await skill.executeTool(doc2)
        expect(createCalls).toBe(2)
        expect(r1.output).toContain('Report_call-1.docx')
        expect(r2.output).toContain('Report_call-2.docx')
      })

      it('IDENTITY-V8-10: Two explicitly requested identical copies generate two files when the host dispatches two independent operations', async () => {
        let createCalls = 0
        const skill = createDocumentSkill({
          getSessionId: () => 'session-v8-10',
          getUserTurnId: () => 'turn-v8-10',
          create: async (r) => {
            createCalls++
            return { path: `/Users/me/GenOffice/${r.title}_copy${createCalls}.docx` }
          },
        })
        const copy1 = call({ title: 'Budget', format: 'docx', content: '# Numbers' }, 'call-copy-1')
        const copy2 = call({ title: 'Budget', format: 'docx', content: '# Numbers' }, 'call-copy-2')
        const r1 = await skill.executeTool(copy1)
        const r2 = await skill.executeTool(copy2)
        expect(createCalls).toBe(2)
        expect(r1.output).toContain('Budget_copy1.docx')
        expect(r2.output).toContain('Budget_copy2.docx')
      })

      it('IDENTITY-V8-11: Old conversation context cannot create or retrieve a document under the current conversation identity', async () => {
        let currentConv = 'conv-current'
        let createCalls = 0
        const skill = createDocumentSkill({
          getExecutionId: () => currentConv,
          getSessionId: () => currentConv,
          getUserTurnId: () => 'turn-1',
          create: async (r) => {
            createCalls++
            return { path: `/Users/me/GenOffice/${r.title}_${r.sessionId}.docx` }
          },
        })
        currentConv = 'conv-old'
        const rOld = await skill.executeTool(
          call({ title: 'Memo', format: 'docx', content: '# Memo' }, 'call-memo'),
        )
        expect(rOld.output).toContain('Memo_conv-old.docx')

        currentConv = 'conv-new'
        const rNew = await skill.executeTool(
          call({ title: 'Memo', format: 'docx', content: '# Memo' }, 'call-memo'),
        )
        expect(rNew.output).toContain('Memo_conv-new.docx')
        expect(createCalls).toBe(2)
      })

      it('IDENTITY-V8-12: Failed creation followed by retry works without accidentally reusing another operation result', async () => {
        let attempts = 0
        const skill = createDocumentSkill({
          getSessionId: () => 'session-v8-12',
          getUserTurnId: () => 'turn-v8-12',
          create: async (r) => {
            attempts++
            if (attempts === 1) throw new Error('disk full')
            return { path: `/Users/me/GenOffice/${r.title}.docx` }
          },
        })
        const req = call({ title: 'Doc', format: 'docx', content: '# C' }, 'call-retry')
        const r1 = await skill.executeTool(req)
        expect(r1.isError).toBe(true)
        expect(r1.output).toContain('disk full')

        const r2 = await skill.executeTool(req)
        expect(r2.isError).toBeUndefined()
        expect(r2.output).toContain('Doc.docx')
        expect(attempts).toBe(2)
      })

      it('IDENTITY-V8-13: Conflicting payload under same operation identity is rejected with an identity conflict error', async () => {
        let createCalls = 0
        const skill = createDocumentSkill({
          getSessionId: () => 'session-conflict',
          getUserTurnId: () => 'turn-conflict',
          create: async (r) => {
            createCalls++
            return { path: `/Users/me/GenOffice/${r.title}.${r.format}` }
          },
        })
        const req1 = call(
          { title: 'DocA', format: 'docx', content: '# Content A' },
          'call-same-slot',
        )
        const r1 = await skill.executeTool(req1)
        expect(r1.isError).toBeUndefined()
        expect(createCalls).toBe(1)

        const req2 = call(
          { title: 'DocB', format: 'docx', content: '# Content B' },
          'call-same-slot',
        )
        const r2 = await skill.executeTool(req2)
        expect(r2.isError).toBe(true)
        expect(r2.output).toContain('Operation identity conflict')
        expect(createCalls).toBe(1)
      })
    })
  })
})
