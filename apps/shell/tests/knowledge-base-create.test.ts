import { describe, expect, it, beforeEach } from 'vitest'
import {
  clearKnowledgeDocumentCaches,
  createKnowledgeDocument,
  KB_CREATE_MAX_CHARS,
  parseKbCreateRequest,
  type KbCreateDeps,
} from '../src/main/knowledge-base'

function makeDeps() {
  const written: Array<[string, string]> = []
  const converted: Array<[string, string]> = []
  const recent: string[] = []
  const deps: KbCreateDeps = {
    dir: () => '/save',
    uniquePath: (dir, name) => `${dir}/${name}`,
    sanitizeBase: (title) => title.replace(/[/:]/g, '_') || 'Untitled',
    writeText: async (path, text) => void written.push([path, text]),
    markdownToDocx: async (md, out) => void converted.push([md, out]),
    recordRecent: (path) => void recent.push(path),
  }
  return { deps, written, converted, recent }
}

describe('parseKbCreateRequest', () => {
  it('accepts md and docx and keeps the title as given', () => {
    expect(parseKbCreateRequest({ title: 'a', format: 'md', content: 'x' })).toEqual({
      title: 'a',
      format: 'md',
      content: 'x',
    })
    expect(parseKbCreateRequest({ format: 'docx', content: 'x' }).title).toBe('')
  })

  it('rejects other formats, blank and oversized content', () => {
    expect(() => parseKbCreateRequest({ format: 'pdf', content: 'x' })).toThrow(/format/)
    expect(() => parseKbCreateRequest({ format: 'md', content: ' \n' })).toThrow(/empty/)
    expect(() =>
      parseKbCreateRequest({ format: 'md', content: 'x'.repeat(KB_CREATE_MAX_CHARS + 1) }),
    ).toThrow(/long/)
    expect(() => parseKbCreateRequest(null)).toThrow(/format/)
  })
})

describe('createKnowledgeDocument', () => {
  it('writes markdown as text into the save folder and records it as recent', async () => {
    const { deps, written, converted, recent } = makeDeps()
    const result = await createKnowledgeDocument(deps, {
      title: 'Q3/notes',
      format: 'md',
      content: '# hi',
    })
    expect(result).toEqual({ path: '/save/Q3_notes.md' })
    expect(written).toEqual([['/save/Q3_notes.md', '# hi']])
    expect(converted).toEqual([])
    expect(recent).toEqual(['/save/Q3_notes.md'])
  })

  it('routes docx through the markdown converter', async () => {
    const { deps, written, converted, recent } = makeDeps()
    await createKnowledgeDocument(deps, { title: 'memo', format: 'docx', content: '# hi' })
    expect(converted).toEqual([['# hi', '/save/memo.docx']])
    expect(written).toEqual([])
    expect(recent).toEqual(['/save/memo.docx'])
  })

  beforeEach(() => {
    clearKnowledgeDocumentCaches()
  })

  it('does not record a file the converter failed to write', async () => {
    const { deps, recent } = makeDeps()
    deps.markdownToDocx = async () => {
      throw new Error('cli failed')
    }
    await expect(
      createKnowledgeDocument(deps, { title: 'memo', format: 'docx', content: '# hi' }),
    ).rejects.toThrow('cli failed')
    expect(recent).toEqual([])
  })

  it('deduplicates concurrent calls with identical identity key to single flight', async () => {
    const { deps, recent } = makeDeps()
    let resolveConversion!: () => void
    const barrier = new Promise<void>((res) => {
      resolveConversion = res
    })
    let calls = 0
    deps.markdownToDocx = async (_md, _out) => {
      calls++
      await barrier
    }

    const req = {
      title: 'Report',
      format: 'docx' as const,
      content: '# Title',
      sessionId: 'sess-1',
      userTurnId: 'turn-1',
      documentSlot: 'primary',
    }

    const p1 = createKnowledgeDocument(deps, req)
    const p2 = createKnowledgeDocument(deps, req)

    resolveConversion()
    const [res1, res2] = await Promise.all([p1, p2])

    expect(calls).toBe(1)
    expect(res1.path).toBe('/save/Report.docx')
    expect(res2.path).toBe('/save/Report.docx')
    expect(recent).toEqual(['/save/Report.docx'])
  })

  it('returns committed path for repeated requests with same identity key', async () => {
    const { deps, recent } = makeDeps()
    let uniquePathCalls = 0
    let counter = 0
    deps.uniquePath = (dir, name) => {
      uniquePathCalls++
      return counter++ === 0 ? `${dir}/${name}` : `${dir}/${name.replace('.docx', ' (1).docx')}`
    }

    const req = {
      title: 'Report',
      format: 'docx' as const,
      content: '# Title',
      sessionId: 'sess-1',
      userTurnId: 'turn-1',
      documentSlot: 'primary',
    }

    const res1 = await createKnowledgeDocument(deps, req)
    expect(res1.path).toBe('/save/Report.docx')
    expect(uniquePathCalls).toBe(1)
    expect(recent).toEqual(['/save/Report.docx'])

    // Repeat call with identical identity key must NOT call uniquePath again
    const res2 = await createKnowledgeDocument(deps, req)
    expect(res2.path).toBe('/save/Report.docx')
    expect(uniquePathCalls).toBe(1)
    // Recent file is not duplicated
    expect(recent).toEqual(['/save/Report.docx'])
  })
})
