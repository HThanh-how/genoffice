import { readFileSync, lstatSync, unlinkSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { FileAction } from '@genoffice/agent-core'
import type { CliRunner } from './mcp/cli-runner'
import { cliErrorMessage } from './mcp/cli-runner'
import { FILE_ACTION_MAX_BYTES } from './file-management'
import {
  KB_CREATE_MAX_CHARS,
  writeKnowledgeDocumentContent,
  type KbCreateDeps,
} from './knowledge-base'

/** Called only by the main-process permission gate with revalidated sources. */
function removeIfPresent(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export async function mergeDocuments(
  action: FileAction,
  output: string,
  runner: CliRunner,
  deps: KbCreateDeps,
): Promise<void> {
  const chunks: string[] = []
  let length = 0
  for (const [index, source] of action.sources!.entries()) {
    let markdown: string
    if (extname(source).toLowerCase() === '.md') markdown = readFileSync(source, 'utf8')
    else {
      // Reuse the CLI's DOCX → HTML → GFM conversion, including lists and tables.
      const converted = join(dirname(output), `source-${index}.md`)
      try {
        const result = await runner.run(['convert', source, '--to', 'md', '--out', converted])
        if (!result.ok) throw new Error(cliErrorMessage(result))
        const stat = lstatSync(converted)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FILE_ACTION_MAX_BYTES)
          throw new Error('Invalid or oversized extracted document')
        markdown = readFileSync(converted, 'utf8')
      } finally {
        removeIfPresent(converted)
      }
    }
    // Escape filenames as literal heading text, rather than interpreting Markdown/HTML.
    const name = basename(source).replace(/[\\`*_{}[\]()<>#+.!|~-]/g, '\\$&')
    const chunk = action.separator === 'heading' ? `# ${name}\n\n${markdown}` : markdown
    length += chunk.length + 4
    if (length > KB_CREATE_MAX_CHARS) throw new Error('Merged content is too long')
    chunks.push(chunk)
  }
  const content = chunks.join(action.separator === 'pagebreak' ? '\n\n\f\n\n' : '\n\n')
  await writeKnowledgeDocumentContent(deps, { format: action.format!, content }, output)
}
