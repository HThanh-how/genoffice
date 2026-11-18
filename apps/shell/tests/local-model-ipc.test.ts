import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// the IPC module imports electron's dialog; a test never opens one
vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }))

import { registerLocalModel } from '../src/main/fork/local-model-ipc'
import {
  createLocalModelManager,
  type LocalModelManager,
} from '../src/main/local-model/local-model-manager'
import type { FetchLike, ModelArtifactManifest } from '../src/main/document-memory/embedding/model-files'
import {
  LOCAL_MODEL_CHANNELS,
  type LocalModelSelectOutcome,
  type LocalModelState,
} from '../src/shared/fork/local-model-api'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function fakeIpc() {
  const handlers = new Map<string, Handler>()
  return {
    ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) } as unknown as IpcMain,
    channels: () => [...handlers.keys()],
    call: async <T>(channel: string, ...args: unknown[]): Promise<T> => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`no handler registered for ${channel}`)
      return (await handler({}, ...args)) as T
    },
  }
}

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const SIZE = 64_000

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('local model IPC', () => {
  let userData: string
  let good: Buffer
  let manifest: ModelArtifactManifest
  let fetchImpl: FetchLike
  let dialogOutcome: { canceled: boolean; filePaths: string[] }
  let dialogCalls: unknown[][]

  /** a whole file in one body */
  const serve =
    (bytes: Buffer): FetchLike =>
    async () =>
      new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-length': String(bytes.length) } })

  /** a body that sends a first chunk and then waits until the request is aborted */
  const hang: FetchLike = async (_url, init) => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(SIZE) }),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(good.subarray(0, 1000)))
        init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
      },
    }),
  })

  const managerFor = (fetch: () => FetchLike): LocalModelManager =>
    createLocalModelManager({
      userDataPath: userData,
      manifest,
      fetchImpl: (url, init) => fetch()(url, init),
      freeBytes: async () => null,
      retryDelaysMs: [0],
      stallTimeoutMs: 5000,
    })

  const setup = (manager = managerFor(() => fetchImpl)) => {
    const ipc = fakeIpc()
    registerLocalModel({
      ipcMain: ipc.ipcMain,
      userDataPath: () => userData,
      manager,
      dialogProvider: {
        showOpenDialog: async (...args) => {
          dialogCalls.push(args)
          return dialogOutcome
        },
      },
    })
    return ipc
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'genoffice-local-model-ipc-'))
    good = randomBytes(SIZE)
    manifest = {
      id: 'test-local-model',
      repo: 'test-org/test-model-GGUF',
      revision: 'd'.repeat(40),
      files: [{ path: 'Test-Q4_K_M.gguf', sha256: sha(good), bytes: SIZE }],
      mirrorable: false,
    }
    fetchImpl = serve(good)
    dialogOutcome = { canceled: true, filePaths: [] }
    dialogCalls = []
  })
  afterEach(() => rmSync(userData, { recursive: true, force: true }))

  it('registers exactly the five local-model channels', () => {
    const ipc = setup()
    expect(ipc.channels().sort()).toEqual(Object.values(LOCAL_MODEL_CHANNELS).sort())
  })

  it('answers getState from disk, including a model chosen in an earlier session', async () => {
    const copy = join(userData, 'kept.gguf')
    writeFileSync(copy, good)
    await managerFor(() => fetchImpl).selectExisting(copy)
    const ipc = setup()
    expect(await ipc.call<LocalModelState>(LOCAL_MODEL_CHANNELS.getState)).toMatchObject({
      status: 'ready',
      source: 'selected',
      path: copy,
    })
  })

  it('download answers at once and the polled state reaches ready', async () => {
    const ipc = setup()
    const first = await ipc.call<LocalModelState>(LOCAL_MODEL_CHANNELS.download)
    expect(['not-installed', 'downloading', 'ready']).toContain(first.status)
    await until(
      async () => (await ipc.call<LocalModelState>(LOCAL_MODEL_CHANNELS.getState)).status === 'ready',
    )
    const ready = await ipc.call<LocalModelState>(LOCAL_MODEL_CHANNELS.getState)
    expect(ready).toMatchObject({ source: 'downloaded' })
    expect(existsSync(ready.path!)).toBe(true)
  })

  it('a failed download shows up in the state, not as a rejected call', async () => {
    fetchImpl = serve(randomBytes(SIZE)) // wrong bytes
    const ipc = setup()
    await ipc.call(LOCAL_MODEL_CHANNELS.download)
    await until(
      async () => (await ipc.call<LocalModelState>(LOCAL_MODEL_CHANNELS.getState)).status === 'error',
    )
    expect((await ipc.call<LocalModelState>(LOCAL_MODEL_CHANNELS.getState)).error?.code).toBe('checksum')
  })

  it('cancel stops a running download', async () => {
    fetchImpl = hang
    const ipc = setup()
    await ipc.call(LOCAL_MODEL_CHANNELS.download)
    await until(
      async () =>
        (await ipc.call<LocalModelState>(LOCAL_MODEL_CHANNELS.getState)).status === 'downloading',
    )
    const cancelled = await ipc.call<LocalModelState>(LOCAL_MODEL_CHANNELS.cancel)
    expect(cancelled.status).toBe('not-installed')
  })

  it('delete removes the downloaded model', async () => {
    const ipc = setup()
    await ipc.call(LOCAL_MODEL_CHANNELS.download)
    await until(
      async () => (await ipc.call<LocalModelState>(LOCAL_MODEL_CHANNELS.getState)).status === 'ready',
    )
    const path = (await ipc.call<LocalModelState>(LOCAL_MODEL_CHANNELS.getState)).path!
    expect((await ipc.call<LocalModelState>(LOCAL_MODEL_CHANNELS.delete)).status).toBe('not-installed')
    expect(existsSync(path)).toBe(false)
  })

  it('runs beforeDelete (stop llama-server) while the file still exists, and still deletes if it fails', async () => {
    const manager = managerFor(() => fetchImpl)
    const seen: boolean[] = []
    const register = (beforeDelete: () => void) => {
      const ipc = fakeIpc()
      registerLocalModel({ ipcMain: ipc.ipcMain, userDataPath: () => userData, manager, beforeDelete })
      return ipc
    }
    const ipc = register(() => {
      seen.push(existsSync(manager.readyPath() ?? ''))
    })
    await ipc.call(LOCAL_MODEL_CHANNELS.download)
    await until(async () => (await ipc.call<LocalModelState>(LOCAL_MODEL_CHANNELS.getState)).status === 'ready')
    const path = manager.readyPath()!
    expect((await ipc.call<LocalModelState>(LOCAL_MODEL_CHANNELS.delete)).status).toBe('not-installed')
    expect(seen).toEqual([true])
    expect(existsSync(path)).toBe(false)

    // a hook that throws does not keep the model on disk
    const failing = register(() => {
      throw new Error('stop failed')
    })
    await failing.call(LOCAL_MODEL_CHANNELS.download)
    await until(async () => manager.readyPath() !== null)
    expect((await failing.call<LocalModelState>(LOCAL_MODEL_CHANNELS.delete)).status).toBe('not-installed')
  })

  describe('selectExisting', () => {
    it('reports a closed dialog as cancelled and changes nothing', async () => {
      const ipc = setup()
      const outcome = await ipc.call<LocalModelSelectOutcome>(LOCAL_MODEL_CHANNELS.selectExisting)
      expect(outcome).toMatchObject({ ok: false, cancelled: true, state: { status: 'not-installed' } })
    })

    it('uses a renamed copy chosen in the dialog', async () => {
      const copy = join(userData, 'whatever-name.bin')
      writeFileSync(copy, good)
      dialogOutcome = { canceled: false, filePaths: [copy] }
      const ipc = setup()
      const outcome = await ipc.call<LocalModelSelectOutcome>(LOCAL_MODEL_CHANNELS.selectExisting)
      expect(outcome).toMatchObject({ ok: true, state: { status: 'ready', source: 'selected', path: copy } })
    })

    it('rejects a different file and a non-absolute path', async () => {
      const other = join(userData, 'other.gguf')
      writeFileSync(other, randomBytes(SIZE))
      dialogOutcome = { canceled: false, filePaths: [other] }
      const ipc = setup()
      expect(await ipc.call(LOCAL_MODEL_CHANNELS.selectExisting)).toMatchObject({
        ok: false,
        error: { code: 'wrong-model' },
      })
      dialogOutcome = { canceled: false, filePaths: ['relative.gguf'] }
      expect(await ipc.call(LOCAL_MODEL_CHANNELS.selectExisting)).toMatchObject({
        ok: false,
        error: { code: 'not-found' },
      })
    })

    it('parents the dialog to the app window when there is one', async () => {
      const ipc = fakeIpc()
      const win = { isDestroyed: () => false }
      registerLocalModel({
        ipcMain: ipc.ipcMain,
        userDataPath: () => userData,
        manager: managerFor(() => fetchImpl),
        parentWindow: () => win as never,
        dialogProvider: {
          showOpenDialog: async (...args) => {
            dialogCalls.push(args)
            return { canceled: true, filePaths: [] }
          },
        },
      })
      await ipc.call(LOCAL_MODEL_CHANNELS.selectExisting)
      expect(dialogCalls[0]![0]).toBe(win)
      expect((dialogCalls[0]![1] as { properties: string[] }).properties).toEqual(['openFile'])
    })
  })
})
