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

/** Split a model reply into visible text and the tool calls it requested. */
export function parseAgyToolCalls(
  text: string,
  known: ReadonlySet<string>,
): { text: string; calls: AgentToolCall[]; invalidBlocks: number } {
  const calls: AgentToolCall[] = []
  let invalidBlocks = 0
  let visible = ''
  let i = 0

  const openFenceRegex = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/
  const closeFenceRegex = (char: string, len: number) =>
    new RegExp(`^[ \\t]{0,3}${char === '`' ? '`' : '~'}{${len},}[ \\t]*(?:\\r?\\n|$)`)

  while (i < text.length) {
    // 1. Fenced code block at start of line (indented <= 3 spaces)
    const isLineStart = i === 0 || text[i - 1] === '\n'
    if (isLineStart) {
      const rest = text.slice(i)
      const fenceMatch = openFenceRegex.exec(rest)
      if (fenceMatch) {
        const fenceChars = fenceMatch[1]!
        const infoString = fenceMatch[2]!
        const fenceChar = fenceChars[0]!
        // CommonMark: backtick fence info string cannot contain backticks
        if (fenceChar !== '`' || !infoString.includes('`')) {
          const fenceLen = fenceChars.length
          const lineEnd = fenceMatch[0].length
          const closeRegex = closeFenceRegex(fenceChar, fenceLen)

          let searchOffset = i + lineEnd
          let blockEnd = -1

          while (searchOffset <= text.length) {
            const nextNewline = text.indexOf('\n', searchOffset)
            const currentLineEnd = nextNewline === -1 ? text.length : nextNewline + 1
            const lineContent = text.slice(searchOffset, currentLineEnd)

            if (closeRegex.test(lineContent)) {
              blockEnd = currentLineEnd
              break
            }

            if (nextNewline === -1) {
              blockEnd = text.length
              break
            }
            searchOffset = currentLineEnd
          }

          if (blockEnd === -1) {
            blockEnd = text.length
          }

          // Protected fenced code block: keep in visible text, do not execute tool calls inside
          visible += text.slice(i, blockEnd)
          i = blockEnd
          continue
        }
      }
    }

    // 2. Inline code span (`...`)
    if (text[i] === '`') {
      let delimLen = 1
      while (i + delimLen < text.length && text[i + delimLen] === '`') {
        delimLen++
      }

      let closeIdx = -1
      let searchPos = i + delimLen
      while (searchPos < text.length) {
        if (text[searchPos] === '`') {
          let runLen = 1
          while (searchPos + runLen < text.length && text[searchPos + runLen] === '`') {
            runLen++
          }
          if (runLen === delimLen) {
            closeIdx = searchPos
            break
          }
          searchPos += runLen
          continue
        }
        searchPos++
      }

      if (closeIdx !== -1) {
        const spanEnd = closeIdx + delimLen
        visible += text.slice(i, spanEnd)
        i = spanEnd
        continue
      }
    }

    // 3. Tool call open tag in prose
    if (text.startsWith(AGY_TOOL_OPEN, i)) {
      const startContent = i + AGY_TOOL_OPEN.length
      const closeIdx = text.indexOf(AGY_TOOL_CLOSE, startContent)

      if (closeIdx < 0) {
        // Cut-off tool call to EOF
        const raw = text.slice(startContent)
        const parsed = parseOne(raw, known, calls.length)
        if (parsed) calls.push(parsed)
        else invalidBlocks++
        break
      } else {
        const raw = text.slice(startContent, closeIdx)
        const parsed = parseOne(raw, known, calls.length)
        if (parsed) calls.push(parsed)
        else invalidBlocks++
        i = closeIdx + AGY_TOOL_CLOSE.length
        continue
      }
    }

    // 4. Normal character: advance to next character of interest
    visible += text[i]
    i++
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
  if (body.startsWith('```')) {
    body = body.replace(/^```[a-z0-9_-]*\s*/i, '')
    if (body.endsWith('```')) {
      body = body.slice(0, -3).trim()
    }
  }
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
