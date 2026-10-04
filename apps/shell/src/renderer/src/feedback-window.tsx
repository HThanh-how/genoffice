import { createRoot } from 'react-dom/client'
import { htmlLang } from '@genoffice/i18n'
import { LocaleProvider } from './locale'
import { UiFeedbackHost, appMessageBox, appNotify } from './ui-feedback'
import type { FeedbackWindowState, MessageBoxResult } from '../../shared/feedback-api'
import '@genoffice/ui/tokens.css'

declare global {
  interface Window {
    appFeedback: {
      getState(): Promise<FeedbackWindowState | null>
      respond(result: MessageBoxResult): Promise<void>
      setHitRegion(rect: { x: number; y: number; width: number; height: number }): Promise<void>
    }
  }
}
void window.appFeedback.getState().then((state) => {
  if (!state) return
  document.documentElement.lang = htmlLang(state.lang)
  document.documentElement.dataset.theme = state.theme
  document.body.style.margin = '0'
  createRoot(document.getElementById('root')!).render(
    <LocaleProvider initial={state.lang}>
      <UiFeedbackHost />
    </LocaleProvider>,
  )
  if (state.toastTone) {
    document.body.classList.add('native-feedback-toast')
    let seen = false
    const observer = new MutationObserver(() => {
      const toast = document.querySelector('.ui-feedback-toast')
      if (toast) {
        seen = true
        const rect = toast.getBoundingClientRect()
        void window.appFeedback.setHitRegion({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        })
      } else if (seen) {
        observer.disconnect()
        void window.appFeedback.respond({ response: 0, checkboxChecked: false })
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    appNotify(state.request.message, state.toastTone)
  } else void appMessageBox(state.request).then((result) => window.appFeedback.respond(result))
})
