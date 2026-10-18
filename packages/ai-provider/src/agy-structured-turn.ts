import type { AgentToolCall, AgentToolDef } from '@genoffice/agent-core'
import { AGY_MAX_TOOL_CALLS_PER_TURN, parseAgyToolCalls } from './agy-tools'
import { resolveToolName } from './agy-tool-repair'

/**
 * Two ways a turn with host tools can be answered:
 *
 * - `schema` (default when the installed agy has `--json-schema`): the whole reply is one object
 *   `{ text, tool_calls }` that agy validates and serializes itself (`result.structured_output`),
 *   so a long string argument never has to survive hand-written JSON inside free text.
 * - `text`: `<tool_call>{json}</tool_call>` blocks inside the prose (agy-tools.ts), read by the
 *   lenient reader in agy-tool-repair.ts.
 *
 * Each is the fallback of the other: when one yields nothing readable, the turn is asked once more
 * the other way (see streamAgyTurn).
 *
 * Measured on agy 1.3.2 (gemini-3.8-flash-low, n = 5 per arm, 2026-10-09): schema-first showed no
 * extra model round (agy's closing `finish` step is local, 0.02 s), +2.1% input tokens, and the
 * same wall time (-7%, within noise) as the text protocol; every long argument (about 1k to 1.4k
 * characters with quotes, backslashes, newlines and Vietnamese diacritics) came back exact in both.
 * It does not stream the visible text, which turns with tools never did anyway.
 */
export type AgyToolProtocol = 'text' | 'schema'

/** `GENOFFICE_AGY_TOOL_MODE=text|schema` forces the choice; `schema` still needs `--json-schema`. */
export function resolveAgyToolProtocol(input: {
  hasTools: boolean
  schemaSupported: boolean
  override?: string | undefined
}): AgyToolProtocol {
  if (!input.hasTools || !input.schemaSupported) return 'text'
  return input.override?.trim().toLowerCase() === 'text' ? 'text' : 'schema'
}

/** Sent with the text-protocol retry of a turn whose schema reply was unusable. */
export const AGY_TEXT_RETRY_NOTE =
  'Your previous reply to this request could not be read as a tool request. This time answer in ' +
  'plain text: for a document action output only a valid GenOffice ' +
  '<tool_call>{"name":"tool_name","arguments":{...}}</tool_call> block using one of the listed ' +
  'host tools, then stop. Do not use any Antigravity CLI tool.'

/** Sent when a schema turn failed with agy's own "improperly formatted function call" error. */
export const AGY_SCHEMA_NATIVE_RETRY_NOTE =
  'The previous attempt did not follow the host tool protocol. Do not make native function/API calls. ' +
  'Reply only through the response schema ("text" and "tool_calls") using the listed host tools. ' +
  'Do not claim completion unless a Tool result confirms it.'

/** Sent with the schema retry of a turn whose `<tool_call>` text could not be read. */
export const AGY_STRUCTURED_RETRY_NOTE =
  'Your previous reply to this request contained a tool request that could not be read. ' +
  'Answer again as a single JSON object that matches the supplied schema: put the visible reply ' +
  'text in "text", and put every GenOffice host tool you want run in "tool_calls" (an empty array ' +
  'when none is needed). Do not use any Antigravity CLI tool.'

/**
 * Replaces the `<tool_call>` instructions when a turn is answered through `--json-schema`: the
 * whole reply is the schema object, so there is nothing to wrap in tags and nothing to escape
 * by hand (agy serializes the object).
 */
export const AGY_SCHEMA_TURN_NOTE =
  'Use only the GenOffice host tools listed below. Do not invoke Antigravity CLI tools such as run_command, Generic, MCP, search_web, or file tools; do not request permission or wait for approval. ' +
  'Answer ONLY through the required JSON response schema, in one single step: put the text the user should read in "text", and put every GenOffice host tool you want run in "tool_calls" as {"name":"<tool>","arguments":{...}} (an empty array when no tool is needed). ' +
  'Do not write the reply as plain prose first, and do not wrap tool requests in tags or code fences. The host runs the listed tool calls and sends the results back as "Tool result" turns. ' +
  'Call a tool whenever the user asks you to read or change the document; do not claim an edit is done until a tool result confirms it.'

/** One assistant turn of the history in the shape the schema asks the model to produce. */
export function renderAgyStructuredTurn(text: string, calls: readonly AgentToolCall[]): string {
  return JSON.stringify({
    text: text.trim(),
    tool_calls: calls.map((call) => ({ name: call.name, arguments: call.input })),
  })
}

/** The shape asked for with `--json-schema` on the structured retry. */
export function agyToolTurnSchema(tools: readonly AgentToolDef[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'visible reply for the user, may be empty' },
      tool_calls: {
        type: 'array',
        maxItems: AGY_MAX_TOOL_CALLS_PER_TURN,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', enum: tools.map((tool) => tool.name) },
            arguments: { type: 'object' },
          },
          required: ['name', 'arguments'],
        },
      },
    },
    required: ['text', 'tool_calls'],
  }
}

/**
 * Generic structured turn schema used by resident AGY sessions.
 * Matches agyToolTurnSchema exactly except name has no enum constraint,
 * allowing prewarmed workers to serve variable tool sets safely (validated host-side).
 */
export function agyGenericToolTurnSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'visible reply for the user, may be empty' },
      tool_calls: {
        type: 'array',
        maxItems: AGY_MAX_TOOL_CALLS_PER_TURN,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            arguments: { type: 'object' },
          },
          required: ['name', 'arguments'],
        },
      },
    },
    required: ['text', 'tool_calls'],
  }
}

export interface StructuredToolTurn {
  text: string
  calls: Array<{ name: string; input: Record<string, unknown> }>
}

/** The validated structured reply as a text plus tool calls; null when it is not that shape. */
export function readStructuredToolTurn(
  value: unknown,
  known: ReadonlySet<string>,
): StructuredToolTurn | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'text' && key !== 'tool_calls') return null
  }
  if (typeof record.text !== 'string') return null
  const rawCalls = record.tool_calls
  if (!Array.isArray(rawCalls)) return null
  if (rawCalls.length > AGY_MAX_TOOL_CALLS_PER_TURN) return null
  const calls: StructuredToolTurn['calls'] = []
  for (const raw of rawCalls) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    for (const key of Object.keys(raw as Record<string, unknown>)) {
      if (key !== 'name' && key !== 'arguments') return null
    }
    const { name, arguments: args } = raw as { name?: unknown; arguments?: unknown }
    const resolved = typeof name === 'string' ? resolveToolName(name, known) : null
    if (!resolved) return null
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
    calls.push({ name: resolved, input: args as Record<string, unknown> })
  }
  // A serialized protocol envelope in visible text needs format correction, not execution.
  // Never promote its embedded calls into host actions (it could be a quoted example).
  if (hasAgyToolEnvelopeInText(value, known)) return null
  return { text: record.text.replace(/^\s*<ctrl94>\s*thought\s*<ctrl95>\s*/, '').trim(), calls }
}

export function hasAgyToolEnvelopeInText(value: unknown, known: ReadonlySet<string>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.text === 'string' &&
    Array.isArray(record.tool_calls) &&
    record.tool_calls.length === 0 &&
    parseAgyStructuredText(record.text, known).kind !== 'none'
  )
}

export type AgyStructuredTextResult =
  | { kind: 'valid'; turn: StructuredToolTurn }
  | { kind: 'malformed'; reason: string }
  | { kind: 'none' }

function stripOuterFence(text: string): string {
  const trimmed = text.trim()
  const match = /^(`{3,}|~{3,})[ \t]*(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?\1$/i.exec(trimmed)
  return match ? match[2]!.trim() : trimmed
}

const TRUNCATED_STRUCTURED_ENVELOPE_RE = /^\s*\{\s*(?:["']?tool|["']?text\b)/i

/**
 * Recover a complete standalone structured turn from raw text (e.g. when result.structured_output
 * is absent but the model returned serialized JSON). Enforces strict schema bounds and fail-closed
 * semantics so executable tool requests cannot leak to chat as ordinary text.
 */
export function parseAgyStructuredText(
  rawText: string,
  known: ReadonlySet<string>,
): AgyStructuredTextResult {
  const trimmed = rawText.trim()
  if (!trimmed) return { kind: 'none' }

  const unwrapped = stripOuterFence(trimmed)
  const looksLikeObject = unwrapped.startsWith('{')
  const mentionsToolCalls = unwrapped.includes('"tool_calls"') || unwrapped.includes("'tool_calls'")
  const isTruncatedStructuredTurn =
    looksLikeObject && TRUNCATED_STRUCTURED_ENVELOPE_RE.test(unwrapped)

  if (!looksLikeObject && !mentionsToolCalls) {
    return { kind: 'none' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(unwrapped)
  } catch (err) {
    if ((looksLikeObject && mentionsToolCalls) || isTruncatedStructuredTurn) {
      const msg = err instanceof Error ? err.message : String(err)
      return { kind: 'malformed', reason: `Invalid JSON syntax or trailing content: ${msg}` }
    }
    return { kind: 'none' }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    if (mentionsToolCalls) {
      return { kind: 'malformed', reason: 'Structured turn root must be a JSON object' }
    }
    return { kind: 'none' }
  }

  const record = parsed as Record<string, unknown>
  const hasToolCalls = 'tool_calls' in record
  if (!hasToolCalls) {
    return { kind: 'none' }
  }

  const allowedKeys = new Set(['text', 'tool_calls'])
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      return {
        kind: 'malformed',
        reason: `Unrecognized top-level field "${key}" in structured turn`,
      }
    }
  }

  if (typeof record.text !== 'string') {
    return { kind: 'malformed', reason: 'Field "text" in structured turn must be a string' }
  }

  const rawCalls = record.tool_calls
  if (!Array.isArray(rawCalls)) {
    return { kind: 'malformed', reason: 'Field "tool_calls" must be an array' }
  }

  if (rawCalls.length > AGY_MAX_TOOL_CALLS_PER_TURN) {
    return {
      kind: 'malformed',
      reason: `Tool call count ${rawCalls.length} exceeds limit of ${AGY_MAX_TOOL_CALLS_PER_TURN}`,
    }
  }

  const calls: StructuredToolTurn['calls'] = []
  for (let i = 0; i < rawCalls.length; i++) {
    const raw = rawCalls[i]
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { kind: 'malformed', reason: `tool_calls[${i}] must be an object` }
    }
    const callObj = raw as Record<string, unknown>
    for (const key of Object.keys(callObj)) {
      if (key !== 'name' && key !== 'arguments') {
        return { kind: 'malformed', reason: `tool_calls[${i}] has unrecognized field "${key}"` }
      }
    }
    if (typeof callObj.name !== 'string' || !callObj.name.trim()) {
      return { kind: 'malformed', reason: `tool_calls[${i}] is missing a valid name` }
    }
    const resolved = resolveToolName(callObj.name, known)
    if (!resolved) {
      return { kind: 'malformed', reason: `tool_calls[${i}] names unknown tool "${callObj.name}"` }
    }
    if (
      callObj.arguments === undefined ||
      callObj.arguments === null ||
      typeof callObj.arguments !== 'object' ||
      Array.isArray(callObj.arguments)
    ) {
      return { kind: 'malformed', reason: `tool_calls[${i}] arguments must be a JSON object` }
    }
    calls.push({ name: resolved, input: callObj.arguments as Record<string, unknown> })
  }

  return {
    kind: 'valid',
    turn: {
      text: typeof record.text === 'string' ? record.text.trim() : '',
      calls,
    },
  }
}

export type AgyTurnFromTextResult =
  | { kind: 'valid'; turn: StructuredToolTurn; syntax: 'structured' | 'tags' }
  | { kind: 'prose'; text: string }
  | { kind: 'malformed'; reason: string }

/**
 * Unified turn reader for text responses from the Antigravity CLI.
 * Consistently recognizes:
 * 1. Serialized structured turn JSON ({ text, tool_calls }).
 * 2. Legacy <tool_call> blocks inside text.
 * 3. Ordinary prose (no executable tool calls).
 *
 * Enforces strict fail-closed semantics for malformed structured JSON or
 * corrupted <tool_call> blocks so raw executable requests never leak to chat as prose.
 */
export function readAgyTurnFromText(
  rawText: string,
  known: ReadonlySet<string>,
): AgyTurnFromTextResult {
  const structured = parseAgyStructuredText(rawText, known)
  if (structured.kind === 'valid') {
    return { kind: 'valid', turn: structured.turn, syntax: 'structured' }
  }
  if (structured.kind === 'malformed') {
    return { kind: 'malformed', reason: structured.reason }
  }

  // Not a standalone structured turn; check for <tool_call> tags or normal prose
  const parsed = parseAgyToolCalls(rawText, known)
  if (parsed.invalidBlocks > 0) {
    return {
      kind: 'malformed',
      reason: `${parsed.invalidBlocks} malformed GenOffice <tool_call> block(s)`,
    }
  }
  if (parsed.calls.length > 0) {
    return {
      kind: 'valid',
      turn: {
        text: parsed.text,
        calls: parsed.calls.map((c) => ({ name: c.name, input: c.input })),
      },
      syntax: 'tags',
    }
  }
  return { kind: 'prose', text: parsed.text }
}
