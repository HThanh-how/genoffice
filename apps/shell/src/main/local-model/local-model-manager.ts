import { mkdir, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import {
  EmbeddingModelDownloadError,
  cachedModelFile,
  modelCacheFilePath,
  sha256OfFile,
  verifyModelFile,
  type FetchLike,
  type ModelArtifactManifest,
} from '../document-memory/embedding/model-files'
import type {
  LocalModelError,
  LocalModelErrorCode,
  LocalModelState,
  SelectResult,
} from '../../shared/fork/local-model-api'
import { LFM3_VL_2B_Q4_K_M, LOCAL_MODELS_DIR_NAME, LOCAL_MODEL_LABEL } from './local-model-spec'

/**
 * The local chat model on disk: download it (pinned revision, SHA-256 verified), cancel, delete,
 * or adopt a copy the person already has. Pure Node: no Electron, IPC or UI. Callers (the IPC layer)
 * pass a file path and read `state()`.
 *
 * Layout under userData/local-models/:
 *   <repo>/<revision>/<file>            the downloaded model (+ .verified marker, .part while downloading)
 *   selection.json                      a file the person chose instead: path + fingerprint
 *
 * A chosen file is accepted on its size and SHA-256 only, so a renamed copy works. Nothing is ever
 * written next to it and it is never deleted: "delete" forgets the pointer.
 *
 * State is derived from disk (refresh) and from the one download in flight; nothing else is stored.
 */

// The state shapes are shared with the renderer; defined once in shared/fork/local-model-api.ts.
export type {
  LocalModelError,
  LocalModelErrorCode,
  LocalModelState,
  LocalModelStatus,
  SelectResult,
} from '../../shared/fork/local-model-api'

export interface LocalModelManagerOptions {
  /** the app's userData folder; models live in its local-models/ subfolder */
  userDataPath: string
  /** defaults to LFM3-VL-2B-Q4_K_M; tests pass a small manifest of the same shape */
  manifest?: ModelArtifactManifest
  fetchImpl?: FetchLike
  /** free bytes on the volume holding `dir`, or null when unknown (the check is then skipped) */
  freeBytes?: (dir: string) => Promise<number | null>
  /** download tuning passed through to the shared downloader (tests use short values) */
  retryDelaysMs?: number[]
  stallTimeoutMs?: number
  /** mirror URL templates; the default manifest is not mirrorable, so only Hugging Face is used */
  mirrors?: readonly string[]
}

export interface LocalModelManager {
  /** the model folder: userData/local-models */
  readonly modelsDir: string
  /** last known state (call refresh() once at start-up) */
  state(): LocalModelState
  /** re-derive the state from disk (no-op while a download runs) */
  refresh(): Promise<LocalModelState>
  /** download (or resume) the model; resolves when it is ready, failed or was cancelled */
  download(): Promise<LocalModelState>
  /** stop a download and delete its partial file */
  cancel(): Promise<LocalModelState>
  /** remove the downloaded model and forget a chosen file (which itself is never deleted) */
  delete(): Promise<LocalModelState>
  /** use a model file that is already on this computer, if its size and SHA-256 match */
  selectExisting(path: string): Promise<SelectResult>
  /** the verified model file to load, or null when none is ready */
  readyPath(): string | null
}

/** Free space kept beyond the bytes still to download (temp files, the OS, the index). */
export const DISK_SPACE_MARGIN_BYTES = 256 * 1024 * 1024

interface Selection {
  modelId: string
  path: string
  bytes: number
  mtimeMs: number
  sha256: string
}

interface Run {
  controller: AbortController
  cancelling: boolean
  done: Promise<LocalModelState>
}

function formatBytes(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`
}

async function volumeFreeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir)
    const free = Number(s.bavail) * Number(s.bsize)
    return Number.isFinite(free) ? free : null
  } catch {
    return null // unknown: do not block the download on a failed probe
  }
}

function errorFromDownload(error: unknown): LocalModelError {
  if (error instanceof EmbeddingModelDownloadError) {
    switch (error.failure) {
      case 'checksum':
      case 'size':
        return { code: 'checksum', message: error.message }
      case 'disk-space':
        return { code: 'disk-space', message: error.message }
      case 'access-denied':
      case 'not-found':
        return { code: 'unavailable', message: error.message }
      default:
        return {
          code: /already being downloaded/.test(error.message) ? 'busy' : 'network',
          message: error.message,
        }
    }
  }
  return { code: 'network', message: error instanceof Error ? error.message : String(error) }
}

export function createLocalModelManager(options: LocalModelManagerOptions): LocalModelManager {
  const manifest = options.manifest ?? LFM3_VL_2B_Q4_K_M
  if (manifest.files.length !== 1) throw new Error('A local chat model manifest names exactly one file')
  const file = manifest.files[0]!
  if (!file.sha256 || !file.bytes) {
    throw new Error('A local chat model manifest must pin the file size and SHA-256')
  }
  const totalBytes = file.bytes
  const expectedSha = file.sha256
  const modelsDir = join(options.userDataPath, LOCAL_MODELS_DIR_NAME)
  const cachedPath = modelCacheFilePath(modelsDir, manifest, file)
  const partPath = `${cachedPath}.part`
  const selectionPath = join(modelsDir, 'selection.json')
  const freeBytes = options.freeBytes ?? volumeFreeBytes
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init))

  let current: LocalModelState = { status: 'not-installed', modelId: manifest.id, totalBytes }
  let active: Run | null = null

  const set = (next: Omit<LocalModelState, 'modelId' | 'totalBytes'>): LocalModelState => {
    current = { modelId: manifest.id, totalBytes, ...next }
    return current
  }

  const partBytes = (): Promise<number> =>
    stat(partPath).then(
      (s) => s.size,
      () => 0,
    )

  async function readSelection(): Promise<Selection | null> {
    try {
      const raw = JSON.parse(await readFile(selectionPath, 'utf8')) as Partial<Selection>
      return raw.modelId === manifest.id &&
        typeof raw.path === 'string' &&
        typeof raw.bytes === 'number' &&
        typeof raw.mtimeMs === 'number' &&
        typeof raw.sha256 === 'string'
        ? (raw as Selection)
        : null
    } catch {
      return null
    }
  }

  async function removeDownloaded(): Promise<void> {
    await rm(cachedPath, { force: true })
    await rm(`${cachedPath}.verified`, { force: true })
  }

  /** The state the files on disk describe (ignores a download in flight). */
  async function deriveFromDisk(): Promise<LocalModelState> {
    let problem: LocalModelError | undefined
    const selection = await readSelection()
    if (selection) {
      const s = await stat(selection.path).catch(() => null)
      if (s?.isFile() && s.size === selection.bytes && s.mtimeMs === selection.mtimeMs) {
        return set({ status: 'ready', source: 'selected', path: selection.path })
      }
      if (s?.isFile() && s.size === totalBytes && (await sha256OfFile(selection.path).catch(() => null)) === expectedSha) {
        // touched but still the same model (copied back, metadata changed): keep it
        await writeFile(selectionPath, JSON.stringify({ ...selection, mtimeMs: s.mtimeMs }))
        return set({ status: 'ready', source: 'selected', path: selection.path })
      }
      await rm(selectionPath, { force: true })
      problem = s?.isFile()
        ? {
            code: 'wrong-model',
            message: `The chosen model file ${selection.path} has changed and is no longer ${file.path}. Choose it again or download the model.`,
          }
        : {
            code: 'not-found',
            message: `The chosen model file is no longer at ${selection.path}. Choose it again or download the model.`,
          }
    }
    const cached = await stat(cachedPath).catch(() => null)
    if (cached?.isFile()) {
      if (await verifyModelFile(cachedPath, file)) {
        return set({ status: 'ready', source: 'downloaded', path: cachedPath })
      }
      await removeDownloaded()
      problem = {
        code: 'checksum',
        message: `The downloaded ${file.path} failed its SHA-256 check and was deleted. Download it again.`,
      }
    }
    const partial = await partBytes()
    const resume = partial > 0 ? { partialBytes: partial } : {}
    return problem
      ? set({ status: 'error', ...resume, error: problem })
      : set({ status: 'not-installed', ...resume })
  }

  async function runDownload(run: Run): Promise<LocalModelState> {
    const cancelled = async (): Promise<LocalModelState> => {
      await rm(partPath, { force: true })
      return set({ status: 'not-installed' })
    }
    const before = await deriveFromDisk()
    if (before.status === 'ready') return before
    if (run.cancelling) return cancelled()

    await mkdir(modelsDir, { recursive: true })
    const have = await partBytes()
    const needed = totalBytes - have + DISK_SPACE_MARGIN_BYTES
    const free = await freeBytes(modelsDir)
    if (free !== null && free < needed) {
      return set({
        status: 'error',
        ...(have > 0 ? { partialBytes: have } : {}),
        error: {
          code: 'disk-space',
          message: `Not enough free disk space for ${file.path}: ${formatBytes(needed)} is needed in ${modelsDir}, ${formatBytes(free)} is free.`,
        },
      })
    }
    if (run.cancelling) return cancelled()

    set({ status: 'downloading', doneBytes: have })
    try {
      const path = await cachedModelFile(modelsDir, manifest, file, fetchImpl, {
        signal: run.controller.signal,
        label: LOCAL_MODEL_LABEL,
        onProgress: (p) => {
          if (active === run && current.status === 'downloading') {
            current = { ...current, doneBytes: p.doneBytes }
          }
        },
        ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
        ...(options.stallTimeoutMs ? { stallTimeoutMs: options.stallTimeoutMs } : {}),
        ...(options.mirrors ? { mirrors: options.mirrors } : {}),
      })
      return set({ status: 'ready', source: 'downloaded', path })
    } catch (error) {
      if (run.cancelling) return cancelled()
      const partial = await partBytes()
      return set({
        status: 'error',
        ...(partial > 0 ? { partialBytes: partial } : {}),
        error: errorFromDownload(error),
      })
    }
  }

  async function cancel(): Promise<LocalModelState> {
    const run = active
    if (run) {
      run.cancelling = true
      run.controller.abort()
      return run.done // the run deletes the part and reports not-installed
    }
    await rm(partPath, { force: true })
    return current.status === 'ready' ? current : set({ status: 'not-installed' })
  }

  return {
    modelsDir,
    state: () => ({ ...current }),
    refresh: () => (active ? Promise.resolve({ ...current }) : deriveFromDisk()),
    download() {
      if (active) return active.done
      const run: Run = {
        controller: new AbortController(),
        cancelling: false,
        done: Promise.resolve(current),
      }
      active = run
      run.done = runDownload(run).finally(() => {
        if (active === run) active = null
      })
      return run.done
    },
    cancel,
    async delete() {
      if (active) await cancel()
      await rm(selectionPath, { force: true }) // the chosen file itself stays where it is
      await removeDownloaded()
      await rm(partPath, { force: true })
      return set({ status: 'not-installed' })
    },
    async selectExisting(input) {
      const fail = (code: LocalModelErrorCode, message: string): SelectResult => {
        const error = { code, message }
        // a bad pick never hides a model that is ready, or a download in progress
        if (!active && current.status !== 'ready') set({ status: 'error', error })
        return { ok: false, error, state: { ...current } }
      }
      const path = typeof input === 'string' ? input.trim() : ''
      if (!path || !isAbsolute(path)) return fail('not-found', 'Choose the model file by its full path.')
      const s = await stat(path).catch(() => null)
      if (!s?.isFile()) return fail('not-found', `There is no file at ${path}.`)
      if (s.size !== totalBytes) {
        return fail(
          'wrong-model',
          `${basename(path)} is not ${file.path}: it is ${formatBytes(s.size)}, the model is ${formatBytes(totalBytes)}.`,
        )
      }
      const sha = await sha256OfFile(path).catch(() => null)
      if (sha === null) return fail('not-found', `${path} could not be read.`)
      if (sha !== expectedSha) {
        return fail(
          'wrong-model',
          `${basename(path)} has the size of ${file.path} but not its SHA-256: it is a different file.`,
        )
      }
      if (active) await cancel()
      await mkdir(modelsDir, { recursive: true })
      const selection: Selection = {
        modelId: manifest.id,
        path,
        bytes: s.size,
        mtimeMs: s.mtimeMs,
        sha256: sha,
      }
      await writeFile(selectionPath, JSON.stringify(selection))
      await rm(partPath, { force: true }) // an interrupted download is no longer needed
      return { ok: true, state: set({ status: 'ready', source: 'selected', path }) }
    },
    readyPath: () => (current.status === 'ready' ? (current.path ?? null) : null),
  }
}
