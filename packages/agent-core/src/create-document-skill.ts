import type { AgentToolCall, AgentToolDef } from './types'
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
  open?: boolean | undefined
  sessionId?: string | undefined
  userTurnId?: string | undefined
  documentSlot?: string | undefined
  callId?: string | undefined
  documentType?: DocumentType | undefined
}

export interface CreateDocumentExecutionContext {
  sessionId?: string | undefined
  userTurnId?: string | undefined
  callId?: string | undefined
  documentSlot?: string | undefined
}

/**
 * Replace a document this skill created with its grown Markdown (append_to_document). The skill
 * keeps the accumulated Markdown and always sends the whole text: an .md is rewritten, a .docx is
 * regenerated from it, so the host never has to patch a Word file in place.
 */
export interface CreateDocumentRewriteRequest {
  path: string
  format: CreateDocumentFormat
  /** the whole document as Markdown, previous sections included */
  content: string
  sessionId?: string | undefined
  userTurnId?: string | undefined
  callId?: string | undefined
  documentType?: DocumentType | undefined
}

export interface CreateDocumentDeps {
  create(request: CreateDocumentRequest): Promise<{ path: string; opened?: boolean }>
  /** enables append_to_document; never opens an editor tab (the create already did) */
  rewrite?: (request: CreateDocumentRewriteRequest) => Promise<{ path: string }>
  getSessionId?: () => string | undefined
  getExecutionId?: () => string | undefined
  getUserTurnId?: () => string | undefined
  fileExists?: (path: string) => boolean | Promise<boolean>
  open?: (path: string, context?: CreateDocumentExecutionContext) => boolean | Promise<boolean>
  openDocument?: (
    path: string,
    context?: CreateDocumentExecutionContext,
  ) => boolean | Promise<boolean>
  isOpen?: (path: string) => boolean | Promise<boolean>
  isDocumentOpen?: (path: string) => boolean | Promise<boolean>
  /** sibling tools whose success also makes "I saved it" a true statement */
  alsoSaves?: readonly string[]
}

export interface CreateDocumentSkill extends AgentSkill {
  /** absolute paths this skill wrote during the session */
  createdPaths(): readonly string[]
}

export const CREATE_DOCUMENT_TOOL = 'create_document'
export const APPEND_TO_DOCUMENT_TOOL = 'append_to_document'

/** keep in step with the main-process gate, which refuses larger bodies */
export const CREATE_DOCUMENT_MAX_CHARS = 2_000_000

/** append_to_document calls one user request may make (a runaway loop stops here) */
export const APPEND_TO_DOCUMENT_MAX_CALLS = 12

const SINGLE_CALL_RULE = `When the user asks for a file — a report, summary, memo, notes, "save this",
"export this", "make a document / markdown / Word file" — write the complete
content and call create_document ONCE; do not paste the document into the chat and
do not describe what the file would contain. Never call create_document repeatedly
or in a loop for the same document request.`

// Long documents follow the plan-then-work pattern of agent CLIs (a short checklist first, then
// one item per step): every step is a short model turn the user sees on the progress strip, and
// no single turn has to generate the whole document.
const SECTIONED_RULE = `When the user asks for a file — a report, summary, memo, notes, lesson plan (giáo án),
"save this", "export this", "make a document / markdown / Word file" — write it into a
file with create_document; do not paste the document into the chat and do not describe
what the file would contain.
- Short document (under about 1500 words, one or two sections): write the complete
  content and call create_document once.
- Longer or multi-section document: work through it like a checklist, one short step per reply.
  1. Call create_document with the title, "outline" = every section heading in order,
     and "content" = the document title plus the FIRST section only.
  2. Then call append_to_document once per remaining section, in outline order, with the
     "path" create_document returned, "heading" = that section's heading and "content" =
     that section's Markdown (at most about 800 words). One call per reply; wait for its
     result before writing the next section.
  3. After the last section, reply briefly with the file link.
- Never call create_document again for the same document, never re-send a section that
  was already written, and make at most ${APPEND_TO_DOCUMENT_MAX_CALLS} append_to_document calls per request.`

const CREATE_SYSTEM_PROMPT_TAIL = `
- Before drafting, ask for essential missing details instead of guessing. For a
  lesson plan, confirm the subject, class/grade and week or lesson/topic when the
  user has not supplied them. If ask_user is available, use its option cards;
  ask dependent questions in the next call after reading the answer. If it is
  unavailable, ask in chat and wait. Do not create a file until these are resolved
  or the user explicitly asks you to choose defaults. If the user cancels, stop.
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

export function createDocumentSystemPrompt(sectioned: boolean): string {
  return `## Creating documents\n${sectioned ? SECTIONED_RULE : SINGLE_CALL_RULE}${CREATE_SYSTEM_PROMPT_TAIL}`
}

/** a document create_document wrote, kept so append_to_document can grow it */
interface WrittenDocument {
  path: string
  format: CreateDocumentFormat
  documentType?: DocumentType | undefined
  /** the Markdown the file currently holds */
  markdown: string
  /** section headings create_document announced (the checklist) */
  outline: string[]
  /** sections written so far: 1 after create, +1 per applied append */
  sections: number
  conversationKey?: string | undefined
  userTurnId?: string | undefined
  /** append results by operation id, so a retried call never appends twice */
  ops: Map<string, Promise<AppendOutcome>>
  /** fingerprints of the chunks already appended (a re-sent section is skipped) */
  chunks: Set<string>
  /** appends apply one after another, in call order */
  queue: Promise<unknown>
}

type AppendOutcome = { output: string; isError?: true; summary: string }

function chunkFingerprint(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  let hash = 0x811c9dc5
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${normalized.length}:${(hash >>> 0).toString(36)}`
}

function readOutline(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 200))
    .slice(0, 40)
}

// save-only phrasing: "created" / "generated" also describe corpus facts
// ("the file was created in 2019"), so they are not claims here
const CLAIMS_SAVED =
  /\bI(?:'ve| have)? (?:saved|exported) (?:it|this|that|the|a|an|your)\b|\b(?:has been|have been|is now) saved\b|\bsaved (?:it |the (?:file|document) )?(?:as|to|in) \S+\.(?:md|docx)\b/i

export function createDocumentSkill(deps: CreateDocumentDeps): CreateDocumentSkill {
  const created: string[] = []
  const inFlightOps = new Map<
    string,
    {
      promise: Promise<{ path: string; opened?: boolean }>
      payloadFingerprint: string
      conversationKey?: string | undefined
      userTurnId?: string | undefined
      slot?: string | undefined
    }
  >()
  const committedSlots = new Map<
    string,
    {
      path: string
      opened?: boolean
      payloadFingerprint: string
      conversationKey?: string | undefined
      userTurnId?: string | undefined
      slot?: string | undefined
    }
  >()
  const callBindings = new Map<string, { sessionId?: string | undefined; userTurnId: string }>()

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
        ...(deps.rewrite
          ? {
              outline: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'long documents: every section heading in order; content then holds only the first section and append_to_document adds the rest',
              },
            }
          : {}),
      },
      required: ['title', 'format', 'content'],
    },
  }
  const appendTool: AgentToolDef = {
    name: APPEND_TO_DOCUMENT_TOOL,
    description:
      'Add the next section to a document create_document wrote in this request. ' +
      'Pass the path create_document returned and the section as Markdown (at most about 800 words). ' +
      'One section per call, in outline order; the open document is updated, no new tab opens.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'the path create_document returned' },
        heading: { type: 'string', description: 'the heading of this section' },
        content: { type: 'string', description: 'this section as Markdown' },
      },
      required: ['path', 'content'],
    },
  }

  const written = new Map<string, WrittenDocument>()
  const appendsPerTurn = new Map<string, number>()

  const remember = (
    path: string,
    format: CreateDocumentFormat,
    content: string,
    documentType: DocumentType | undefined,
    outline: string[],
    conversationKey: string | undefined,
    userTurnId: string | undefined,
  ) => {
    if (written.has(path)) return
    if (written.size >= 50) {
      const oldest = written.keys().next().value
      if (oldest !== undefined) written.delete(oldest)
    }
    written.set(path, {
      path,
      format,
      ...(documentType ? { documentType } : {}),
      markdown: content,
      outline,
      sections: 1,
      conversationKey,
      userTurnId,
      ops: new Map(),
      chunks: new Set([chunkFingerprint(content)]),
      queue: Promise.resolve(),
    })
  }

  /** the checklist line the model reads after each write: what is done, what comes next */
  const progressNote = (doc: WrittenDocument): string => {
    if (doc.outline.length < 2) return ''
    const next = doc.outline[doc.sections]
    return next
      ? `\n  progress: section ${Math.min(doc.sections, doc.outline.length)} of ${doc.outline.length} written; next: append_to_document with "${next}"`
      : `\n  progress: all ${doc.outline.length} sections written; give the final answer now`
  }

  const executeAppend = async (call: AgentToolCall): Promise<AppendOutcome> => {
    const rewrite = deps.rewrite
    if (!rewrite) {
      return { output: `unknown tool: ${call.name}`, isError: true, summary: call.name }
    }
    const path = typeof call.input.path === 'string' ? call.input.path.trim() : ''
    const heading = typeof call.input.heading === 'string' ? call.input.heading.trim() : ''
    const raw = typeof call.input.content === 'string' ? call.input.content.trim() : ''
    if (!raw) {
      return { output: 'content must not be empty', isError: true, summary: 'empty content' }
    }
    const doc = path && created.includes(path) ? written.get(path) : undefined
    if (!doc) {
      return {
        output:
          'append_to_document only extends a document create_document wrote in this request; pass the exact path it returned (call create_document first)',
        isError: true,
        summary: 'unknown document',
      }
    }
    // the same host-owned identity create_document uses; the model's arguments are never trusted
    const hostSessionId = deps.getSessionId?.()
    const conversationKey = deps.getExecutionId?.() || hostSessionId
    const userTurnId = deps.getUserTurnId?.()
    if (
      (doc.conversationKey && conversationKey && doc.conversationKey !== conversationKey) ||
      (doc.userTurnId && userTurnId !== undefined && doc.userTurnId !== userTurnId)
    ) {
      // a later request must not overwrite a file the user may have edited since
      return {
        output:
          'this document belongs to an earlier request and cannot be extended now; create a new document instead',
        isError: true,
        summary: 'other request',
      }
    }
    const section = heading && !/^\s{0,3}#{1,6}\s/.test(raw) ? `## ${heading}\n\n${raw}` : raw
    const providerCallId =
      typeof call.id === 'string' && call.id.trim() ? call.id.trim() : undefined
    const inputCallId =
      typeof call.input.callId === 'string' && call.input.callId.trim()
        ? call.input.callId.trim()
        : undefined
    const opId = providerCallId || inputCallId
    const fingerprint = chunkFingerprint(section)
    const opKey = opId ? `id:${opId}` : `chunk:${fingerprint}`
    const known = doc.ops.get(opKey)
    if (known) return known

    const turnKey = `${conversationKey ?? ''}:${userTurnId ?? doc.userTurnId ?? ''}:${doc.path}`
    const used = appendsPerTurn.get(turnKey) ?? 0
    if (used >= APPEND_TO_DOCUMENT_MAX_CALLS) {
      return {
        output: `append limit reached (${APPEND_TO_DOCUMENT_MAX_CALLS} append_to_document calls per request); stop adding sections and give the final answer with the file link`,
        isError: true,
        summary: 'append limit',
      }
    }
    appendsPerTurn.set(turnKey, used + 1)
    if (appendsPerTurn.size > 100) {
      const oldest = appendsPerTurn.keys().next().value
      if (oldest !== undefined) appendsPerTurn.delete(oldest)
    }

    const name = doc.path.split(/[\\/]/).pop() ?? doc.path
    const outcome = doc.queue.then(async (): Promise<AppendOutcome> => {
      if (doc.chunks.has(fingerprint)) {
        // a re-sent section (provider retry with a new id): already in the file
        appendsPerTurn.set(turnKey, Math.max(0, (appendsPerTurn.get(turnKey) ?? 1) - 1))
        return {
          output: `that section is already in ${name}; nothing was added${progressNote(doc)}\n  path: ${doc.path}\n  cite: ${kbCiteHref(doc.path)}`,
          summary: name,
        }
      }
      const next = `${doc.markdown.replace(/\s+$/, '')}\n\n${section}\n`
      if (next.length > CREATE_DOCUMENT_MAX_CHARS) {
        return {
          output: `the document would grow past ${CREATE_DOCUMENT_MAX_CHARS} characters; nothing was added — finish here and give the final answer`,
          isError: true,
          summary: 'content too long',
        }
      }
      await rewrite({
        path: doc.path,
        format: doc.format,
        content: next,
        ...(hostSessionId || conversationKey
          ? { sessionId: (hostSessionId || conversationKey)! }
          : {}),
        ...(userTurnId ? { userTurnId } : {}),
        ...(opId ? { callId: opId } : {}),
        ...(doc.documentType ? { documentType: doc.documentType } : {}),
      })
      doc.markdown = next
      doc.chunks.add(fingerprint)
      doc.sections++
      return {
        output: `added a section to ${name} (${next.length} characters in total)${progressNote(doc)}\n  path: ${doc.path}\n  cite: ${kbCiteHref(doc.path)}`,
        summary: name,
      }
    })
    const settled = outcome.catch((error: unknown): AppendOutcome => {
      const message = error instanceof Error ? error.message : String(error)
      return {
        output: `could not add the section: ${message}`,
        isError: true,
        summary: 'append failed',
      }
    })
    doc.queue = settled
    doc.ops.set(opKey, settled)
    const result = await settled
    if (result.isError) {
      // a failed append may be retried with the same id; it did not count against the cap
      doc.ops.delete(opKey)
      appendsPerTurn.set(turnKey, Math.max(0, (appendsPerTurn.get(turnKey) ?? 1) - 1))
    }
    return result
  }

  return {
    id: 'create-document',
    systemPrompt: createDocumentSystemPrompt(Boolean(deps.rewrite)),
    tools: deps.rewrite ? [tool, appendTool] : [tool],
    createdPaths: () => created,
    executeTool: async (call) => {
      if (call.name === APPEND_TO_DOCUMENT_TOOL && deps.rewrite) return executeAppend(call)
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
      const hasHostExecution = typeof deps.getExecutionId === 'function'
      const hasHostUserTurn = typeof deps.getUserTurnId === 'function'

      const hostExecId = hasHostExecution ? deps.getExecutionId?.() : undefined
      const hostSessionId = hasHostSession ? deps.getSessionId?.() : undefined
      const hostUserTurnId = hasHostUserTurn ? deps.getUserTurnId?.() : undefined
      const hostConvId = hostExecId || hostSessionId

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
      // Host-owned getters are strictly authoritative. Model-supplied sessionId and userTurnId
      // arguments are never trusted or promoted to authoritative context.
      let sessionId: string | undefined = hostSessionId
      let userTurnId: string | undefined = hostUserTurnId

      const bindingKey = effectiveCallId
        ? hostConvId
          ? `${hostConvId}:${effectiveCallId}`
          : effectiveCallId
        : undefined

      if (bindingKey && callBindings.has(bindingKey)) {
        const bound = callBindings.get(bindingKey)!
        if (!hasHostUserTurn || hostUserTurnId === bound.userTurnId) {
          sessionId = bound.sessionId
          userTurnId = bound.userTurnId
        } else {
          // Genuinely distinct user turn reusing call ID -> bind to new turn
          sessionId = hostSessionId
          userTurnId = hostUserTurnId
          if (userTurnId) {
            callBindings.set(bindingKey, { sessionId, userTurnId })
          }
        }
      } else if (bindingKey && userTurnId) {
        if (callBindings.size >= 100) {
          const oldest = callBindings.keys().next().value
          if (oldest !== undefined) callBindings.delete(oldest)
        }
        callBindings.set(bindingKey, { sessionId, userTurnId })
      }

      const documentType =
        typeof call.input.documentType === 'string'
          ? (call.input.documentType as DocumentType)
          : undefined

      const conversationKey = hostConvId || sessionId
      const slotKey =
        conversationKey && userTurnId && hostOpId
          ? `${conversationKey}:${userTurnId}:${hostOpId}`
          : null

      const execContext: CreateDocumentExecutionContext = {
        sessionId: conversationKey,
        userTurnId,
        callId: effectiveCallId,
        documentSlot: rawSlot,
      }

      const payloadFingerprint = JSON.stringify({
        title,
        format,
        content,
        documentType: documentType ?? null,
      })

      const targetSlot = rawSlot || 'primary'

      let matchedCached =
        slotKey && committedSlots.has(slotKey) ? committedSlots.get(slotKey) : undefined
      let matchedKey = slotKey

      if (!matchedCached && conversationKey && userTurnId) {
        for (const [key, entry] of committedSlots.entries()) {
          if (
            entry.conversationKey === conversationKey &&
            entry.userTurnId === userTurnId &&
            entry.slot === targetSlot &&
            entry.payloadFingerprint === payloadFingerprint
          ) {
            matchedCached = entry
            matchedKey = key
            break
          }
        }
      }

      if (matchedCached) {
        if (matchedCached.payloadFingerprint !== payloadFingerprint) {
          return {
            output:
              'could not save the document: Operation identity conflict: conflicting payload for slot',
            isError: true,
            summary: 'identity conflict',
          }
        }
        const exists = deps.fileExists ? await deps.fileExists(matchedCached.path) : true
        if (exists) {
          const shouldAutoOpen =
            typeof call.input.open === 'boolean' ? call.input.open : format === 'docx'
          let opened = false
          if (shouldAutoOpen) {
            if (openFn) {
              try {
                opened = Boolean(await openFn(matchedCached.path, execContext))
              } catch {
                opened = false
              }
            } else if (isOpenFn) {
              try {
                opened = Boolean(await isOpenFn(matchedCached.path))
              } catch {
                opened = false
              }
            } else {
              opened = Boolean(matchedCached.opened)
            }
          }
          matchedCached.opened = opened
          const name = matchedCached.path.split(/[\\/]/).pop() ?? matchedCached.path
          const status = opened ? 'opened in editor' : 'saved to disk (not opened)'
          return {
            output: `saved ${name} (${status})\n  path: ${matchedCached.path}\n  cite: ${kbCiteHref(matchedCached.path)}\n  opened: ${Boolean(opened)}`,
            summary: name,
          }
        } else if (matchedKey) {
          committedSlots.delete(matchedKey)
        }
      }

      let matchedInFlight =
        slotKey && inFlightOps.has(slotKey) ? inFlightOps.get(slotKey) : undefined

      if (!matchedInFlight && conversationKey && userTurnId) {
        for (const entry of inFlightOps.values()) {
          if (
            entry.conversationKey === conversationKey &&
            entry.userTurnId === userTurnId &&
            entry.slot === targetSlot &&
            entry.payloadFingerprint === payloadFingerprint
          ) {
            matchedInFlight = entry
            break
          }
        }
      }

      if (matchedInFlight) {
        if (matchedInFlight.payloadFingerprint !== payloadFingerprint) {
          return {
            output:
              'could not save the document: Operation identity conflict: conflicting payload for slot',
            isError: true,
            summary: 'identity conflict',
          }
        }
        try {
          const cached = await matchedInFlight.promise
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
        if (shouldAutoOpen) {
          if (openFn) {
            try {
              opened = Boolean(await openFn(res.path, execContext))
            } catch {
              opened = false
            }
          } else if (isOpenFn) {
            try {
              opened = Boolean(await isOpenFn(res.path))
            } catch {
              opened = false
            }
          }
        } else {
          opened = false
        }
        return { path: res.path, opened }
      })()

      if (slotKey) {
        inFlightOps.set(slotKey, {
          promise: opPromise,
          payloadFingerprint,
          conversationKey,
          userTurnId,
          slot: targetSlot,
        })
      }
      try {
        const res = await opPromise
        if (slotKey) {
          if (committedSlots.size >= 100) {
            const oldest = committedSlots.keys().next().value
            if (oldest !== undefined) committedSlots.delete(oldest)
          }
          committedSlots.set(slotKey, {
            ...res,
            payloadFingerprint,
            conversationKey,
            userTurnId,
            slot: targetSlot,
          })
        }
        if (!created.includes(res.path)) created.push(res.path)
        remember(
          res.path,
          format,
          content,
          documentType,
          readOutline(call.input.outline),
          conversationKey,
          userTurnId,
        )
        const doc = written.get(res.path)
        const name = res.path.split(/[\\/]/).pop() ?? res.path
        const status = res.opened ? 'opened in editor' : 'saved to disk (not opened)'
        return {
          output: `saved ${name} (${status})\n  path: ${res.path}\n  cite: ${kbCiteHref(res.path)}\n  opened: ${Boolean(res.opened)}${doc ? progressNote(doc) : ''}`,
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
      const savers = [CREATE_DOCUMENT_TOOL, APPEND_TO_DOCUMENT_TOOL, ...(deps.alsoSaves ?? [])]
      const saved = executed.some((c) => savers.includes(c.name) && c.ok)
      if (saved || !CLAIMS_SAVED.test(finalText)) return null
      return (
        'The reply says a file was saved, but create_document did not succeed in this run. ' +
        'Say plainly that nothing was saved; call create_document only if the user asked for a file.'
      )
    },
  }
}
