export interface LocalModelState {
  status: 'missing' | 'checking' | 'downloading' | 'paused' | 'ready' | 'error'
  percent: number
  error?: string
}
export interface LocalModelApi {
  localModelLicense(): Promise<void>
  localModelStatus(): Promise<LocalModelState>
  localModelAction(action: 'download' | 'cancel' | 'delete'): Promise<LocalModelState>
}
