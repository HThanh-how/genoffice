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
  const disk = new Set<string>()
  const deps: KbCreateDeps = {
    dir: () => '/save',
    uniquePath: (dir, name) => `${dir}/${name}`,
    sanitizeBase: (title) => title.replace(/[/:]/g, '_') || 'Untitled',
    writeText: async (path, text) => {
      written.push([path, text])
      disk.add(path)
    },
    markdownToDocx: async (md, out) => {
      converted.push([md, out])
      disk.add(out)
    },
    recordRecent: (path) => void recent.push(path),
    fileExists: (path) => disk.has(path),
  }
  return { deps, written, converted, recent, disk }
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

  it('distinguishes distinct operations with same title using callId', async () => {
    const { deps, recent } = makeDeps()
    let counter = 0
    deps.uniquePath = (dir, name) =>
      counter++ === 0 ? `${dir}/${name}` : `${dir}/${name.replace('.docx', ' (1).docx')}`

    const req1 = {
      title: 'Research Report',
      format: 'docx' as const,
      content: '# Vietnamese version',
      sessionId: 'sess-1',
      userTurnId: 'turn-1',
      callId: 'call-1',
    }
    const req2 = {
      title: 'Research Report',
      format: 'docx' as const,
      content: '# English version',
      sessionId: 'sess-1',
      userTurnId: 'turn-1',
      callId: 'call-2',
    }

    const res1 = await createKnowledgeDocument(deps, req1)
    const res2 = await createKnowledgeDocument(deps, req2)

    expect(res1.path).toBe('/save/Research Report.docx')
    expect(res2.path).toBe('/save/Research Report (1).docx')
    expect(recent).toHaveLength(2)
  })

  it('detects deleted output on retry and creates new file', async () => {
    const { deps, disk } = makeDeps()
    const req = {
      title: 'Contract',
      format: 'docx' as const,
      content: '# Agreement',
      sessionId: 'sess-1',
      userTurnId: 'turn-1',
      callId: 'op-contract',
    }

    const res1 = await createKnowledgeDocument(deps, req)
    expect(res1.path).toBe('/save/Contract.docx')

    // Simulate disk deletion
    disk.delete(res1.path)

    // Retry must not return stale success
    const res2 = await createKnowledgeDocument(deps, req)
    expect(res2.path).toBe('/save/Contract.docx')
    expect(disk.has(res2.path)).toBe(true)
  })

  it('allocates distinct target paths concurrently for same-title documents', async () => {
    const { deps, recent } = makeDeps()
    let resolveFirst!: () => void
    const barrier = new Promise<void>((res) => {
      resolveFirst = res
    })
    let calls = 0
    deps.markdownToDocx = async (_md, _out) => {
      calls++
      if (calls === 1) await barrier
    }

    const req1 = {
      title: 'Parallel Report',
      format: 'docx' as const,
      content: '# Version 1',
      sessionId: 'sess-1',
      userTurnId: 'turn-1',
      callId: 'call-p1',
    }
    const req2 = {
      title: 'Parallel Report',
      format: 'docx' as const,
      content: '# Version 2',
      sessionId: 'sess-1',
      userTurnId: 'turn-1',
      callId: 'call-p2',
    }

    const p1 = createKnowledgeDocument(deps, req1)
    const p2 = createKnowledgeDocument(deps, req2)

    resolveFirst()
    const [res1, res2] = await Promise.all([p1, p2])

    expect(calls).toBe(2)
    expect(res1.path).not.toBe(res2.path)
    expect(recent).toContain(res1.path)
    expect(recent).toContain(res2.path)
  })

  describe('Super Prompt V8: Filesystem collision prevention (PATH-V8-01 through PATH-V8-08)', () => {
    it('PATH-V8-01: Concurrent Report.docx and report.docx on case-insensitive filesystem do not overwrite', async () => {
      const { deps } = makeDeps()
      deps.isCaseSensitive = false
      let resolveFirst!: () => void
      const barrier = new Promise<void>((res) => {
        resolveFirst = res
      })
      let calls = 0
      deps.markdownToDocx = async (_md, _out) => {
        calls++
        if (calls === 1) await barrier
      }

      const p1 = createKnowledgeDocument(deps, {
        title: 'Report',
        format: 'docx',
        content: '# Report 1',
        sessionId: 'sess-ci',
        userTurnId: 'turn-1',
        callId: 'call-1',
      })
      const p2 = createKnowledgeDocument(deps, {
        title: 'report',
        format: 'docx',
        content: '# Report 2',
        sessionId: 'sess-ci',
        userTurnId: 'turn-1',
        callId: 'call-2',
      })

      resolveFirst()
      const [r1, r2] = await Promise.all([p1, p2])

      expect(calls).toBe(2)
      expect(r1.path.toLowerCase()).not.toBe(r2.path.toLowerCase())
      expect(r1.path).toBe('/save/Report.docx')
      expect(r2.path).toBe('/save/report-2.docx')
    })

    it('PATH-V8-02: Two identical titles concurrently produce two independently readable files', async () => {
      const { deps, disk } = makeDeps()
      let resolveFirst!: () => void
      const barrier = new Promise<void>((res) => {
        resolveFirst = res
      })
      let calls = 0
      deps.markdownToDocx = async (_md, _out) => {
        calls++
        if (calls === 1) await barrier
      }

      const p1 = createKnowledgeDocument(deps, {
        title: 'Proposal',
        format: 'docx',
        content: '# Doc 1',
        sessionId: 'sess-p2',
        userTurnId: 'turn-1',
        callId: 'call-a',
      })
      const p2 = createKnowledgeDocument(deps, {
        title: 'Proposal',
        format: 'docx',
        content: '# Doc 2',
        sessionId: 'sess-p2',
        userTurnId: 'turn-1',
        callId: 'call-b',
      })

      resolveFirst()
      const [r1, r2] = await Promise.all([p1, p2])

      expect(calls).toBe(2)
      expect(r1.path).not.toBe(r2.path)
      expect(disk.has(r1.path)).toBe(true)
      expect(disk.has(r2.path)).toBe(true)
    })

    it('PATH-V8-03: Two requests through different directory aliases to the same folder do not collide', async () => {
      const { deps } = makeDeps()
      let resolveFirst!: () => void
      const barrier = new Promise<void>((res) => {
        resolveFirst = res
      })
      let calls = 0
      deps.markdownToDocx = async (_md, _out) => {
        calls++
        if (calls === 1) await barrier
      }

      // First call with normal dir
      deps.dir = () => '/save'
      const p1 = createKnowledgeDocument(deps, {
        title: 'Aliased',
        format: 'docx',
        content: '# 1',
        sessionId: 'sess-alias',
        userTurnId: 'turn-1',
        callId: 'c1',
      })

      // Second call with dot alias in dir
      const deps2 = { ...deps, dir: () => '/save/./' }
      const p2 = createKnowledgeDocument(deps2, {
        title: 'Aliased',
        format: 'docx',
        content: '# 2',
        sessionId: 'sess-alias',
        userTurnId: 'turn-1',
        callId: 'c2',
      })

      resolveFirst()
      const [r1, r2] = await Promise.all([p1, p2])

      expect(r1.path).not.toBe(r2.path)
    })

    it('PATH-V8-04: Same-name requests on a genuinely case-sensitive filesystem remain valid', async () => {
      const { deps } = makeDeps()
      deps.isCaseSensitive = true

      const r1 = await createKnowledgeDocument(deps, {
        title: 'CaseDoc',
        format: 'docx',
        content: '# 1',
        sessionId: 'sess-cs',
        userTurnId: 'turn-1',
        callId: 'c1',
      })
      const r2 = await createKnowledgeDocument(deps, {
        title: 'casedoc',
        format: 'docx',
        content: '# 2',
        sessionId: 'sess-cs',
        userTurnId: 'turn-1',
        callId: 'c2',
      })

      expect(r1.path).toBe('/save/CaseDoc.docx')
      expect(r2.path).toBe('/save/casedoc.docx')
    })

    it('PATH-V8-05: One failed creation releases its reservation without corrupting another request', async () => {
      const { deps } = makeDeps()
      let attempts = 0
      deps.markdownToDocx = async () => {
        attempts++
        if (attempts === 1) throw new Error('write failure')
      }

      await expect(
        createKnowledgeDocument(deps, {
          title: 'FailedReservation',
          format: 'docx',
          content: '# F',
          sessionId: 'sess-f',
          userTurnId: 'turn-1',
          callId: 'c-fail',
        }),
      ).rejects.toThrow('write failure')

      // Subsequent call can now reserve the same base name cleanly
      const res = await createKnowledgeDocument(deps, {
        title: 'FailedReservation',
        format: 'docx',
        content: '# OK',
        sessionId: 'sess-f',
        userTurnId: 'turn-2',
        callId: 'c-ok',
      })
      expect(res.path).toBe('/save/FailedReservation.docx')
    })

    it('PATH-V8-06: Existing user file is never overwritten by an unintended create operation', async () => {
      const { deps, disk } = makeDeps()
      disk.add('/save/Protected.docx')

      const res = await createKnowledgeDocument(deps, {
        title: 'Protected',
        format: 'docx',
        content: '# New',
        sessionId: 'sess-prot',
        userTurnId: 'turn-1',
        callId: 'c-prot',
      })

      expect(res.path).toBe('/save/Protected-2.docx')
      expect(disk.has('/save/Protected.docx')).toBe(true)
      expect(disk.has('/save/Protected-2.docx')).toBe(true)
    })

    it('PATH-V8-07: Simulated external creation between allocation and write does not cause silent replacement', async () => {
      const { deps, disk } = makeDeps()
      let firstCheck = true
      deps.fileExists = (p) => {
        if (p === '/save/Raced.docx' && !firstCheck) {
          return true // Externally created before write
        }
        firstCheck = false
        return disk.has(p)
      }

      const res = await createKnowledgeDocument(deps, {
        title: 'Raced',
        format: 'docx',
        content: '# Content',
        sessionId: 'sess-raced',
        userTurnId: 'turn-1',
        callId: 'c-raced',
      })

      expect(res.path).toBe('/save/Raced-2.docx')
    })

    it('PATH-V8-08: Verify path allocation after a restart or cache reset', async () => {
      const { deps } = makeDeps()
      const r1 = await createKnowledgeDocument(deps, {
        title: 'Doc',
        format: 'docx',
        content: '# 1',
        sessionId: 'sess-reset',
        userTurnId: 'turn-1',
        callId: 'c1',
      })
      expect(r1.path).toBe('/save/Doc.docx')

      clearKnowledgeDocumentCaches()

      const r2 = await createKnowledgeDocument(deps, {
        title: 'Doc',
        format: 'docx',
        content: '# 2',
        sessionId: 'sess-reset',
        userTurnId: 'turn-1',
        callId: 'c2',
      })
      expect(r2.path).toBe('/save/Doc-2.docx')
    })
  })

  describe('Super Prompt V8: Post-write recordRecent resilience (RECENT-V8-01 through RECENT-V8-06)', () => {
    it('RECENT-V8-01: DOCX creation succeeds and recordRecent() throws. Tool still reports saved file', async () => {
      const { deps, disk } = makeDeps()
      deps.recordRecent = () => {
        throw new Error('EACCES: recent database locked')
      }

      const res = await createKnowledgeDocument(deps, {
        title: 'ImportantReport',
        format: 'docx',
        content: '# Important',
        sessionId: 'sess-rec-01',
        userTurnId: 'turn-1',
        callId: 'call-rec-01',
      })

      expect(res.path).toBe('/save/ImportantReport.docx')
      expect(disk.has(res.path)).toBe(true)
    })

    it('RECENT-V8-02: Retry of that same operation returns original path and does not write another file', async () => {
      const { deps, converted } = makeDeps()
      deps.recordRecent = () => {
        throw new Error('Recent DB error')
      }

      const req = {
        title: 'RetryDocx',
        format: 'docx' as const,
        content: '# Content',
        sessionId: 'sess-rec-02',
        userTurnId: 'turn-1',
        callId: 'call-rec-02',
      }

      const r1 = await createKnowledgeDocument(deps, req)
      expect(r1.path).toBe('/save/RetryDocx.docx')
      expect(converted.length).toBe(1)

      // Retry same operation
      const r2 = await createKnowledgeDocument(deps, req)
      expect(r2.path).toBe('/save/RetryDocx.docx')
      // Did not write another file
      expect(converted.length).toBe(1)
    })

    it('RECENT-V8-03: Markdown path behaves consistently when recordRecent throws', async () => {
      const { deps, written } = makeDeps()
      deps.recordRecent = () => {
        throw new Error('Recent error')
      }

      const req = {
        title: 'Notes',
        format: 'md' as const,
        content: '# Notes',
        sessionId: 'sess-rec-03',
        userTurnId: 'turn-1',
        callId: 'call-rec-03',
      }

      const res = await createKnowledgeDocument(deps, req)
      expect(res.path).toBe('/save/Notes.md')
      expect(written.length).toBe(1)

      // Replay
      const r2 = await createKnowledgeDocument(deps, req)
      expect(r2.path).toBe('/save/Notes.md')
      expect(written.length).toBe(1)
    })

    it('RECENT-V8-04: A true write failure remains an error and is not committed', async () => {
      const { deps } = makeDeps()
      deps.markdownToDocx = async () => {
        throw new Error('ENOSPC: no space left on device')
      }

      const req = {
        title: 'DiskFull',
        format: 'docx' as const,
        content: '# Content',
        sessionId: 'sess-rec-04',
        userTurnId: 'turn-1',
        callId: 'call-rec-04',
      }

      await expect(createKnowledgeDocument(deps, req)).rejects.toThrow('ENOSPC')

      // Fix write error and retry
      let convertedCalls = 0
      deps.markdownToDocx = async (_md, out) => {
        convertedCalls++
        deps.disk?.add?.(out)
      }

      const res = await createKnowledgeDocument(deps, req)
      expect(res.path).toBe('/save/DiskFull.docx')
      expect(convertedCalls).toBe(1)
    })

    it('RECENT-V8-05: A subsequent legitimate new operation still creates a new document', async () => {
      const { deps } = makeDeps()
      deps.recordRecent = () => {
        throw new Error('Recent metadata failure')
      }

      const r1 = await createKnowledgeDocument(deps, {
        title: 'FirstDoc',
        format: 'docx',
        content: '# First',
        sessionId: 'sess-rec-05',
        userTurnId: 'turn-1',
        callId: 'call-1',
      })
      const r2 = await createKnowledgeDocument(deps, {
        title: 'SecondDoc',
        format: 'docx',
        content: '# Second',
        sessionId: 'sess-rec-05',
        userTurnId: 'turn-1',
        callId: 'call-2',
      })

      expect(r1.path).toBe('/save/FirstDoc.docx')
      expect(r2.path).toBe('/save/SecondDoc.docx')
    })

    it('RECENT-V8-06: In-flight maps and path reservations are cleaned up after both success and failure', async () => {
      const { deps } = makeDeps()
      let attempts = 0
      deps.markdownToDocx = async () => {
        attempts++
        if (attempts === 1) throw new Error('transient failure')
      }

      await expect(
        createKnowledgeDocument(deps, {
          title: 'CleanupDoc',
          format: 'docx',
          content: '# C',
          sessionId: 'sess-rec-06',
          userTurnId: 'turn-1',
          callId: 'c-clean',
        }),
      ).rejects.toThrow('transient failure')

      // Reservation released, retry succeeds
      const res = await createKnowledgeDocument(deps, {
        title: 'CleanupDoc',
        format: 'docx',
        content: '# C',
        sessionId: 'sess-rec-06',
        userTurnId: 'turn-1',
        callId: 'c-clean',
      })
      expect(res.path).toBe('/save/CleanupDoc.docx')
    })
  })
})
