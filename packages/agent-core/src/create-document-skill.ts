import type { AgentToolDef } from './types'
import type { AgentSkill, ExecutedToolCall } from './skill'
import { kbCiteHref } from './knowledge-base-skill'
import type { DocumentType } from './rich-document-spec'

/**
 * Lets a chat that has no open document write its result to disk: the model
 * drafts the content as markdown and create_document lands it as a .md or
 * .docx in the user's save folder. The skill is storage-agnostic — the host
 * injects the one write operation — so it pairs with the knowledge-base skill
 * on the home screen today and can back a "save as new file" in the editor
 * panels later.
 *
 * The created path is handed back as a filenav cite link (the same primitive
 * the knowledge-base citations use) so the answer can offer a click-to-open
 * link; createdPaths() lets a sibling skill's citation guard accept it.
 */

export type CreateDocumentFormat = 'md' | 'docx'

export interface CreateDocumentRequest {
  title: string
  format: CreateDocumentFormat
  /** the whole document as markdown */
  content: string
  open?: boolean
  sessionId?: string
  userTurnId?: string
  documentSlot?: string
  callId?: string
  documentType?: DocumentType
}

export interface CreateDocumentExecutionContext {
  sessionId?: string | undefined
  userTurnId?: string | undefined
  callId?: string | undefined
  documentSlot?: string | undefined
}

export interface CreateDocumentDeps {
  create(request: CreateDocumentRequest): Promise<{ path: string; opened?: boolean }>
  getSessionId?: () => string | undefined
  getUserTurnId?: () => string | undefined
  fileExists?: (path: string) => boolean | Promise<boolean>
  open?: (path: string, context?: CreateDocumentExecutionContext) => boolean | Promise<boolean>
  openDocument?: (
    path: string,
    context?: CreateDocumentExecutionContext,
  ) => boolean | Promise<boolean>
  isOpen?: (path: string) => boolean | Promise<boolean>
  isDocumentOpen?: (path: string) => boolean | Promise<boolean>
}

export interface CreateDocumentSkill extends AgentSkill {
  /** absolute paths this skill wrote during the session */
  createdPaths(): readonly string[]
}

export const CREATE_DOCUMENT_TOOL = 'create_document'

/** keep in step with the main-process gate, which refuses larger bodies */
export const CREATE_DOCUMENT_MAX_CHARS = 2_000_000

const CREATE_SYSTEM_PROMPT = `## Creating documents
When the user asks for a file — a report, summary, memo, notes, "save this",
"export this", "make a document / markdown / Word file" — write the complete
content and call create_document ONCE; do not paste the document into the chat and
do not describe what the file would contain. Never call create_document repeatedly
or in a loop for the same document request.
- Always read existing sources thoroughly first using available search and read tools
  before synthesizing the document content.
- Write the content in Markdown (headings #/##, bullet/numbered lists, tables with
  pipes, bold). format "docx" gives a Word document (.docx, văn bản / tài liệu Word),
  "md" a Markdown file (.md); pick what the user asked for, default to "docx" when
  they only said "document" / "Word" / "tài liệu" / "văn bản" and "md" when they said Markdown.
- Specify "documentType" if applicable: "scientific-report", "report", "memo", "proposal",
  "letter", or "general".
- In tables, use real columns and headers. Do not collapse tabular data into unstructured text.
- Include a References or Sources section citing source files where applicable.
- Keep the knowledge-base citations inside the document as plain text (file
  name and folder), not as cite links.
- The tool returns the saved path with a cite link: reply briefly and link the
  file as [file name](cite link), copying the link exactly.
- Only claim a file was saved when create_document returned ok.`

// save-only phrasing: "created" / "generated" also describe corpus facts
// ("the file was created in 2019"), so they are not claims here
const CLAIMS_SAVED =
  /\bI(?:'ve| have)? (?:saved|exported) (?:it|this|that|the|a|an|your)\b|\b(?:has been|have been|is now) saved\b|\bsaved (?:it |the (?:file|document) )?(?:as|to|in) \S+\.(?:md|docx)\b/i

export function createDocumentSkill(deps: CreateDocumentDeps): CreateDocumentSkill {
  const created: string[] = []
  const inFlightOps = new Map<string, Promise<{ path: string; opened?: boolean }>>()
  const committedSlots = new Map<string, { path: string; opened?: boolean }>()
  const callBindings = new Map<string, { sessionId: string; userTurnId: string }>()

  const openFn = deps.open ?? deps.openDocument
  const isOpenFn = deps.isOpen ?? deps.isDocumentOpen

  const tool: AgentToolDef = {
    name: CREATE_DOCUMENT_TOOL,
    description:
      'Save a new document in the user’s save folder from Markdown content. ' +
      'format "docx" writes a Word document (.docx), "md" a Markdown file (.md). ' +
      'Use format "docx" for Word documents / văn bản Word. ' +
      'Returns the saved path and its cite link; link it in the reply.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'file name without extension' },
        format: {
          type: 'string',
          enum: ['md', 'docx'],
          description: 'output format ("docx" for Word, "md" for Markdown)',
        },
        content: { type: 'string', description: 'the complete document as Markdown' },
        open: {
          type: 'boolean',
          description: 'whether to open the document immediately in the editor after saving',
        },
        documentType: {
          type: 'string',
          enum: ['general', 'report', 'scientific-report', 'memo', 'proposal', 'letter'],
          description: 'Document profile/type for layout and formatting',
        },
        documentSlot: {
          type: 'string',
          description: 'Logical document slot (default: "primary")',
        },
      },
      required: ['title', 'format', 'content'],
    },
  }
  return {
    id: 'create-document',
    systemPrompt: CREATE_SYSTEM_PROMPT,
    tools: [tool],
    createdPaths: () => created,
    executeTool: async (call) => {
      if (call.name !== CREATE_DOCUMENT_TOOL) {
        return { output: `unknown tool: ${call.name}`, isError: true, summary: call.name }
      }
      const title = typeof call.input.title === 'string' ? call.input.title.trim() : ''
      const rawFormat = call.input.format ?? call.input.type
      const normalizedFormat =
        typeof rawFormat === 'string' ? rawFormat.trim().toLowerCase().replace(/^\./, '') : ''
      const format: CreateDocumentFormat | '' =
        normalizedFormat === 'docx' || normalizedFormat === 'word' || normalizedFormat === 'doc'
          ? 'docx'
          : normalizedFormat === 'md' || normalizedFormat === 'markdown'
            ? 'md'
            : ''
      const content = typeof call.input.content === 'string' ? call.input.content : ''
      if (!format) {
        return { output: 'format must be "md" or "docx"', isError: true, summary: 'bad format' }
      }
      if (!content.trim()) {
        return { output: 'content must not be empty', isError: true, summary: 'empty content' }
      }
      if (content.length > CREATE_DOCUMENT_MAX_CHARS) {
        return {
          output: `content is too long (${content.length} characters, cap ${CREATE_DOCUMENT_MAX_CHARS}); split it into several documents`,
          isError: true,
          summary: 'content too long',
        }
      }

      const hasHostSession = typeof deps.getSessionId === 'function'
      const hasHostUserTurn = typeof deps.getUserTurnId === 'function'

      const hostSessionId = hasHostSession ? deps.getSessionId?.() : undefined
      const hostUserTurnId = hasHostUserTurn ? deps.getUserTurnId?.() : undefined

      const hostCallId =
        typeof call.input.callId === 'string' && call.input.callId.trim()
          ? call.input.callId.trim()
          : undefined
      const rawSlot =
        typeof call.input.documentSlot === 'string' && call.input.documentSlot.trim()
          ? call.input.documentSlot.trim()
          : undefined
      const providerCallId =
        call.id && typeof call.id === 'string' && call.id.trim() ? call.id.trim() : undefined
      const effectiveCallId = providerCallId || hostCallId
      const hostOpId = effectiveCallId || rawSlot

      // Identity Authority & Stability:
      // When authoritative host context getters exist, model-supplied arguments are never trusted.
      // Operations capture their originating host identity once, preserving stability across history persistence and replays.
      let sessionId: string | undefined
      let userTurnId: string | undefined

      if (effectiveCallId && callBindings.has(effectiveCallId)) {
        const bound = callBindings.get(effectiveCallId)!
        if (!hasHostUserTurn || hostUserTurnId === bound.userTurnId) {
          sessionId = bound.sessionId
          userTurnId = bound.userTurnId
        } else {
          // Genuinely distinct user turn reusing call ID -> bind to new turn
          sessionId = hasHostSession
            ? hostSessionId
            : typeof call.input.sessionId === 'string' && call.input.sessionId.trim()
              ? call.input.sessionId.trim()
              : undefined
          userTurnId = hostUserTurnId
          if (sessionId && userTurnId) {
            callBindings.set(effectiveCallId, { sessionId, userTurnId })
          }
        }
      } else {
        sessionId = hasHostSession
          ? hostSessionId
          : typeof call.input.sessionId === 'string' && call.input.sessionId.trim()
            ? call.input.sessionId.trim()
            : undefined
        userTurnId = hasHostUserTurn
          ? hostUserTurnId
          : typeof call.input.userTurnId === 'string' && call.input.userTurnId.trim()
            ? call.input.userTurnId.trim()
            : undefined

        if (effectiveCallId && sessionId && userTurnId) {
          if (callBindings.size >= 100) {
            const oldest = callBindings.keys().next().value
            if (oldest !== undefined) callBindings.delete(oldest)
          }
          callBindings.set(effectiveCallId, { sessionId, userTurnId })
        }
      }

      const documentType =
        typeof call.input.documentType === 'string'
          ? (call.input.documentType as DocumentType)
          : undefined
      const slotKey =
        sessionId && userTurnId && hostOpId ? `${sessionId}:${userTurnId}:${hostOpId}` : null

      const execContext: CreateDocumentExecutionContext = {
        sessionId,
        userTurnId,
        callId: effectiveCallId,
        documentSlot: rawSlot,
      }

      if (slotKey && committedSlots.has(slotKey)) {
        const cached = committedSlots.get(slotKey)!
        const exists = deps.fileExists ? await deps.fileExists(cached.path) : true
        if (exists) {
          const shouldAutoOpen =
            typeof call.input.open === 'boolean' ? call.input.open : format === 'docx'
          let opened = false
          if (shouldAutoOpen) {
            if (isOpenFn) {
              try {
                const alreadyOpen = await isOpenFn(cached.path)
                if (alreadyOpen) {
                  opened = true
                } else if (openFn) {
                  opened = Boolean(await openFn(cached.path, execContext))
                }
              } catch {
                opened = false
              }
            } else if (openFn) {
              try {
                opened = Boolean(await openFn(cached.path, execContext))
              } catch {
                opened = false
              }
            } else {
              opened = Boolean(cached.opened)
            }
          }
          cached.opened = opened
          const name = cached.path.split(/[\\/]/).pop() ?? cached.path
          const status = opened ? 'opened in editor' : 'saved to disk (not opened)'
          return {
            output: `saved ${name} (${status})\n  path: ${cached.path}\n  cite: ${kbCiteHref(cached.path)}\n  opened: ${Boolean(opened)}`,
            summary: name,
          }
        } else {
          committedSlots.delete(slotKey)
        }
      }

      if (slotKey && inFlightOps.has(slotKey)) {
        try {
          const cached = await inFlightOps.get(slotKey)!
          const name = cached.path.split(/[\\/]/).pop() ?? cached.path
          const status = cached.opened ? 'opened in editor' : 'saved to disk (not opened)'
          return {
            output: `saved ${name} (${status})\n  path: ${cached.path}\n  cite: ${kbCiteHref(cached.path)}\n  opened: ${Boolean(cached.opened)}`,
            summary: name,
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return {
            output: `could not save the document: ${message}`,
            isError: true,
            summary: 'save failed',
          }
        }
      }

      const open = typeof call.input.open === 'boolean' ? call.input.open : undefined
      const shouldAutoOpen =
        typeof call.input.open === 'boolean' ? call.input.open : format === 'docx'

      const opPromise = (async () => {
        const res = await deps.create({
          title: title || 'Untitled',
          format,
          content,
          ...(open !== undefined ? { open } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(userTurnId ? { userTurnId } : {}),
          ...(rawSlot ? { documentSlot: rawSlot } : {}),
          ...(effectiveCallId ? { callId: effectiveCallId } : {}),
          ...(documentType ? { documentType } : {}),
        })

        let opened = Boolean(res.opened)
        if (openFn) {
          if (shouldAutoOpen) {
            if (isOpenFn) {
              try {
                const alreadyOpen = await isOpenFn(res.path)
                if (alreadyOpen) {
                  opened = true
                } else {
                  opened = Boolean(await openFn(res.path, execContext))
                }
              } catch {
                opened = false
              }
            } else {
              try {
                opened = Boolean(await openFn(res.path, execContext))
              } catch {
                opened = false
              }
            }
          } else {
            opened = false
          }
        }
        return { path: res.path, opened }
      })()

      if (slotKey) inFlightOps.set(slotKey, opPromise)
      try {
        const res = await opPromise
        if (slotKey) {
          if (committedSlots.size >= 100) {
            const oldest = committedSlots.keys().next().value
            if (oldest !== undefined) committedSlots.delete(oldest)
          }
          committedSlots.set(slotKey, res)
        }
        if (!created.includes(res.path)) created.push(res.path)
        const name = res.path.split(/[\\/]/).pop() ?? res.path
        const status = res.opened ? 'opened in editor' : 'saved to disk (not opened)'
        return {
          output: `saved ${name} (${status})\n  path: ${res.path}\n  cite: ${kbCiteHref(res.path)}\n  opened: ${Boolean(res.opened)}`,
          summary: name,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          output: `could not save the document: ${message}`,
          isError: true,
          summary: 'save failed',
        }
      } finally {
        if (slotKey) inFlightOps.delete(slotKey)
      }
    },
    verifyResponse: (finalText, executed: readonly ExecutedToolCall[]) => {
      const saved = executed.some((c) => c.name === CREATE_DOCUMENT_TOOL && c.ok)
      if (saved || !CLAIMS_SAVED.test(finalText)) return null
      return (
        'The reply says a file was saved, but create_document did not succeed in this run. ' +
        'Say plainly that nothing was saved; call create_document only if the user asked for a file.'
      )
    },
  }
}
