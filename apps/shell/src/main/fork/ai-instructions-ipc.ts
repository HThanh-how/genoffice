import { app, shell } from 'electron'
import type { IpcMain } from 'electron'
import { join } from 'node:path'
import { setSystemAddendum } from '@genoffice/ai-provider'
import {
  AI_INSTRUCTIONS_CHANNELS as C,
  DEFAULT_REPLY_LANGUAGE,
  normalizeReplyLanguage,
  type AiInstructionsState,
} from '../../shared/fork/ai-instructions-meta'
import { readAppSettings, writeAppSetting } from '../app-settings'
import { buildAddendum, createInstructionsFile } from './ai-instructions'

/**
 * The reply language and the person's own instructions, added to every AI turn. The language is
 * kept in app-settings.json; the instructions live in an ordinary file the person can edit in any
 * editor (userData/ai-instructions.md) as well as in Settings.
 */
export function registerAiInstructions(deps: {
  ipcMain: Pick<IpcMain, 'handle'>
  settingsPath: () => string
}): void {
  const file = createInstructionsFile(join(app.getPath('userData'), 'ai-instructions.md'))
  const language = () =>
    normalizeReplyLanguage(
      readAppSettings(deps.settingsPath()).aiReplyLanguage ?? DEFAULT_REPLY_LANGUAGE,
    )
  const state = (): AiInstructionsState => ({
    language: language(),
    text: file.read(),
    path: join(app.getPath('userData'), 'ai-instructions.md'),
  })

  setSystemAddendum(() => buildAddendum(language(), file.read()))

  deps.ipcMain.handle(C.get, () => state())
  deps.ipcMain.handle(C.setLanguage, (_event, value: unknown) => {
    writeAppSetting(deps.settingsPath(), 'aiReplyLanguage', normalizeReplyLanguage(value))
    return state()
  })
  deps.ipcMain.handle(C.setText, (_event, value: unknown) => {
    if (typeof value === 'string') file.write(value)
    return state()
  })
  deps.ipcMain.handle(C.openFile, async () => {
    file.read() // creates it with the template when it is not there yet
    await shell.openPath(state().path)
  })
}
