import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { constants, setPriority } from 'node:os'
import type { Worker } from 'node:worker_threads'

/** A separate, lower-priority process keeps model CPU and memory away from the UI. */
export function createIndexProcess(
  path: string,
  data: { cacheDir: string; dbPath: string },
): Worker {
  const channel = new EventEmitter()
  const child = spawn(process.execPath, [path], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      GENOFFICE_INDEX_WORKER_DATA: JSON.stringify(data),
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
    serialization: 'advanced',
  })
  child.on('spawn', () => {
    try {
      if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL)
    } catch {
      // Duty-cycle limits still apply where process priority changes are unavailable.
    }
  })
  child.on('message', (message) => channel.emit('message', message))
  child.on('error', (error) => channel.emit('error', error))
  child.on('exit', (code) => channel.emit('exit', code ?? 1))
  return Object.assign(channel, {
    postMessage(message: unknown) {
      if (!child.connected) throw new Error('Index process is unavailable')
      child.send(message as object, (error) => {
        if (error) channel.emit('error', error)
      })
    },
    terminate(): Promise<number> {
      if (child.exitCode !== null || child.signalCode !== null)
        return Promise.resolve(child.exitCode ?? 0)
      return new Promise((resolve) => {
        child.once('exit', (code) => resolve(code ?? 0))
        child.kill()
      })
    },
  }) as unknown as Worker
}
