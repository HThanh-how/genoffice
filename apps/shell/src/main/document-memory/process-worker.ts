import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { constants, setPriority } from 'node:os'
import type { Worker } from 'node:worker_threads'
import { attachChildToPolicy } from '../fork/indexing-child-policy'
import type { EmbeddingProfileId } from './embedding-profiles'

export const DEFAULT_WORKER_TERMINATE_TIMEOUT_MS = 3000

export interface IndexProcessData {
  cacheDir: string
  dbPath: string
  embeddingProfile?: EmbeddingProfileId
  storageBudget?: import('./storage-budget').DocumentIndexStorageBudget
  configVersion?: number
}

/** A separate, lower-priority process keeps model CPU and memory away from the UI. */
export function createIndexProcess(
  path: string,
  data: IndexProcessData,
  spawnProcess: typeof spawn = spawn,
): Worker {
  const channel = new EventEmitter()
  const child = spawnProcess(process.execPath, [path], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      GENOFFICE_INDEX_WORKER_DATA: JSON.stringify(data),
      // the packaged pdfium.wasm lives in Resources/wasm; plain Node has no resourcesPath
      ...((process as { resourcesPath?: string }).resourcesPath
        ? { GENOFFICE_RESOURCES_PATH: (process as { resourcesPath?: string }).resourcesPath }
        : {}),
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
    serialization: 'advanced',
  })
  let detachPolicy: (() => void) | null = null
  child.on('spawn', () => {
    try {
      if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL)
    } catch {
      // Duty-cycle limits still apply where process priority changes are unavailable.
    }
    // Threads, duty cycle and OS priority follow the power / idle policy from here on.
    detachPolicy = attachChildToPolicy({
      pid: child.pid,
      connected: () => child.connected,
      send: (message) => child.send(message, () => {}),
      setPriority,
    })
  })
  child.on('message', (message) => channel.emit('message', message))
  child.on('error', (error) => channel.emit('error', error))
  child.on('exit', (code) => {
    detachPolicy?.()
    channel.emit('exit', code ?? 1)
  })

  return Object.assign(channel, {
    postMessage(message: unknown) {
      if (!child.connected) throw new Error('Index process is unavailable')
      child.send(message as object, (error) => {
        if (error) channel.emit('error', error)
      })
    },
    terminate(gracefulMs: number = DEFAULT_WORKER_TERMINATE_TIMEOUT_MS): Promise<number> {
      if (child.exitCode !== null || child.signalCode !== null)
        return Promise.resolve(child.exitCode ?? 0)
      return new Promise((resolve) => {
        let forceKillTimer: NodeJS.Timeout | null = null

        const onExit = (code: number | null) => {
          if (forceKillTimer !== null) {
            clearTimeout(forceKillTimer)
            forceKillTimer = null
          }
          resolve(code ?? 0)
        }

        child.once('exit', onExit)

        if (gracefulMs > 0 && Number.isFinite(gracefulMs)) {
          forceKillTimer = setTimeout(() => {
            forceKillTimer = null
            if (child.exitCode === null && child.signalCode === null) {
              try {
                child.kill('SIGKILL')
              } catch {
                // Child might have exited or OS rejected the signal.
              }
            }
          }, gracefulMs)
          forceKillTimer.unref?.()
        }

        try {
          child.kill('SIGTERM')
        } catch {
          // If the initial kill signal fails, wait for the exit event or timeout.
        }
      })
    },
  }) as unknown as Worker
}
