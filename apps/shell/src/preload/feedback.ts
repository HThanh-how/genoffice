import { contextBridge, ipcRenderer } from 'electron'
import type { FeedbackWindowState, MessageBoxResult } from '../shared/feedback-api'

// Sandboxed preloads cannot require generated sibling chunks.
const FEEDBACK_CHANNELS = { state: 'ui-feedback:state', respond: 'ui-feedback:respond' } as const

contextBridge.exposeInMainWorld('appFeedback', {
  getState: (): Promise<FeedbackWindowState | null> => ipcRenderer.invoke(FEEDBACK_CHANNELS.state),
  respond: (result: MessageBoxResult): Promise<void> =>
    ipcRenderer.invoke(FEEDBACK_CHANNELS.respond, result),
  setHitRegion: (rect: { x: number; y: number; width: number; height: number }): Promise<void> =>
    ipcRenderer.invoke('ui-feedback:hit-region', rect),
})
