import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { LFM_MANIFEST, modelUrl, verifyModel, LocalLlmError } from '@genoffice/local-llm'
import { ensureArtifact, deleteArtifact } from '../model-artifacts/model-files'
import type { LocalModelState } from '../../shared/local-model'
import { localChatText } from '@genoffice/ai-provider/local-copy'

export class LocalModelManager {
  state: LocalModelState = { status: 'missing', percent: 0 }
  readonly path: string
  private running?: Promise<void>
  private checking?: Promise<void>
  private abort?: AbortController
  private deleting = false
  constructor(
    userData: string,
    private readonly beforeDelete: () => Promise<void>,
  ) {
    this.path = join(userData, 'models', LFM_MANIFEST.id, LFM_MANIFEST.files[0].path)
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
        let details = error instanceof Error ? error.message : String(error)
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
    this.running = (async () => {
      try {
        await this.checking
        signal.throwIfAborted()
        this.state = { status: 'downloading', percent: this.state.percent }
        await ensureArtifact(this.path, LFM_MANIFEST.files[0], modelUrl(), signal, (bytes) => {
          this.state = {
            status: 'downloading',
            percent: Math.min(99, Math.floor((100 * bytes) / LFM_MANIFEST.files[0].bytes)),
          }
        })
        this.state = { status: 'ready', percent: 100 }
      } catch (error) {
        this.state = {
          status: signal.aborted ? 'paused' : 'error',
          percent: this.state.percent,
          ...(!signal.aborted
            ? { error: error instanceof Error ? error.message : String(error) }
            : {}),
        }
      }
    })().finally(() => {
      this.running = undefined
      this.abort = undefined
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
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      this.deleting = false
    }
  }

  requireReady(): string {
    if (this.deleting) throw new Error('Local model is being deleted')
    if (this.state.status !== 'ready')
      throw new Error(
        this.state.status === 'downloading'
          ? localChatText().downloading.replace('{n}', String(this.state.percent))
          : (this.state.error ?? `${localChatText().missing} — ${localChatText().title}`),
      )
    return this.path
  }
}
