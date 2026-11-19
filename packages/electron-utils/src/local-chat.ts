import { app, utilityProcess } from 'electron'
import { join } from 'node:path'
import { LocalLlmClient, LFM_MANIFEST, localOptions, type HostProcess } from '@genoffice/local-llm'
import { setLocalChatTransport } from '@genoffice/ai-provider/local'
import { setLocalChatLanguage } from '@genoffice/ai-provider/local-copy'
import { normalizeLang, type Lang } from '@genoffice/i18n'

let initialized = false
let client: LocalLlmClient | undefined
let signature = ''
let resolver: (() => Promise<string>) | undefined
let onFailure: ((error: unknown) => Promise<void>) | undefined

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

export function registerLocalChat(
  resolveModel?: () => Promise<string>,
  handleFailure?: (error: unknown) => Promise<void>,
  language?: () => Lang,
): void {
  if (resolveModel) resolver = resolveModel
  if (handleFailure) onFailure = handleFailure
  if (language) setLocalChatLanguage(language)
  else if (!initialized) setLocalChatLanguage(() => normalizeLang(app.getLocale()))
  if (initialized) return
  initialized = true
  setLocalChatTransport(async (config, request, event, signal) => {
    signal.throwIfAborted()
    const modelPath = resolver
      ? await resolver()
      : join(app.getPath('userData'), 'models', LFM_MANIFEST.id, LFM_MANIFEST.files[0].path)
    const options = localOptions(config.local)
    const key = JSON.stringify({ modelPath, options })
    if (key !== signature || !client) {
      if (client?.state === 'BUSY' || client?.state === 'STARTING')
        throw new Error('Local model is busy; retry after the current request')
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
    }
    try {
      await client.chat(request, event, signal)
    } catch (error) {
      await onFailure?.(error)
      throw error
    }
  })
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
