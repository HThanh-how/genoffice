import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { LFM_MANIFEST, modelUrl, verifyModel, LocalLlmError } from '@genoffice/local-llm'
import { ensureArtifact, deleteArtifact } from '../model-artifacts/model-files'
import type { LocalModelState } from '../../shared/local-model'
import { localChatText } from '@genoffice/ai-provider/local-copy'
import type { LocalModelStatusLine } from '@genoffice/electron-utils/local-chat'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export class LocalModelManager {
  private current: LocalModelState = { status: 'missing', percent: 0 }
  private readonly watchers = new Set<() => void>()
  readonly path: string
  private running?: Promise<void>
  private checking?: Promise<void>
  private abort?: AbortController
  private deleting = false
  constructor(
    userData: string,
    private readonly beforeDelete: () => Promise<void>,
    /** a download just finished; never called for a model that was already on disk */
    private readonly onDownloaded: () => void = () => {},
  ) {
    this.path = join(userData, 'models', LFM_MANIFEST.id, LFM_MANIFEST.files[0].path)
  }

  get state(): LocalModelState {
    return this.current
  }
  set state(next: LocalModelState) {
    const { status, percent, error } = this.current
    this.current = next
    if (next.status === status && next.percent === percent && next.error === error) return
    for (const watch of this.watchers) watch()
  }

  /** Calls `listener` now and at every visible change; returns the unsubscribe function. */
  watch(listener: (line: LocalModelStatusLine) => void): () => void {
    const tell = () => listener(this.statusLine())
    this.watchers.add(tell)
    tell()
    return () => {
      this.watchers.delete(tell)
    }
  }

  async refresh(): Promise<void> {
    if (this.running) return
    if (this.checking) return this.checking
    this.checking = (async () => {
      this.state = { status: 'checking', percent: 0 }
      try {
        if (!(await stat(this.path).catch(() => null))) {
          const bytes = await stat(`${this.path}.part`).then(
            (s) => s.size,
            () => 0,
          )
          this.state = {
            status: bytes ? 'paused' : 'missing',
            percent: Math.floor((100 * bytes) / LFM_MANIFEST.files[0].bytes),
          }
          return
        }
        await verifyModel(this.path)
        this.state = { status: 'ready', percent: 100 }
      } catch (error) {
        let details = errorText(error)
        if (
          error instanceof LocalLlmError &&
          (error.code === 'MODEL_CHECKSUM' || error.code === 'MODEL_SIZE')
        ) {
          try {
            await this.beforeDelete()
            await deleteArtifact(this.path)
          } catch (cleanup) {
            details += `; could not remove invalid model: ${String(cleanup)}`
          }
        }
        this.state = {
          status: 'error',
          percent: 0,
          error: details,
        }
      }
    })().finally(() => {
      this.checking = undefined
    })
    return this.checking
  }

  download(): Promise<void> {
    if (this.running) return this.running
    if (this.deleting) return Promise.reject(new Error('Model deletion is in progress'))
    this.abort = new AbortController()
    const signal = this.abort.signal
    this.state = { status: 'downloading', percent: this.state.percent }
    let downloaded = false
    this.running = (async () => {
      try {
        await this.checking
        signal.throwIfAborted()
        this.state = { status: 'downloading', percent: this.state.percent }
        downloaded = await ensureArtifact(
          this.path,
          LFM_MANIFEST.files[0],
          modelUrl(),
          signal,
          (bytes) => {
            this.state = {
              status: 'downloading',
              percent: Math.min(99, Math.floor((100 * bytes) / LFM_MANIFEST.files[0].bytes)),
            }
          },
          undefined,
          () => {
            this.state = { status: 'verifying', percent: 100 }
          },
        )
        this.state = { status: 'ready', percent: 100 }
      } catch (error) {
        this.state = {
          status: signal.aborted ? 'paused' : 'error',
          percent: this.state.percent,
          ...(!signal.aborted ? { error: errorText(error) } : {}),
        }
      }
    })().finally(() => {
      this.running = undefined
      this.abort = undefined
      // Cancel, delete and quit all abort: whoever asked for that is not waiting for the model.
      if (downloaded && !signal.aborted) this.onDownloaded()
    })
    return this.running
  }

  async cancel(): Promise<void> {
    this.abort?.abort()
    await this.running
  }
  async delete(): Promise<void> {
    this.deleting = true
    try {
      await this.cancel()
      await this.checking
      await this.beforeDelete()
      await deleteArtifact(this.path)
      this.state = { status: 'missing', percent: 0 }
    } catch (error) {
      this.state = {
        status: 'error',
        percent: this.state.percent,
        error: errorText(error),
      }
    } finally {
      this.deleting = false
    }
  }

  /** a download is transferring or being checked */
  get busy(): boolean {
    return this.running !== undefined
  }

  /** Where the model stands, in one line that replaces the previous one. */
  private statusLine(): LocalModelStatusLine {
    const c = localChatText()
    const { status, percent, error } = this.state
    switch (status) {
      case 'ready':
        return { text: c.readyToChat, end: 'ready' }
      case 'error':
        return { text: error ?? c.error, end: 'failed' }
      case 'missing':
        return { text: `${c.missing} — ${c.title}`, end: 'failed' }
      case 'downloading':
        return { text: `${c.chatDownloading.replace('{n}', String(percent))}\n\n${c.sendAgain}` }
      case 'paused':
        return { text: error ?? c.paused.replace('{n}', String(percent)) }
      default:
        return { text: `${c[status]}\n\n${c.sendAgain}` }
    }
  }

  /** The model file to load, or why there is none. */
  requireReady(): string {
    if (this.deleting) throw new LocalLlmError('RUNTIME', 'Local model is being deleted')
    if (this.state.status === 'ready') return this.path
    const { text, end } = this.statusLine()
    throw new LocalLlmError(end ? 'RUNTIME' : 'PREPARING', text)
  }
}
