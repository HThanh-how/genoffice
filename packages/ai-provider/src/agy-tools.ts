import type { AgentToolCall, AgentToolDef, AgentToolResult } from '@genoffice/agent-core'

/**
 * Text tool protocol for the Antigravity CLI. agy cannot receive function schemas, so the host
 * describes its tools in the prompt and agy answers with <tool_call> blocks. The host executes
 * them in its normal agent loop and sends the results back as the next turn. No MCP and no agy
 * permissions are involved: agy never touches the documents itself.
 */

export const AGY_TOOL_OPEN = '<tool_call>'
export const AGY_TOOL_CLOSE = '</tool_call>'
/** a turn may ask for a few calls at once; more is almost always a runaway answer */
export const AGY_MAX_TOOL_CALLS_PER_TURN = 8
/** per-result cap when results are replayed in the prompt */
export const AGY_TOOL_RESULT_CHARS = 12_000

export function agyToolNote(tools: AgentToolDef[]): string {
  if (!tools.length) return ''
  const list = tools
    .map((tool) => `- ${tool.name}: ${tool.description}\n  input schema: ${JSON.stringify(tool.inputSchema)}`)
    .join('\n')
  return (
    'The host application exposes the tools below. You cannot run them yourself: to use one, end your reply with ' +
    `one or more blocks of the exact form ${AGY_TOOL_OPEN}{"name":"<tool>","arguments":{...}}${AGY_TOOL_CLOSE} ` +
    'with valid JSON, then stop. The host runs them and sends the results back as "Tool result" turns. ' +
    'Call a tool whenever the user asks you to read or change the document; do not claim an edit is done until a tool result confirms it. ' +
    'When no tool is needed, reply normally without any block.\n\nTools:\n' +
    list
  )
}

function callId(index: number): string {
  return `agy-${Date.now().toString(36)}-${index}`
}

/** Split a model reply into visible text and the tool calls it requested. */
export function parseAgyToolCalls(
  text: string,
  known: ReadonlySet<string>,
): { text: string; calls: AgentToolCall[] } {
  const calls: AgentToolCall[] = []
  let visible = ''
  let rest = text
  for (;;) {
    const start = rest.indexOf(AGY_TOOL_OPEN)
    if (start < 0) {
      visible += rest
      break
    }
    visible += rest.slice(0, start)
    const end = rest.indexOf(AGY_TOOL_CLOSE, start + AGY_TOOL_OPEN.length)
    if (end < 0) {
      // unterminated block: treat the tail as the JSON so a cut-off reply still works
      const parsed = parseOne(rest.slice(start + AGY_TOOL_OPEN.length), known, calls.length)
      if (parsed) calls.push(parsed)
      break
    }
    const parsed = parseOne(rest.slice(start + AGY_TOOL_OPEN.length, end), known, calls.length)
    if (parsed) calls.push(parsed)
    rest = rest.slice(end + AGY_TOOL_CLOSE.length)
  }
  return { text: visible.trim(), calls: calls.slice(0, AGY_MAX_TOOL_CALLS_PER_TURN) }
}

function parseOne(raw: string, known: ReadonlySet<string>, index: number): AgentToolCall | null {
  let body = raw.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(body)
  if (fence) body = fence[1]!
  try {
    const value = JSON.parse(body) as { name?: unknown; arguments?: unknown; input?: unknown }
    if (typeof value.name !== 'string' || !known.has(value.name)) return null
    const args = value.arguments ?? value.input ?? {}
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
    return { id: callId(index), name: value.name, input: args as Record<string, unknown> }
  } catch {
    return null
  }
}

export function renderAgyToolCalls(calls: AgentToolCall[]): string {
  return calls
    .map((c) => `${AGY_TOOL_OPEN}${JSON.stringify({ name: c.name, arguments: c.input })}${AGY_TOOL_CLOSE}`)
    .join('\n')
}

export function renderAgyToolResult(result: AgentToolResult): string {
  const out =
    result.output.length > AGY_TOOL_RESULT_CHARS
      ? `${result.output.slice(0, AGY_TOOL_RESULT_CHARS)}…`
      : result.output
  return `Tool result (${result.name}${result.isError ? ', error' : ''}): ${out}`
}
