import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  MAX_INSTRUCTIONS_CHARS,
  REPLY_LANGUAGES,
  type ReplyLanguage,
} from '../../shared/fork/ai-instructions-meta'

/** What the file holds before the person writes anything: only comments, so nothing is sent. */
export const INSTRUCTIONS_TEMPLATE = `<!--
Your instructions for the AI. GenOffice adds this text to every AI conversation.
Write plain sentences, one rule per line. For example:
- Address me as "anh".
- Keep answers short. Use a table when comparing things.
- Documents are for a school in Vietnam: use Vietnamese terms and dd/mm/yyyy dates.
Lines inside these comment markers are ignored.
-->
`

/** The text without HTML comments, trimmed and capped. */
export function effectiveInstructions(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
    .slice(0, MAX_INSTRUCTIONS_CHARS)
}

/** The block added to the system prompt, or '' when there is nothing to add. */
export function buildAddendum(language: ReplyLanguage, instructionsText: string): string {
  const parts: string[] = []
  const name = REPLY_LANGUAGES.find((l) => l.code === language)?.english
  if (name) {
    parts.push(
      `Reply language: write every reply to the user in ${name}. Do not translate code, formulas, file names, JSON or tool-call arguments. If the user explicitly asks for another language, follow the user.`,
    )
  }
  const text = effectiveInstructions(instructionsText)
  if (text) {
    parts.push(
      `Instructions from the user (set in GenOffice Settings). Follow them unless they conflict with the tool rules above:\n${text}`,
    )
  }
  return parts.join('\n\n')
}

/** Reads the instructions file, creating it with the template on first use. Re-read only when it changes. */
export function createInstructionsFile(path: string) {
  let cached: { mtime: number; text: string } | null = null
  const ensure = () => {
    try {
      statSync(path)
    } catch {
      try {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, INSTRUCTIONS_TEMPLATE, { encoding: 'utf8', flag: 'wx' })
      } catch {
        /* not writable: treated as empty */
      }
    }
  }
  return {
    read(): string {
      ensure()
      try {
        const mtime = statSync(path).mtimeMs
        if (cached?.mtime !== mtime) cached = { mtime, text: readFileSync(path, 'utf8') }
        return cached.text
      } catch {
        return ''
      }
    },
    write(text: string): void {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text.slice(0, MAX_INSTRUCTIONS_CHARS * 2), 'utf8')
      cached = null
    },
  }
}
