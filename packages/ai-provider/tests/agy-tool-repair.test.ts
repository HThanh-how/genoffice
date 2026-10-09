import { describe, expect, it } from 'vitest'
import { parseAgyToolCalls } from '../src/agy-tools'
import {
  firstJsonObject,
  parseLenientJson,
  readToolCallBody,
  resolveToolName,
} from '../src/agy-tool-repair'

const known = new Set(['replace_text', 'read_document'])
const wrap = (body: string) => `<tool_call>${body}</tool_call>`

describe('lenient <tool_call> reading', () => {
  it('still reads a strict block', () => {
    const r = parseAgyToolCalls(wrap('{"name":"replace_text","arguments":{"find":"a"}}'), known)
    expect(r.invalidBlocks).toBe(0)
    expect(r.calls[0]).toMatchObject({ name: 'replace_text', input: { find: 'a' } })
  })

  it('repairs a raw newline and tab inside a string', () => {
    const r = parseAgyToolCalls(
      wrap('{"name":"replace_text","arguments":{"find":"line one\nline\ttwo"}}'),
      known,
    )
    expect(r.invalidBlocks).toBe(0)
    expect(r.calls[0]!.input).toEqual({ find: 'line one\nline\ttwo' })
  })

  it('drops trailing commas but never touches commas inside strings', () => {
    const r = parseAgyToolCalls(
      wrap('{"name":"replace_text","arguments":{"find":"a,}","x":[1,2,],},}'),
      known,
    )
    expect(r.invalidBlocks).toBe(0)
    expect(r.calls[0]!.input).toEqual({ find: 'a,}', x: [1, 2] })
  })

  it('ignores chatter around the object and a code fence', () => {
    const r = parseAgyToolCalls(
      wrap('Sure, here you go:\n```json\n{"name":"read_document","arguments":{}}\n```\nDone.'),
      known,
    )
    expect(r.invalidBlocks).toBe(0)
    expect(r.calls[0]!.name).toBe('read_document')
  })

  it('accepts alias keys and a namespaced or differently cased tool name', () => {
    expect(
      readToolCallBody('{"tool":"functions.replace_text","args":{"find":"b"}}', known),
    ).toEqual({
      name: 'replace_text',
      input: { find: 'b' },
    })
    expect(readToolCallBody('{"name":"READ_DOCUMENT","parameters":{}}', known)?.name).toBe(
      'read_document',
    )
  })

  it('accepts arguments or the whole call encoded as a JSON string', () => {
    expect(
      readToolCallBody('{"name":"replace_text","arguments":"{\\"find\\":\\"c\\"}"}', known)?.input,
    ).toEqual({ find: 'c' })
    expect(
      readToolCallBody(JSON.stringify('{"name":"read_document","arguments":{}}'), known)?.name,
    ).toBe('read_document')
  })

  it('treats a truncated reply (no closing tag) like before', () => {
    const r = parseAgyToolCalls('<tool_call>{"name":"read_document","arguments":{}}', known)
    expect(r.invalidBlocks).toBe(0)
    expect(r.calls).toHaveLength(1)
  })

  it('never runs a tool that is not in the known set, however it is spelled', () => {
    for (const body of [
      '{"name":"run_command","arguments":{"cmd":"ls"}}',
      '{"name":"functions.run_command","arguments":{}}',
      '{"name":"search_web","arguments":{}}',
    ]) {
      const r = parseAgyToolCalls(wrap(body), known)
      expect(r.calls).toHaveLength(0)
      expect(r.invalidBlocks).toBe(1)
    }
  })

  it('still rejects what cannot be read safely', () => {
    for (const body of [
      'not json at all',
      '{"name":"replace_text","arguments":[1,2]}',
      '{"name":"replace_text","arguments":"nope"}',
      '{"arguments":{}}',
      '{"name":"replace_text","arguments":{"find":"unterminated}',
    ]) {
      const r = parseAgyToolCalls(wrap(body), known)
      expect(r.calls).toHaveLength(0)
      expect(r.invalidBlocks).toBe(1)
    }
  })

  it('helpers: balanced object extraction is string-aware', () => {
    expect(firstJsonObject('x {"a":"}{","b":{"c":1}} y')?.json).toBe('{"a":"}{","b":{"c":1}}')
    expect(firstJsonObject('{"a":')).toBeNull()
    expect(parseLenientJson('{"a":1,}')).toEqual({ a: 1 })
    expect(parseLenientJson('{bad')).toBeUndefined()
    expect(resolveToolName('GenOffice:read_document', known)).toBe('read_document')
    expect(resolveToolName('other', known)).toBeNull()
  })
})
