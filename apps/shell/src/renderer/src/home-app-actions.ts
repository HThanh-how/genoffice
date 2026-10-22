import {
  AppActionRegistry,
  type AppActionStep,
  type AppControlInput,
} from '@genoffice/agent-core/app-control'
import { waitForActionStep } from '@genoffice/ui'
import type { SectionId } from './SettingsModal'
import type { HomeApi } from '../../shared/home-api'
import type { Lang } from '@genoffice/i18n'
import type { AgyChatApi } from '@genoffice/ai-provider/agy-chat'
import { runWhitelistedSetting } from './app-control-settings'

export const NEW_CHAT_ACTION = 'genoffice:new-chat-action'
export function homeAppActions(
  api: HomeApi,
  openIndex: () => void,
  openSettings: (pane: SectionId) => void,
  languageChanged: (lang: Lang) => void,
): AppActionRegistry {
  const registry = new AppActionRegistry()
  const observe = (selector: string, label: string): AppActionStep => ({
    selector,
    label,
    event: 'observe',
  })
  const click = (selector: string, label: string): AppActionStep => ({
    selector,
    label,
    event: 'click',
  })
  const settingsSteps = (input: AppControlInput): AppActionStep[] => {
    const pane = input.kind === 'app_action' ? String(input.args.pane ?? 'general') : 'general'
    return [
      click('.account-btn', 'aiActionSettings'),
      click(`[data-settings-pane="${pane}"]`, 'aiActionSettings'),
      observe(`[data-settings-pane="${pane}"][aria-current="page"]`, 'aiActionSettings'),
    ]
  }
  registry.register({
    id: 'open-index-screen',
    label: 'aiActionIndex',
    risk: 'safe',
    teach: true,
    highlightSelector: '[data-app-action="index"]',
    steps: [
      click('[data-app-action="index"]', 'aiActionIndex'),
      observe('.idx-page', 'aiActionIndex'),
    ],
    async run(_input, signal) {
      openIndex()
      await waitForActionStep(observe('.idx-page', 'aiActionIndex'), signal)
      return { status: 'completed' }
    },
  })
  registry.register({
    id: 'open-settings',
    label: 'aiActionSettings',
    risk: 'safe',
    teach: true,
    highlightSelector: '.account-btn',
    steps: settingsSteps({ kind: 'app_action', id: 'open-settings', args: {}, teach: true }),
    resolveSteps: settingsSteps,
    async run(input, signal) {
      const pane = (
        input.kind === 'app_action' ? (input.args.pane ?? 'general') : 'general'
      ) as SectionId
      openSettings(pane)
      await waitForActionStep(
        observe(`[data-settings-pane="${pane}"][aria-current="page"]`, 'aiActionSettings'),
        signal,
      )
      return { status: 'completed' }
    },
  })
  registry.register({
    id: 'new-chat',
    label: 'aiActionNewChat',
    risk: 'safe',
    teach: true,
    highlightSelector: '[data-app-action="new-chat"]',
    steps: [
      click('[data-app-action="ask"]', 'aiActionNewChat'),
      click('[data-app-action="new-chat"]', 'aiActionNewChat'),
      { label: 'aiActionNewChat', event: 'handoff' },
    ],
    async run() {
      // The existing startNew handler stops the previous run and resets the transcript.
      return new Promise((resolve) =>
        window.dispatchEvent(
          new CustomEvent(NEW_CHAT_ACTION, { detail: () => resolve({ status: 'completed' }) }),
        ),
      )
    },
  })
  for (const id of ['get_setting', 'set_setting'])
    registry.register({
      id,
      label: 'aiActionSettings',
      risk: id === 'set_setting' ? 'confirm' : 'safe',
      teach: false,
      steps: [],
      run: (input, signal) => {
        const agy = (window as unknown as { agyChat?: AgyChatApi }).agyChat
        return runWhitelistedSetting(
          api,
          input,
          signal,
          languageChanged,
          agy ? (model) => agy.selectAgyChatModel(model) : undefined,
        )
      },
    })
  return registry
}
