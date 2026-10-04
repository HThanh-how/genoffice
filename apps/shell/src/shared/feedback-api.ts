import type { Lang } from '@genoffice/i18n'

export interface MessageBoxRequest {
  message: string
  title?: string
  detail?: string
  buttons?: string[]
  defaultId?: number
  cancelId?: number
  checkboxLabel?: string
  checkboxChecked?: boolean
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
}
export interface MessageBoxResult {
  response: number
  checkboxChecked: boolean
}
export interface FeedbackWindowState {
  request: MessageBoxRequest
  lang: Lang
  theme: 'light' | 'dark'
  toastTone?: 'info' | 'success' | 'warning' | 'error' | 'danger'
}
export const FEEDBACK_CHANNELS = {
  state: 'ui-feedback:state',
  respond: 'ui-feedback:respond',
  notify: 'ui-feedback:notify',
  hitRegion: 'ui-feedback:hit-region',
} as const
