import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (event: unknown, arg?: unknown) => unknown>(),
  /** what ensureArtifact does for the current test */
  ensure: (async () => true) as (
    signal: AbortSignal,
    verifying: () => void,
    bytes: (n: number) => void,
  ) => Promise<boolean>,
  onDisk: false,
  resolve: (async () => '') as () => Promise<string>,
  follow: undefined as unknown as (
    listener: (line: { text: string; end?: string }) => void,
  ) => () => void,
  preload: vi.fn(),
  /** button the user picks in the download confirmation: 0 = Download, 1 = Not now */
  answer: 0,
  /** while set, the confirmation stays open until it is called */
  hold: undefined as undefined | Promise<void>,
  asked: [] as { message?: string; detail?: string; buttons?: string[] }[],
}))
vi.mock('electron', () => ({
  app: { getPath: () => fake.userData, whenReady: () => new Promise(() => {}), on: () => {} },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, arg?: unknown) => unknown) =>
      fake.handlers.set(channel, handler),
  },
  shell: { openExternal: vi.fn() },
  net: { isOnline: () => true },
}))
vi.mock('@genoffice/electron-utils/local-chat', () => ({
  registerLocalChat: (
    resolve: () => Promise<string>,
    _failure: unknown,
    _language: unknown,
    follow: typeof fake.follow,
  ) => {
    fake.follow = follow
    fake.resolve = resolve
  },
  shutdownLocalChat: vi.fn(async () => {}),
  preloadLocalChat: fake.preload,
}))
vi.mock('../src/main/app-message-box', () => ({
  showAppMessageBox: async (options: (typeof fake.asked)[number]) => {
    fake.asked.push(options)
    await fake.hold
    return { response: fake.answer, checkboxChecked: false }
  },
}))
vi.mock('../src/main/model-artifacts/model-files', () => ({
  ensureArtifact: async (
    _path: string,
    _file: unknown,
    _url: string,
    signal: AbortSignal,
    onBytes: (n: number) => void,
    _fetch: unknown,
    onVerifying: () => void,
  ) => {
    const downloaded = await fake.ensure(signal, onVerifying, onBytes)
    fake.onDisk = true
    return downloaded
  },
  deleteArtifact: async () => {
    fake.onDisk = false
  },
}))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  stat: async () => {
    if (!fake.onDisk) throw new Error('ENOENT')
    return { size: 1 }
  },
}))
vi.mock('@genoffice/local-llm', async (original) => ({
  ...(await original<object>()),
  verifyModel: async () => {},
}))

import { registerLocalModel } from '../src/main/local-model/ipc'
import {
  LOCAL_MODEL_OFFER_KEY,
  LOCAL_MODEL_REVISION,
  asLocalModelOffer,
} from '../src/main/local-model/offer'

let events: string[]
let startups: unknown[]
let localModel: ReturnType<typeof registerLocalModel>
/** a fresh app session over the same userData */
const launch = () => {
  events = []
  startups = []
  fake.handlers.clear()
  localModel = registerLocalModel(
    () => 'en',
    (channel, payload) => {
      if (channel === 'local-model:startup') startups.push(payload)
      else events.push(channel)
    },
  )
}
const call = (channel: string, arg?: unknown) =>
  Promise.resolve(fake.handlers.get(`local-model:${channel}`)!({}, arg))
const saveProvider = (provider?: string) =>
  writeFileSync(
    join(fake.userData, 'ai-settings.json'),
    JSON.stringify(provider ? { provider, providers: {} } : {}),
  )
const remembered = () =>
  JSON.parse(readFileSync(join(fake.userData, 'app-settings.json'), 'utf8'))[LOCAL_MODEL_OFFER_KEY]
const download = async () => {
  await call('action', 'download')
  await vi.waitFor(async () =>
    expect(((await call('status')) as { status: string }).status).not.toBe('downloading'),
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
}
const toasts = () => events.filter((e) => e === 'local-model:downloaded').length

beforeEach(() => {
  fake.userData = mkdtempSync(join(tmpdir(), 'local-offer-'))
  fake.ensure = async () => true
  fake.onDisk = false
  fake.preload.mockReset()
  fake.preload.mockResolvedValue(true)
  fake.answer = 0
  fake.hold = undefined
  fake.asked = []
})
afterEach(() => rmSync(fake.userData, { recursive: true, force: true }))

describe('a finished download', () => {
  it('is announced once and offered while another provider is saved', async () => {
    saveProvider('gemini')
    launch()
    expect(await call('offer')).toBe(false)
    await download()
    expect(toasts()).toBe(1)
    expect(await call('offer')).toBe(true)
    expect(remembered()).toEqual({ model: LOCAL_MODEL_REVISION, answered: false })
  })

  it('is only announced when Local is already the saved provider', async () => {
    saveProvider('local')
    launch()
    await download()
    expect(toasts()).toBe(1)
    expect(await call('offer')).toBe(false)
  })

  it('is offered on a fresh install, where Local is a default nobody chose', async () => {
    launch()
    await download()
    expect(await call('offer')).toBe(true)
  })

  it('is offered again for a new revision, whatever was answered for the old one', async () => {
    saveProvider('gemini')
    writeFileSync(
      join(fake.userData, 'app-settings.json'),
      JSON.stringify({ [LOCAL_MODEL_OFFER_KEY]: { model: 'lfm3-vl-2b@old', answered: true } }),
    )
    launch()
    expect(await call('offer')).toBe(false)
    await download()
    expect(await call('offer')).toBe(true)
    expect(remembered()).toEqual({ model: LOCAL_MODEL_REVISION, answered: false })
  })

  it('is not announced when the model was already on disk', async () => {
    saveProvider('gemini')
    fake.onDisk = true
    launch() // refresh() finds it
    expect(await call('offer')).toBe(false)
    fake.ensure = async () => false // a download that found a valid file
    await download()
    expect(toasts()).toBe(0)
    expect(await call('offer')).toBe(false)
  })

  it('is not announced after a failure or a cancel', async () => {
    saveProvider('gemini')
    launch()
    fake.ensure = async () => {
      throw new Error('network')
    }
    await download()
    fake.ensure = (signal) =>
      new Promise((resolve) => signal.addEventListener('abort', () => resolve(true)))
    await call('action', 'download')
    await call('action', 'cancel') // even when the last byte wins the race
    expect(events).toEqual([])
    expect(await call('offer')).toBe(false)
  })
})

describe('the answer', () => {
  beforeEach(async () => {
    saveProvider('gemini')
    launch()
    await download()
  })

  it('stays open across a restart until it is given, without a second toast', async () => {
    launch()
    expect(await call('offer')).toBe(true)
    expect(toasts()).toBe(0)
  })

  it('Later keeps the provider and is final for this revision, even after delete and download', async () => {
    await call('answer-offer', 'later')
    expect(fake.preload).not.toHaveBeenCalled()
    expect(readFileSync(join(fake.userData, 'ai-settings.json'), 'utf8')).toContain('gemini')
    launch()
    expect(await call('offer')).toBe(false)
    await call('action', 'delete')
    await download()
    expect(toasts()).toBe(1)
    expect(await call('offer')).toBe(false)
  })

  it('Use now needs the provider saved first, then remembers and preloads', async () => {
    await expect(call('answer-offer', 'use')).rejects.toThrow('not the saved provider')
    expect(await call('offer')).toBe(true)
    saveProvider('local')
    // the settings broadcast makes the card ask again before the answer arrives
    expect(await call('offer')).toBe(false)
    await call('answer-offer', 'use')
    await vi.waitFor(() => expect(fake.preload).toHaveBeenCalledOnce())
    expect(remembered().answered).toBe(true)
  })

  it('Use now reports every step of the load and how it ended', async () => {
    fake.preload.mockImplementation(async (_c, _s, watch) => {
      watch({ phase: 'loading', percent: 40 })
      watch({ phase: 'preparing' })
      return true
    })
    saveProvider('local')
    await call('answer-offer', 'use')
    await vi.waitFor(() => expect(startups.at(-1)).toEqual({ phase: 'ready' }))
    expect(startups).toEqual([
      { phase: 'starting' },
      { phase: 'loading', percent: 40 },
      { phase: 'preparing' },
      { phase: 'ready' },
    ])
  })

  it('a failed load is reported with its own error, and never as ready', async () => {
    vi.spyOn(console, 'warn').mockImplementationOnce(() => {})
    const { LocalLlmError } = await import('@genoffice/local-llm/protocol')
    fake.preload.mockRejectedValue(new LocalLlmError('INSUFFICIENT_RAM', 'At least 2.5 GiB'))
    saveProvider('local')
    await call('answer-offer', 'use')
    await vi.waitFor(() =>
      expect(startups.at(-1)).toEqual({
        phase: 'failed',
        error: 'At least 2.5 GiB',
      }),
    )
  })

  it('a preload failure is not an answer failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fake.preload.mockRejectedValue(new Error('not enough RAM'))
    saveProvider('local')
    await expect(call('answer-offer', 'use')).resolves.toBeUndefined()
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    warn.mockRestore()
  })

  it('choosing Local elsewhere answers it, also after switching away again', async () => {
    saveProvider('local')
    expect(await call('offer')).toBe(false)
    saveProvider('gemini')
    expect(await call('offer')).toBe(false)
  })

  it('deleting the model clears an open question', async () => {
    await call('action', 'delete')
    expect(await call('offer')).toBe(false)
    expect(remembered()).toBeUndefined()
    expect(events.at(-1)).toBe('local-model:offer-changed')
  })

  it('rejects anything but the two answers', async () => {
    await expect(call('answer-offer', 'maybe')).rejects.toThrow()
  })
})

describe('a message sent before the model is there', () => {
  const said = () => fake.resolve().then(String, (e: { code: string; message: string }) => e)

  it('gets a status while downloading, then while verifying, then the model', async () => {
    saveProvider('local')
    launch()
    let verifying!: () => void
    let finish!: () => void
    fake.ensure = (_signal, onVerifying) =>
      new Promise((resolve) => {
        verifying = onVerifying
        finish = () => resolve(true)
      })
    await call('action', 'download')
    await vi.waitFor(() => expect(verifying).toBeDefined())
    expect(await said()).toMatchObject({
      code: 'PREPARING',
      message: expect.stringMatching(/^Downloading Local AI · 0%\n\nYou can send/),
    })
    verifying()
    expect(await call('status')).toEqual({ status: 'verifying', percent: 100 })
    expect(await said()).toMatchObject({
      code: 'PREPARING',
      message: expect.stringMatching(/^Checking the download…/),
    })
    expect(((await call('status')) as { status: string }).status).toBe('verifying')
    finish()
    await vi.waitFor(async () =>
      expect(((await call('status')) as { status: string }).status).toBe('ready'),
    )
    expect(await said()).toContain('.gguf')
  })

  it('is followed by one line that changes in place until the model is ready', async () => {
    saveProvider('local')
    launch()
    await call('offer')
    let verifying!: () => void
    let finish!: () => void
    let bytes!: (n: number) => void
    fake.ensure = (_signal, onVerifying, onBytes) =>
      new Promise((resolve) => {
        bytes = onBytes
        verifying = onVerifying
        finish = () => resolve(true)
      })
    await call('action', 'download')
    await vi.waitFor(() => expect(bytes).toBeDefined())
    const lines: string[] = []
    const stop = fake.follow(({ text, end }) =>
      lines.push(text.split('\n')[0] + (end ? ` [${end}]` : '')),
    )
    const total = 1099627808
    for (const share of [0.8, 0.8001, 0.82, 0.83]) bytes(total * share)
    verifying()
    finish()
    await vi.waitFor(() => expect(lines.at(-1)).toContain('[ready]'))
    expect(lines).toEqual([
      'Downloading Local AI · 0%',
      'Downloading Local AI · 80%',
      'Downloading Local AI · 82%',
      'Downloading Local AI · 83%',
      'Checking the download…',
      'Local AI is ready to chat [ready]',
    ])
    stop()
    await call('action', 'delete')
    expect(lines).toHaveLength(6)
  })

  it('a damaged download keeps its original error, in Settings and in the chat', async () => {
    const { LocalLlmError } = await import('@genoffice/local-llm/protocol')
    saveProvider('gemini')
    launch()
    fake.ensure = async () => {
      throw new LocalLlmError('MODEL_CHECKSUM', 'Local model failed SHA-256 verification')
    }
    await download()
    expect(await call('status')).toMatchObject({
      status: 'error',
      error: 'Local model failed SHA-256 verification',
    })
  })
})

describe('download confirmation', () => {
  const said = () => fake.resolve().then(String, (e: { code: string; message: string }) => e)
  const ensure = () => {
    const started = vi.fn(async () => true)
    fake.ensure = started
    return started
  }

  it('asks before switching to Local AI; Not now keeps the provider and downloads nothing', async () => {
    saveProvider('gemini')
    launch()
    const started = ensure()
    fake.answer = 1
    expect(await localModel.confirmProviderChange('local', 'gemini')).toBe(false)
    expect(fake.asked).toEqual([
      {
        type: 'question',
        title: 'Local chat model',
        message: 'Local AI requires downloading approximately 1.1 GB and will run on this device.',
        detail: 'Do you want to download it now?',
        buttons: ['Download', 'Not now'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(started).not.toHaveBeenCalled()
    expect(await call('status')).toMatchObject({ status: 'missing' })
  })

  it('Download switches and starts the download, with its usual progress', async () => {
    saveProvider('gemini')
    launch()
    const started = ensure()
    expect(await localModel.confirmProviderChange('local', 'gemini')).toBe(true)
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce())
  })

  it('does not ask when the model is already there, or when Local is not being chosen', async () => {
    fake.onDisk = true
    saveProvider('gemini')
    launch()
    expect(await localModel.confirmProviderChange('local', 'gemini')).toBe(true)
    fake.onDisk = false
    launch()
    expect(await localModel.confirmProviderChange('gemini', 'local')).toBe(true)
    expect(await localModel.confirmProviderChange('local', 'local')).toBe(true)
    expect(await localModel.confirmProviderChange('openai', 'gemini')).toBe(true)
    expect(fake.asked).toHaveLength(0)
  })

  it('a chat never starts a new download by itself: Not now gives the original message', async () => {
    saveProvider('local')
    launch()
    const started = ensure()
    fake.answer = 1
    expect(await said()).toMatchObject({ message: 'Not downloaded — Local chat model' })
    expect(fake.asked).toHaveLength(1)
    expect(started).not.toHaveBeenCalled()
  })

  it('a chat after Download follows the download as before', async () => {
    saveProvider('local')
    launch()
    fake.ensure = () => new Promise(() => {})
    expect(await said()).toMatchObject({
      code: 'PREPARING',
      message: expect.stringMatching(/^Downloading Local AI · 0%/),
    })
    expect(fake.asked).toHaveLength(1)
  })

  it('a download the user began goes on without asking again', async () => {
    saveProvider('local')
    launch()
    fake.ensure = (signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      )
    await call('action', 'download')
    expect(await said()).toMatchObject({ code: 'PREPARING' })
    await call('action', 'cancel')
    expect(await call('status')).toMatchObject({ status: 'paused' })
    expect(await said()).toMatchObject({ code: 'PREPARING' })
    expect(await call('status')).toMatchObject({ status: 'downloading' })
    expect(fake.asked).toHaveLength(0)
  })

  it('asks once when a chat and a switch need the model at the same time', async () => {
    saveProvider('local')
    launch()
    fake.answer = 1
    let close!: () => void
    fake.hold = new Promise((resolve) => (close = resolve))
    const both = Promise.all([said(), localModel.confirmProviderChange('local', 'gemini')])
    await vi.waitFor(() => expect(fake.asked).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    close()
    const [chat, switched] = await both
    expect(fake.asked).toHaveLength(1)
    expect(chat).toMatchObject({ message: 'Not downloaded — Local chat model' })
    expect(switched).toBe(false)
  })
})

it('an answer about another revision does not count', () => {
  expect(asLocalModelOffer({ model: 'lfm3@old', answered: true })).toBeUndefined()
  expect(asLocalModelOffer('junk')).toBeUndefined()
})
