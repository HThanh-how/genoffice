/**
 * Lenient reading of the `<tool_call>` text protocol. A model that is asked for strict JSON still
 * slips now and then: a raw newline inside a long string, a trailing comma, a tool name with a
 * namespace prefix, a stray sentence around the object. Rejecting the whole turn for those makes
 * the user retry by hand, so the common slips are repaired here. Only the SHAPE is repaired:
 * whether a tool may run is still decided by the caller against the known tool names.
 */

/** The first top-level `{...}` object in `text`, string-aware; null when none is balanced. */
export function firstJsonObject(text: string): { json: string; end: number } | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return { json: text.slice(start, i + 1), end: i + 1 }
  }
  return null
}

/** Escape raw control characters that appear inside string literals (invalid in JSON). */
function escapeControlsInStrings(json: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (const ch of json) {
    if (inString) {
      if (escaped) {
        escaped = false
        out += ch
      } else if (ch === '\\') {
        escaped = true
        out += ch
      } else if (ch === '"') {
        inString = false
        out += ch
      } else if (ch === '\n') out += '\\n'
      else if (ch === '\r') out += '\\r'
      else if (ch === '\t') out += '\\t'
      else out += ch.charCodeAt(0) < 0x20 ? '' : ch
    } else {
      if (ch === '"') inString = true
      out += ch
    }
  }
  return out
}

/** Remove commas that directly precede `}` or `]` outside strings. */
function dropTrailingCommas(json: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]!
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
    } else if (ch === ',' && /^\s*[}\]]/.test(json.slice(i + 1))) {
      // skip the comma
    } else out += ch
  }
  return out
}

function tryParse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

/** Strict parse first, then the repairs one by one; undefined when nothing yields JSON. */
export function parseLenientJson(json: string): unknown {
  const strict = tryParse(json)
  if (strict !== undefined) return strict
  const controls = escapeControlsInStrings(json)
  const steps = [controls, dropTrailingCommas(controls)]
  for (const candidate of steps) {
    const value = tryParse(candidate)
    if (value !== undefined) return value
  }
  return undefined
}

const NAME_KEYS = ['name', 'tool', 'tool_name', 'toolName', 'function'] as const
const ARG_KEYS = ['arguments', 'input', 'parameters', 'args'] as const

/** `functions.edit_doc`, `GenOffice:edit_doc`, `default_api.edit_doc` -> `edit_doc` when that is known. */
export function resolveToolName(raw: string, known: ReadonlySet<string>): string | null {
  const name = raw.trim()
  if (known.has(name)) return name
  const tail = name.split(/[.:/]/).pop() ?? name
  if (known.has(tail)) return tail
  const lower = tail.toLowerCase()
  for (const candidate of known) if (candidate.toLowerCase() === lower) return candidate
  return null
}

export interface RepairedToolCall {
  name: string
  input: Record<string, unknown>
}

/** One tool call out of a `<tool_call>` body, or null when it cannot be read safely. */
export function readToolCallBody(
  body: string,
  known: ReadonlySet<string>,
): RepairedToolCall | null {
  let value: unknown
  if (body.trim().startsWith('"')) {
    value = parseLenientJson(body.trim()) // the whole call JSON-encoded as a string
    if (typeof value === 'string') value = parseLenientJson(firstJsonObject(value)?.json ?? '')
  } else {
    const object = firstJsonObject(body)
    if (!object) return null
    value = parseLenientJson(object.json)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const rawName = NAME_KEYS.map((key) => record[key]).find((v) => typeof v === 'string')
  if (typeof rawName !== 'string') return null
  const name = resolveToolName(rawName, known)
  if (!name) return null
  let args: unknown = ARG_KEYS.map((key) => record[key]).find((v) => v !== undefined) ?? {}
  if (typeof args === 'string') args = parseLenientJson(args)
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  return { name, input: args as Record<string, unknown> }
}
