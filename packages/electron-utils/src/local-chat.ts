import { app, utilityProcess } from 'electron'
import { join } from 'node:path'
import {
  LocalLlmClient,
  LocalLlmError,
  LFM_MANIFEST,
  localOptions,
  type HostProcess,
  type LocalProgress,
} from '@genoffice/local-llm'
import { setLocalChatTransport } from '@genoffice/ai-provider/local'
import type { AiProviderConfig } from '@genoffice/ai-provider'
import { setLocalChatLanguage } from '@genoffice/ai-provider/local-copy'
import { normalizeLang, type Lang } from '@genoffice/i18n'

/** Where the model stands while it is being prepared. */
export interface LocalModelStatusLine {
  text: string
  /** nothing more will follow: the model is there, or it will not be without the user */
  end?: 'ready' | 'failed'
}
type FollowModel = (listener: (line: LocalModelStatusLine) => void) => () => void

let follow: FollowModel | undefined
let initialized = false
let client: LocalLlmClient | undefined
let signature = ''
let resolver: (() => Promise<string>) | undefined
let onFailure: ((error: unknown) => Promise<void>) | undefined
/** Tail of the launch queue: replacing the client awaits a shutdown, and two callers doing that at once would each spawn a host. */
let launches: Promise<unknown> = Promise.resolve()

/** Whitelist OS essentials; cloud credentials and application secrets are never inherited. */
export function nativeHostEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'LANG',
  ])
    if (process.env[key]) env[key] = process.env[key]
  return env
}

/** The client for this model and these options; runs inside the launch queue only. */
async function clientFor(
  modelPath: string,
  options: ReturnType<typeof localOptions>,
): Promise<LocalLlmClient> {
  const key = JSON.stringify({ modelPath, options })
  if (key === signature && client) return client
  // A preload nobody is waiting for is simply replaced; only a chat in progress is protected.
  if (client?.busy && (client.state === 'BUSY' || client.state === 'STARTING'))
    throw new LocalLlmError('BUSY', 'Local model is busy; retry after the current request')
  await client?.shutdown()
  // Host is emitted beside each application's main entry by electron-vite.
  const hostPath = join(__dirname, 'local-llm-host.mjs').replace(
    /app\.asar([\\/])/,
    'app.asar.unpacked$1',
  )
  client = new LocalLlmClient(
    () => {
      const child = utilityProcess.fork(hostPath, [], {
        serviceName: 'GenOffice Local Chat',
        stdio: 'pipe',
        env: nativeHostEnvironment(),
      })
      // An unread pipe fills up and blocks the host; keep the tail for the crash log.
      let tail = ''
      child.stdout?.resume()
      child.stderr?.on('data', (chunk: Buffer) => {
        tail = (tail + chunk.toString('utf8')).slice(-4000)
      })
      child.on('exit', (code) => {
        if (code) console.error(`[local-chat] native host exited (${code}): ${tail.trim()}`)
      })
      return child as unknown as HostProcess
    },
    modelPath,
    options,
  )
  signature = key
  return client
}

/**
 * Resolve the model, pick the client and begin `work` on it. Beginning happens inside the queue, so
 * nothing can replace the client between picking it and using it; the work itself runs outside.
 */
async function launch<T>(
  config: AiProviderConfig,
  signal: AbortSignal,
  work: (client: LocalLlmClient) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  const modelPath = resolver
    ? await resolver()
    : join(app.getPath('userData'), 'models', LFM_MANIFEST.id, LFM_MANIFEST.files[0].path)
  const begun = launches.then(async () => {
    const current = await clientFor(modelPath, localOptions(config.local))
    signal.throwIfAborted()
    return { running: work(current) }
  })
  launches = begun.catch(() => undefined)
  const { running } = await begun
  try {
    return await running
  } catch (error) {
    await onFailure?.(error)
    throw error
  }
}

/**
 * Report where the model stands until it is ready or has failed. Returns the function that stops it;
 * undefined where nothing manages the model (a standalone editor).
 */
export function followLocalModel(
  listener: (line: LocalModelStatusLine) => void,
): (() => void) | undefined {
  if (!follow) return undefined
  let ended = false
  const stop = follow((line) => {
    if (ended) return
    listener(line)
    if (!line.end) return
    ended = true
    // the first line arrives before `follow` has returned its unsubscribe function
    queueMicrotask(() => stop())
  })
  return () => {
    ended = true
    stop()
  }
}

/**
 * Load the model before the first chat; resolves whether it is in memory now. Callers treat a
 * rejection as harmless: a chat loads it anyway.
 */
export function preloadLocalChat(
  config: AiProviderConfig,
  signal: AbortSignal,
  watch?: (progress: LocalProgress) => void,
): Promise<boolean> {
  return launch(config, signal, (current) => current.preload(watch))
}

export function registerLocalChat(
  resolveModel?: () => Promise<string>,
  handleFailure?: (error: unknown) => Promise<void>,
  language?: () => Lang,
  followModel?: FollowModel,
): void {
  if (followModel) follow = followModel
  if (resolveModel) resolver = resolveModel
  if (handleFailure) onFailure = handleFailure
  if (language) setLocalChatLanguage(language)
  else if (!initialized) setLocalChatLanguage(() => normalizeLang(app.getLocale()))
  if (initialized) return
  initialized = true
  setLocalChatTransport((config, request, event, signal) =>
    launch(config, signal, (current) => current.chat(request, event, signal)),
  )
  let quitting = false
  app.on('will-quit', (event) => {
    if (quitting || !client || client.state === 'STOPPED') return
    event.preventDefault()
    quitting = true
    void shutdownLocalChat().finally(() => app.quit())
  })
}

export async function shutdownLocalChat(): Promise<void> {
  const previous = client
  await previous?.shutdown()
  if (client === previous) {
    client = undefined
    signature = ''
  }
}
