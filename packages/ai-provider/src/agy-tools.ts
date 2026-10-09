import type { AgentToolCall, AgentToolDef, AgentToolResult } from '@genoffice/agent-core'
import { readToolCallBody } from './agy-tool-repair'

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
    .map(
      (tool) =>
        `- ${tool.name}: ${tool.description}\n  input schema: ${JSON.stringify(tool.inputSchema)}`,
    )
    .join('\n')
  return (
    'Use only the GenOffice host tools listed below. Do not invoke Antigravity CLI tools such as run_command, Generic, MCP, search_web, or file tools; do not request permission or wait for approval. ' +
    'To use a listed GenOffice tool, output one or more plain-text blocks of the exact form ' +
    `${AGY_TOOL_OPEN}{"name":"<tool>","arguments":{...}}${AGY_TOOL_CLOSE} ` +
    'with valid JSON, then stop. This is a plain-text protocol: do not make or imitate native function/API calls, emit function-call JSON, or invoke a native CLI tool. The host runs these blocks and sends results back as "Tool result" turns. ' +
    'Call a tool whenever the user asks you to read or change the document; do not claim an edit is done until a tool result confirms it. ' +
    'When no listed host tool is needed, reply normally without any block.\n\nGenOffice tools:\n' +
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
): { text: string; calls: AgentToolCall[]; invalidBlocks: number } {
  const calls: AgentToolCall[] = []
  let invalidBlocks = 0
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
      else invalidBlocks++
      break
    }
    const parsed = parseOne(rest.slice(start + AGY_TOOL_OPEN.length, end), known, calls.length)
    if (parsed) calls.push(parsed)
    else invalidBlocks++
    rest = rest.slice(end + AGY_TOOL_CLOSE.length)
  }
  return {
    text: visible.trim(),
    calls: calls.slice(0, AGY_MAX_TOOL_CALLS_PER_TURN),
    invalidBlocks,
  }
}

function parseOne(raw: string, known: ReadonlySet<string>, index: number): AgentToolCall | null {
  let body = raw.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(body)
  if (fence) body = fence[1]!
  const call = readToolCallBody(body, known)
  return call ? { id: callId(index), name: call.name, input: call.input } : null
}

export function renderAgyToolCalls(calls: AgentToolCall[]): string {
  return calls
    .map(
      (c) =>
        `${AGY_TOOL_OPEN}${JSON.stringify({ name: c.name, arguments: c.input })}${AGY_TOOL_CLOSE}`,
    )
    .join('\n')
}

export function renderAgyToolResult(result: AgentToolResult): string {
  const out =
    result.output.length > AGY_TOOL_RESULT_CHARS
      ? `${result.output.slice(0, AGY_TOOL_RESULT_CHARS)}…`
      : result.output
  return `Tool result (${result.name}${result.isError ? ', error' : ''}): ${out}`
}
