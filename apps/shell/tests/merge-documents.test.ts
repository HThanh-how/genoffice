import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileAction } from '@genoffice/agent-core'
import { mergeDocuments } from '../src/main/merge-documents'
import { KB_CREATE_MAX_CHARS, type KbCreateDeps } from '../src/main/knowledge-base'
import type { CliRunner } from '../src/main/mcp/cli-runner'

const scratch = resolve('../../working_dir/merge-document-tests')
let dir: string
let deps: KbCreateDeps
let runner: CliRunner
beforeEach(() => {
  mkdirSync(scratch, { recursive: true })
  dir = mkdtempSync(join(scratch, 'case-'))
  deps = {
    dir: () => dir,
    uniquePath: (dir, name) => join(dir, name),
    sanitizeBase: (s) => s,
    writeText: async (path, text) => {
      writeFileSync(path, text)
    },
    markdownToDocx: vi.fn(async () => {}),
    recordRecent: () => {},
  }
  runner = {
    run: vi.fn(async () => {
      throw new Error('Unexpected conversion')
    }),
  }
})
afterEach(() => {
  if (!dir.startsWith(scratch + '/') && !dir.startsWith(scratch + '\\'))
    throw new Error('Unsafe cleanup')
  rmSync(dir, { recursive: true, force: true })
})
const action = (separator: FileAction['separator'] = 'none'): FileAction => ({
  tool: 'merge_documents',
  sources: [join(dir, 'B.md'), join(dir, 'A.md')],
  title: 'Combined',
  format: 'md',
  separator,
})

describe('document merge content', () => {
  it.each(['heading', 'pagebreak', 'none'] as const)(
    'preserves order, tables and lists with %s separators',
    async (separator) => {
      const b = '## B\n\n- item\n- second\n\n| Key | Value |\n| --- | --- |\n| x | y |'
      const a = '# A\n\n1. first\n2. next'
      writeFileSync(join(dir, 'B.md'), b)
      writeFileSync(join(dir, 'A.md'), a)
      const out = join(dir, 'Combined.md')
      await mergeDocuments(action(separator), out, runner, deps)
      const expected =
        separator === 'heading'
          ? `# B\\.md\n\n${b}\n\n# A\\.md\n\n${a}`
          : `${b}${separator === 'pagebreak' ? '\n\n\f\n\n' : '\n\n'}${a}`
      expect(readFileSync(out, 'utf8')).toBe(expected)
      expect(readFileSync(join(dir, 'B.md'), 'utf8')).toBe(b)
      expect(readFileSync(join(dir, 'A.md'), 'utf8')).toBe(a)
      expect(runner.run).not.toHaveBeenCalled()
    },
  )

  it('delegates DOCX extraction and output to the existing converters', async () => {
    const source = join(dir, 'B.docx')
    writeFileSync(source, 'source bytes')
    writeFileSync(join(dir, 'A.md'), '# A')
    runner.run = vi.fn(async (args) => {
      expect(args.slice(0, 4)).toEqual(['convert', source, '--to', 'md'])
      writeFileSync(args[5]!, '# B\n\n- item\n\n| H |\n| --- |\n| cell |')
      return { ok: true, code: 0, stdout: '', stderr: '' }
    })
    const a = { ...action(), sources: [source, join(dir, 'A.md')], format: 'docx' as const }
    const out = join(dir, 'Combined.docx')
    await mergeDocuments(a, out, runner, deps)
    expect(deps.markdownToDocx).toHaveBeenCalledWith(
      '# B\n\n- item\n\n| H |\n| --- |\n| cell |\n\n# A',
      out,
      undefined,
    )
    expect(readFileSync(source, 'utf8')).toBe('source bytes')
  })

  it('bounds extracted content and never invokes the writer after extraction failure', async () => {
    writeFileSync(join(dir, 'B.md'), 'x'.repeat(KB_CREATE_MAX_CHARS))
    writeFileSync(join(dir, 'A.md'), 'A')
    const writer = vi.spyOn(deps, 'writeText')
    await expect(mergeDocuments(action(), join(dir, 'out.md'), runner, deps)).rejects.toThrow(
      /too long/,
    )
    expect(writer).not.toHaveBeenCalled()
    await expect(
      mergeDocuments(
        { ...action(), sources: [join(dir, 'bad.docx'), join(dir, 'A.md')] },
        join(dir, 'out.md'),
        runner,
        deps,
      ),
    ).rejects.toThrow(/Unexpected conversion/)
    expect(writer).not.toHaveBeenCalled()
  })
})
