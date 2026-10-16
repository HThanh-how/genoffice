import type { AgentToolCall, AgentToolDef, AgentToolResult } from '@genoffice/agent-core'
import { readToolCallBody } from './agy-tool-repair'

/**
 * Text tool protocol for the Antigravity CLI (the fallback; the default is the `--json-schema`
 * object of agy-structured-turn.ts when the installed agy supports it). agy cannot receive
 * function schemas, so the host describes its tools in the prompt and agy answers with
 * <tool_call> blocks. The host executes
 * them in its normal agent loop and sends the results back as the next turn. No MCP and no agy
 * permissions are involved: agy never touches the documents itself.
 */

export const AGY_TOOL_OPEN = '<tool_call>'
export const AGY_TOOL_CLOSE = '</tool_call>'
/** a turn may ask for a few calls at once; more is almost always a runaway answer */
export const AGY_MAX_TOOL_CALLS_PER_TURN = 8
/** per-result cap when results are replayed in the prompt */
export const AGY_TOOL_RESULT_CHARS = 12_000

/** The tool catalogue shown to the model, shared by the text and the schema protocol. */
export function agyToolList(tools: readonly AgentToolDef[]): string {
  return tools
    .map(
      (tool) =>
        `- ${tool.name}: ${tool.description}\n  input schema: ${JSON.stringify(tool.inputSchema)}`,
    )
    .join('\n')
}

export function agyToolNote(tools: AgentToolDef[]): string {
  if (!tools.length) return ''
  const list = agyToolList(tools)
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

export function agyCallId(index: number): string {
  return `agy-${Date.now().toString(36)}-${index}`
}

function findFencedCodeBlockRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const fenceLineRegex = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([a-zA-Z0-9_-]+)?[ \t]*$/
  const lines = text.split('\n')
  let currentOffset = 0
  let openFence: { char: string; len: number; start: number } | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const lineStart = currentOffset
    const lineEnd = currentOffset + line.length
    currentOffset = lineEnd + 1

    if (!openFence) {
      const match = fenceLineRegex.exec(line)
      if (match) {
        openFence = {
          char: match[1]![0]!,
          len: match[1]!.length,
          start: lineStart,
        }
      }
    } else {
      const closeMatch = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (
        closeMatch &&
        closeMatch[1]![0] === openFence.char &&
        closeMatch[1]!.length >= openFence.len
      ) {
        ranges.push({ start: openFence.start, end: lineEnd })
        openFence = null
      }
    }
  }

  if (openFence) {
    ranges.push({ start: openFence.start, end: text.length })
  }

  return ranges
}

/** Split a model reply into visible text and the tool calls it requested. */
export function parseAgyToolCalls(
  text: string,
  known: ReadonlySet<string>,
): { text: string; calls: AgentToolCall[]; invalidBlocks: number } {
  const codeRanges = findFencedCodeBlockRanges(text)
  const isInsideCodeBlock = (pos: number): { inside: boolean; end: number } => {
    for (const r of codeRanges) {
      if (pos >= r.start && pos < r.end) return { inside: true, end: r.end }
    }
    return { inside: false, end: -1 }
  }

  const calls: AgentToolCall[] = []
  let invalidBlocks = 0
  let visible = ''
  let cursor = 0

  while (cursor < text.length) {
    const start = text.indexOf(AGY_TOOL_OPEN, cursor)
    if (start < 0) {
      visible += text.slice(cursor)
      break
    }
    const check = isInsideCodeBlock(start)
    if (check.inside) {
      visible += text.slice(cursor, check.end)
      cursor = check.end
      continue
    }

    visible += text.slice(cursor, start)
    const end = text.indexOf(AGY_TOOL_CLOSE, start + AGY_TOOL_OPEN.length)
    if (end < 0) {
      // unterminated block: treat the tail as the JSON so a cut-off reply still works
      const parsed = parseOne(text.slice(start + AGY_TOOL_OPEN.length), known, calls.length)
      if (parsed) calls.push(parsed)
      else invalidBlocks++
      cursor = text.length
      break
    }
    const parsed = parseOne(text.slice(start + AGY_TOOL_OPEN.length, end), known, calls.length)
    if (parsed) calls.push(parsed)
    else invalidBlocks++
    cursor = end + AGY_TOOL_CLOSE.length
  }

  if (calls.length > AGY_MAX_TOOL_CALLS_PER_TURN) {
    invalidBlocks += calls.length - AGY_MAX_TOOL_CALLS_PER_TURN
    return {
      text: visible.trim(),
      calls: [],
      invalidBlocks,
    }
  }

  return {
    text: visible.trim(),
    calls,
    invalidBlocks,
  }
}

function parseOne(raw: string, known: ReadonlySet<string>, index: number): AgentToolCall | null {
  let body = raw.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(body)
  if (fence) body = fence[1]!
  const call = readToolCallBody(body, known)
  return call ? { id: agyCallId(index), name: call.name, input: call.input } : null
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
