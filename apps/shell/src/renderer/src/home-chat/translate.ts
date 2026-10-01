import type { Params } from '@genoffice/i18n'
import type { I18n, StringKey } from '../locale'
import { chatString, isChatStringKey, type ChatStringKey } from './strings'

export type ChatKey = StringKey | ChatStringKey

/** Resolves a Home assistant key from the fork strings first, then the shared dictionary. */
export function translateChat(
  i18n: Pick<I18n, 'lang' | 't'>,
  key: ChatKey,
  params?: Params,
): string {
  return isChatStringKey(key) ? chatString(i18n.lang, key, params) : i18n.t(key, params)
}
