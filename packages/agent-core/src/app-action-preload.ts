import type {
  AppActionBridge,
  AppActionRequest,
  AppActionResult,
  AppControlInput,
} from './app-control'

interface Port {
  invoke(channel: string, ...args: unknown[]): Promise<any>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (...args: any[]) => void): unknown
  removeListener(channel: string, listener: (...args: any[]) => void): unknown
}

/** Inject Electron's IPC port so this adapter remains testable without Electron. */
export function createAppActionPreload(port: Port, docs = false): AppActionBridge {
  return {
    prepare: (input: AppControlInput) => port.invoke('app-action:prepare', input),
    execute: (id: string) => port.invoke('app-action:execute', id),
    cancel: (id: string) => port.send('app-action:cancel', id),
    onRequest(ids, handler) {
      const channel = docs ? 'menu:command' : 'app-action:run'
      const listener = async (_event: unknown, ...args: unknown[]) => {
        const request = (docs ? args[2] : args[0]) as AppActionRequest | undefined
        if (!request?.requestId) return
        let result: AppActionResult
        try {
          result = await handler(request)
        } catch {
          result = { status: 'error', error: 'Command failed' }
        }
        port.send('app-action:ack', request.requestId, result)
      }
      port.on(channel, listener)
      port.send('app-action:register', ids)
      return () => {
        port.removeListener(channel, listener)
        port.send('app-action:unregister', ids)
      }
    },
    onCancel(handler) {
      const listener = (_event: unknown, id: string) => handler(id)
      port.on('app-action:cancelled', listener)
      return () => {
        port.removeListener('app-action:cancelled', listener)
      }
    },
  }
}
