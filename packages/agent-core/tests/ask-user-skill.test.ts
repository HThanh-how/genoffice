import { describe, expect, it, vi } from 'vitest'
import {
  AgentLoop,
  AskUserController,
  createAskUserSkill,
  createDocumentSystemPrompt,
  type AgentMessage,
  type AskUserQuestion,
  type AskUserRequest,
} from '../src'

const questions: AskUserQuestion[] = [
  {
    question: 'Which subject?',
    header: 'Subject',
    multiSelect: false,
    options: [
      { label: 'Math', description: 'Numbers and geometry' },
      { label: 'Language', description: 'Reading and writing' },
    ],
  },
]
const call = (input: Record<string, unknown>) => ({ id: 'ask-1', name: 'ask_user', input })
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('ask_user', () => {
  it('waits for the card, then returns its answers through the host loop to the model', async () => {
    let pending: AskUserRequest | null = null
    const controller = new AskUserController((request) => {
      pending = request
    })
    const turns: AgentMessage[][] = []
    const loop = new AgentLoop({
      skill: createAskUserSkill({ ask: controller.ask }),
      transport: {
        stream(request, cb) {
          turns.push([...request.messages])
          queueMicrotask(() => {
            if (turns.length === 1) cb.onToolCall(call({ questions }))
            else cb.onDelta('Thanks, Math it is.')
            cb.onDone()
          })
          return { cancel() {} }
        },
      },
    })
    loop.run('Create a lesson plan')
    await tick()
    expect(turns).toHaveLength(1)
    expect(loop.busy).toBe(true)
    expect(pending).not.toBeNull()
    const answer = { answers: [{ q: questions[0].question, a: 'Math' }] }
    ;(pending as unknown as AskUserRequest).respond(answer)
    await tick()
    expect(turns).toHaveLength(2)
    expect(turns[1].at(-1)).toMatchObject({
      role: 'tool',
      results: [{ name: 'ask_user', output: JSON.stringify(answer) }],
    })
    expect(pending).toBeNull()
    expect(loop.busy).toBe(false)
  })

  it('clears a pending card on loop reset and ignores its late answer', async () => {
    let pending: AskUserRequest | null = null
    const controller = new AskUserController((request) => {
      pending = request
    })
    const stream = vi.fn((_request, cb) => {
      queueMicrotask(() => {
        cb.onToolCall(call({ questions }))
        cb.onDone()
      })
      return { cancel() {} }
    })
    const loop = new AgentLoop({
      skill: createAskUserSkill({ ask: controller.ask }),
      transport: { stream },
    })
    loop.run('Question')
    await tick()
    const old = pending as unknown as AskUserRequest
    expect(old).not.toBeNull()
    loop.reset()
    expect(pending).toBeNull()
    old.respond({ answers: [{ q: 'Which subject?', a: 'Late answer' }] })
    await tick()
    expect(loop.messages).toEqual([])
    expect(stream).toHaveBeenCalledTimes(1)
  })

  it('handles multi-select, Other text and explicit skip as tool results', async () => {
    const answer = { answers: [{ q: 'Which subject?', a: 'Math、Language、Science (Other)' }] }
    const ask = vi.fn(async () => answer)
    const skill = createAskUserSkill({ ask })
    expect(
      await skill.executeTool(call({ questions: [{ ...questions[0], multiSelect: true }] })),
    ).toMatchObject({ output: JSON.stringify(answer) })
    ask.mockResolvedValueOnce({ answers: [], cancelled: true } as typeof answer)
    expect(await skill.executeTool(call({ questions }))).toMatchObject({
      output: '{"answers":[],"cancelled":true}',
    })
  })

  it.each([
    [],
    Array(5).fill(questions[0]),
    [null],
    [{ ...questions[0], question: '' }],
    [{ ...questions[0], multiSelect: undefined }],
    [{ ...questions[0], options: [{ label: 'Only one', description: 'Invalid' }] }],
    [{ ...questions[0], options: Array(2).fill(questions[0].options[0]) }],
  ])('rejects malformed questions without opening a card: %j', async (raw) => {
    const ask = vi.fn()
    expect(await createAskUserSkill({ ask }).executeTool(call({ questions: raw }))).toMatchObject({
      isError: true,
    })
    expect(ask).not.toHaveBeenCalled()
  })

  it('cancels replaced requests, uses fresh card ids and ignores stale responses', async () => {
    const requests: AskUserRequest[] = []
    const controller = new AskUserController((request) => {
      if (request) requests.push(request)
    })
    const first = controller.ask(questions)
    const second = controller.ask(questions)
    expect(await first).toEqual({ answers: [], cancelled: true })
    expect(requests[1].id).not.toBe(requests[0].id)
    requests[0].respond({ answers: [{ q: 'stale', a: 'stale' }] })
    requests[1].respond({ answers: [{ q: 'Which subject?', a: 'Math' }] })
    expect(await second).toEqual({ answers: [{ q: 'Which subject?', a: 'Math' }] })
  })

  it('does not open a card for an already aborted request', async () => {
    const onChange = vi.fn()
    const controller = new AskUserController(onChange)
    const abort = new AbortController()
    abort.abort()
    expect(await controller.ask(questions, abort.signal)).toEqual({ answers: [], cancelled: true })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('asks for subject, class and week before document creation', () => {
    for (const sectioned of [true, false]) {
      const prompt = createDocumentSystemPrompt(sectioned)
      expect(prompt).toContain('ask_user')
      expect(prompt).toContain('subject, class/grade and week')
      expect(prompt).toContain('instead of guessing')
    }
  })
})
