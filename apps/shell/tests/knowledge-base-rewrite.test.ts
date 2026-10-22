import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { statSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearKnowledgeDocumentCaches,
  createKnowledgeDocument,
  parseKbRewriteRequest,
  rewriteKnowledgeDocument,
  type KbCreateDeps,
} from '../src/main/knowledge-base'

let dir = ''

function realDeps(): KbCreateDeps {
  return {
    dir: () => dir,
    uniquePath: (folder, name) => join(folder, name),
    sanitizeBase: (title) => title || 'Untitled',
    writeText: (path, text) => writeFile(path, text, 'utf8'),
    // stands in for the bundled CLI: the docx bytes are a pure function of the Markdown
    markdownToDocx: (markdown, out) => writeFile(out, `DOCX\n${markdown}`, 'utf8'),
    recordRecent: () => undefined,
    statFile: (path) => {
      try {
        const stat = statSync(path)
        return { size: stat.size, mtimeMs: stat.mtimeMs }
      } catch {
        return null
      }
    },
  }
}

beforeEach(async () => {
  clearKnowledgeDocumentCaches()
  dir = await mkdtemp(join(tmpdir(), 'kb-rewrite-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('rewriteKnowledgeDocument', () => {
  it('regenerates a created docx from the grown Markdown in place, leaving no temp file', async () => {
    const deps = realDeps()
    const { path } = await createKnowledgeDocument(deps, {
      title: 'Giao an',
      format: 'docx',
      content: '# A',
    })
    await rewriteKnowledgeDocument(deps, { path, format: 'docx', content: '# A\n\n## B\n' })
    await rewriteKnowledgeDocument(deps, { path, format: 'docx', content: '# A\n\n## B\n\n## C\n' })
    expect(await readFile(path, 'utf8')).toBe('DOCX\n# A\n\n## B\n\n## C\n')
    expect(await readdir(dir)).toEqual(['Giao an.docx'])
  })

  it('rewrites an md file', async () => {
    const deps = realDeps()
    const { path } = await createKnowledgeDocument(deps, { title: 'n', format: 'md', content: 'a' })
    await rewriteKnowledgeDocument(deps, { path, format: 'md', content: 'a\n\nb\n' })
    expect(await readFile(path, 'utf8')).toBe('a\n\nb\n')
  })

  it('refuses a path it did not create, a format change and a file edited outside the chat', async () => {
    const deps = realDeps()
    const other = join(dir, 'mine.md')
    await writeFile(other, 'user data', 'utf8')
    await expect(
      rewriteKnowledgeDocument(deps, { path: other, format: 'md', content: 'x' }),
    ).rejects.toThrow(/not created/)
    expect(await readFile(other, 'utf8')).toBe('user data')

    const { path } = await createKnowledgeDocument(deps, { title: 'd', format: 'md', content: 'a' })
    await expect(
      rewriteKnowledgeDocument(deps, { path, format: 'docx', content: 'x' }),
    ).rejects.toThrow(/format/)

    await writeFile(path, 'edited by the user, longer', 'utf8')
    await expect(
      rewriteKnowledgeDocument(deps, { path, format: 'md', content: 'a\n\nb' }),
    ).rejects.toThrow(/changed outside/)
    expect(await readFile(path, 'utf8')).toBe('edited by the user, longer')
  })

  it('validates the payload', () => {
    expect(() => parseKbRewriteRequest({ format: 'md', content: 'x' })).toThrow(/path/)
    expect(() => parseKbRewriteRequest({ path: '/a.md', format: 'pdf', content: 'x' })).toThrow(
      /format/,
    )
    expect(() => parseKbRewriteRequest({ path: '/a.md', format: 'md', content: ' ' })).toThrow(
      /empty/,
    )
    expect(parseKbRewriteRequest({ path: '/a.md', format: 'md', content: 'x' })).toEqual({
      path: '/a.md',
      format: 'md',
      content: 'x',
    })
  })
})
