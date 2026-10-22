import type { AgentSkill } from './skill'

/** Claude Code AskUserQuestion input; Other is supplied by the host UI. */
export interface AskUserQuestion {
  question: string
  header: string
  options: Array<{ label: string; description: string }>
  multiSelect: boolean
}

export interface AskUserAnswer {
  answers: Array<{ q: string; a: string }>
  cancelled?: boolean
}

export interface AskUserRequest {
  id: number
  questions: AskUserQuestion[]
  respond(answer: AskUserAnswer): void
}

/** One questionnaire per host chat. Stop/reset aborts and removes its pending card. */
export class AskUserController {
  private pending: AskUserRequest | null = null
  private nextId = 0

  constructor(private readonly onChange: (request: AskUserRequest | null) => void) {}

  ask = (questions: AskUserQuestion[], signal?: AbortSignal): Promise<AskUserAnswer> => {
    if (signal?.aborted) return Promise.resolve({ answers: [], cancelled: true })
    this.pending?.respond({ answers: [], cancelled: true })
    return new Promise((resolve) => {
      const cancel = () => request.respond({ answers: [], cancelled: true })
      let settled = false
      const request: AskUserRequest = {
        id: ++this.nextId,
        questions,
        respond: (answer) => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', cancel)
          if (this.pending === request) {
            this.pending = null
            this.onChange(null)
          }
          resolve(answer)
        },
      }
      this.pending = request
      signal?.addEventListener('abort', cancel, { once: true })
      this.onChange(request)
    })
  }
}

function parseQuestions(raw: unknown): AskUserQuestion[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) return null
  const nonempty = (v: unknown): v is string => typeof v === 'string' && !!v.trim()
  const seen = new Set<string>()
  for (const q of raw) {
    if (
      !q ||
      !nonempty(q.question) ||
      !nonempty(q.header) ||
      typeof q.multiSelect !== 'boolean' ||
      !Array.isArray(q.options) ||
      q.options.length < 2 ||
      q.options.length > 4 ||
      seen.has(q.question)
    )
      return null
    seen.add(q.question)
    const labels = new Set<string>()
    for (const option of q.options) {
      if (
        !option ||
        !nonempty(option.label) ||
        !nonempty(option.description) ||
        labels.has(option.label)
      )
        return null
      labels.add(option.label)
    }
  }
  return raw as AskUserQuestion[]
}

export function createAskUserSkill(deps: {
  ask(questions: AskUserQuestion[], signal?: AbortSignal): Promise<AskUserAnswer>
}): AgentSkill {
  return {
    id: 'ask-user',
    systemPrompt: `## Clarifying questions
When essential information is missing, call ask_user instead of guessing. Ask only
what the user has not supplied. Use short headers and concrete, localized options
with descriptions. The UI always supplies Other free text. Ask dependent questions
in a later call after reading the previous answer. Do not repeat the questionnaire
in chat. A cancelled questionnaire means stop that task; never infer its answers.
This is a host tool, including on AGY: never call native ask_question or a second
provider questionnaire. Use the host tool protocol and wait for its result.`,
    tools: [
      {
        name: 'ask_user',
        description:
          'Ask the user 1–4 clarifying questions with selectable options and Other free text.',
        inputSchema: {
          type: 'object',
          properties: {
            questions: {
              type: 'array',
              minItems: 1,
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  question: { type: 'string' },
                  header: { type: 'string' },
                  options: {
                    type: 'array',
                    minItems: 2,
                    maxItems: 4,
                    items: {
                      type: 'object',
                      properties: { label: { type: 'string' }, description: { type: 'string' } },
                      required: ['label', 'description'],
                    },
                  },
                  multiSelect: { type: 'boolean' },
                },
                required: ['question', 'header', 'options', 'multiSelect'],
              },
            },
          },
          required: ['questions'],
        },
      },
    ],
    async executeTool(call, signal) {
      const questions = parseQuestions(call.input.questions)
      if (call.name !== 'ask_user' || !questions) {
        return {
          output: 'Invalid ask_user questions: use 1–4 questions with 2–4 distinct options each.',
          isError: true,
          summary: 'ask_user',
        }
      }
      if (signal?.aborted) return { output: '{"answers":[],"cancelled":true}', summary: 'ask_user' }
      const answer = await deps.ask(questions, signal)
      return { output: JSON.stringify(answer), summary: 'ask_user' }
    },
  }
}
