import { useEffect, useRef, useState } from 'react'
import { AskUserController, type AskUserRequest } from '@genoffice/agent-core'
import { createAppControlSkill, type AppControlInput } from '@genoffice/agent-core/app-control'
import type { Lang } from '@genoffice/i18n'
import { ClarifyCard } from './ClarifyCard'
import { clarifyText, type ClarifyKey } from './strings-clarify'
import { appActionBridge } from './AppActionHost'
import './clarify-card.css'

export function appActionLabel(input: AppControlInput): ClarifyKey {
  if (input.kind !== 'app_action') return 'aiActionSettings'
  return {
    'open-index-screen': 'aiActionIndex',
    'open-settings': 'aiActionSettings',
    'new-chat': 'aiActionNewChat',
    print: 'aiActionPrint',
    'export-pdf': 'aiActionExportPdf',
  }[input.id] as ClarifyKey
}

/** Reuses the existing option card, with no default approval or "decide for me". */
export function useAppControl(lang: Lang) {
  const [request, setRequest] = useState<AskUserRequest | null>(null)
  const controller = useRef<AskUserController | null>(null)
  if (!controller.current) controller.current = new AskUserController(setRequest)
  const langRef = useRef(lang)
  langRef.current = lang
  const lifetime = useRef(new AbortController())
  useEffect(() => {
    lifetime.current = new AbortController()
    return () => lifetime.current.abort()
  }, [])
  const skill = useRef<ReturnType<typeof createAppControlSkill> | null>(null)
  const bridge = appActionBridge()
  if (!skill.current && bridge)
    skill.current = createAppControlSkill({
      bridge,
      async confirm(input, signal) {
        const l = langRef.current
        const text = (key: ClarifyKey) => clarifyText(l, key)
        const label = text(appActionLabel(input))
        const detail = input.kind === 'set_setting' ? `${input.key}: ${input.value}` : label
        const result = await controller.current!.ask(
          [
            {
              question: `${text('aiActionConfirm')} ${detail}`,
              header: label,
              options: [
                { label: text('aiActionApprove'), description: detail },
                { label: text('aiActionDeny'), description: text('aiActionDeny') },
              ],
              multiSelect: false,
            },
          ],
          signal ? AbortSignal.any([signal, lifetime.current.signal]) : lifetime.current.signal,
        )
        return (
          !result.cancelled &&
          result.answers.length === 1 &&
          result.answers[0]?.a === text('aiActionApprove')
        )
      },
    })
  const approval = request ? (
    <div
      className="app-action-approval"
      role="region"
      aria-label={clarifyText(lang, 'aiActionConfirm')}
    >
      <ClarifyCard
        key={request.id}
        t={(key, params) => clarifyText(lang, key, params)}
        allowDecide={false}
        questions={request.questions.map((q, i) => ({
          id: String(i),
          label: q.question,
          header: q.header,
          options: q.options.map((o) => o.label),
        }))}
        onSubmit={(_text, answers) => request.respond({ answers })}
        onSkip={() => request.respond({ answers: [], cancelled: true })}
      />
    </div>
  ) : null
  return { skill: skill.current, approval }
}
