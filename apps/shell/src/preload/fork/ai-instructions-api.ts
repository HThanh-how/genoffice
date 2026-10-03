import type { IpcRenderer } from 'electron'
import {
  AI_INSTRUCTIONS_CHANNELS as C,
  type AiInstructionsApi,
} from '../../shared/fork/ai-instructions-meta'

export function createAiInstructionsPreloadApi(ipcRenderer: IpcRenderer): AiInstructionsApi {
  return {
    getAiInstructions: () => ipcRenderer.invoke(C.get),
    setAiReplyLanguage: (language) => ipcRenderer.invoke(C.setLanguage, language),
    setAiInstructionsText: (text) => ipcRenderer.invoke(C.setText, text),
    openAiInstructionsFile: () => ipcRenderer.invoke(C.openFile),
  }
}
