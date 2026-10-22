import { describe, expect, it } from 'vitest'
import { AgyLogin } from '../src/agy-login'

type FakeChild = {
  exitCode: number | null
  killed: boolean
  on: (event: string, fn: (arg?: unknown) => void) => void
  stdout: { on: (event: string, fn: (chunk: string) => void) => void }
  stderr: { on: (event: string, fn: (chunk: string) => void) => void }
  emit: (event: string, arg?: unknown) => void
}

function fakeChild(): FakeChild {
  const handlers: Record<string, Array<(arg?: unknown) => void>> = {}
  const child: FakeChild = {
    exitCode: null,
    killed: false,
    on: (event, fn) => {
      handlers[event] = [...(handlers[event] ?? []), fn]
    },
    stdout: {
      on: (_event, fn) =>
        (handlers.stdout = [...(handlers.stdout ?? []), fn as (arg?: unknown) => void]),
    },
    stderr: {
      on: (_event, fn) =>
        (handlers.stderr = [...(handlers.stderr ?? []), fn as (arg?: unknown) => void]),
    },
    emit: (event, arg) => {
      for (const fn of handlers[event] ?? []) fn(arg)
    },
  }
  return child
}

/** a login harness whose CLI resolution the test controls, and whose browser is a recording spy */
function harness(resolve: () => Promise<string>) {
  const spawned: FakeChild[] = []
  const states: unknown[] = []
  const urls: string[] = []
  const login = new AgyLogin({
    resolveCli: resolve,
    spawn: (cli: string, args: readonly string[]) => {
      const child = fakeChild()
      spawned.push(child)
      void cli
      void args
      return child as never
    },
    openUrl: (url: string) => urls.push(url),
    onChange: (state: unknown) => states.push(state),
  })
  return { login, spawned, states, urls }
}

const LOGIN_URL = 'https://accounts.google.com/o/oauth2/auth?hl=en'

describe('login request generation (L01-L05)', () => {
  it('L01: cancelling while the CLI is still being resolved spawns nothing', async () => {
    let release: (value: string) => void = () => undefined
    const { login, spawned, urls } = harness(() => new Promise((resolve) => (release = resolve)))
    const pending = login.start()
    login.cancel()
    release('/cli/a')
    await pending
    expect(spawned.length).toBe(0)
    expect(urls.length).toBe(0)
    expect(login.state().phase).toBe('idle')
  })

  it('L02: a superseded start cannot replace the newer active child', async () => {
    const resolvers: Array<(value: string) => void> = []
    const { login, spawned } = harness(() => new Promise((resolve) => resolvers.push(resolve)))
    const a = login.start()
    const b = login.start()
    resolvers[1]!('/cli/b')
    await b
    resolvers[0]!('/cli/a')
    await a
    expect(spawned.length).toBe(1)
    expect(spawned[0]).not.toBe(undefined)
  })

  it('L03: a real child that was cancelled cannot open its login URL', async () => {
    const { login, spawned, urls } = harness(async () => '/cli/a')
    await login.start()
    // the process really exists and its output handlers are registered
    expect(spawned.length).toBe(1)
    const child = spawned[0]!

    login.cancel()
    expect(login.state().phase).toBe('idle')

    // the same cancelled child prints its Google URL after being stopped
    child.emit('stdout', `sign in at ${LOGIN_URL}\n`)
    child.emit('stderr', `${LOGIN_URL}?sig=old`)
    child.emit('close', 1)

    expect(urls.length).toBe(0)
    expect(login.state().phase).toBe('idle')
    expect(login.state().url).toBeUndefined()
  })

  it('L04: a superseded child cannot change the newer login or open its URL', async () => {
    const { login, spawned, urls } = harness(async () => '/cli/a')
    await login.start()
    const old = spawned[0]!
    await login.start()
    const fresh = spawned[1]!
    expect(old).not.toBe(fresh)

    old.emit('stdout', `${LOGIN_URL}?sig=old`)
    expect(urls.length).toBe(0)
    expect(login.state().phase).toBe('starting')

    fresh.emit('stdout', `${LOGIN_URL}?sig=new`)
    expect(urls).toEqual([`${LOGIN_URL}?sig=new`])
    expect(login.state().phase).toBe('waiting')
    expect(login.state().url).toBe(`${LOGIN_URL}?sig=new`)
    expect(login.submitCode('4/abc')).toBe(true)
    expect(login.state().phase).toBe('checking')
  })

  it('L05: a normal sign-in still opens the URL, takes the code and finishes', async () => {
    const { login, spawned, urls } = harness(async () => '/cli/a')
    await login.start()
    const child = spawned[0]!

    child.emit('stdout', `sign in at ${LOGIN_URL}\n`)
    expect(urls).toEqual([LOGIN_URL])
    expect(login.state().phase).toBe('waiting')

    expect(login.submitCode('4/12345')).toBe(true)
    expect(login.state().phase).toBe('checking')

    child.emit('stdout', '{"usage":{"total_tokens":12}}')
    child.emit('close', 0)
    expect(login.state().phase).toBe('done')
  })
})
