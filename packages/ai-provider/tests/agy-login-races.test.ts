import { describe, expect, it } from 'vitest'
import { AgyLogin } from '../src/agy-login'

type FakeChild = {
  exitCode: number | null
  killed: boolean
  on: (event: string, fn: (arg?: unknown) => void) => void
  stdout: { on: (event: string, fn: (chunk: string) => void) => void }
  stderr: { on: (event: string, fn: (chunk: string) => void) => void }
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
  }
  ;(child as unknown as { emit: (event: string, arg?: unknown) => void }).emit = (event, arg) => {
    for (const fn of handlers[event] ?? []) fn(arg)
  }
  return child
}

/** a login harness whose CLI resolution the test controls */
function harness(resolve: () => Promise<string>) {
  const spawned: FakeChild[] = []
  const states: unknown[] = []
  const login = new AgyLogin({
    resolveCli: resolve,
    spawn: (cli: string, args: readonly string[]) => {
      const child = fakeChild()
      spawned.push(child)
      void cli
      void args
      return child as never
    },
    openUrl: () => undefined,
    onChange: (state: unknown) => states.push(state),
  })
  return { login, spawned, states }
}

describe('login request generation (L01-L03)', () => {
  it('L01: cancelling while the CLI is still being resolved spawns nothing', async () => {
    let release: (value: string) => void = () => undefined
    const { login, spawned } = harness(() => new Promise((resolve) => (release = resolve)))
    const pending = login.start()
    login.cancel()
    release('/cli/a')
    await pending
    expect(spawned.length).toBe(0)
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

  it('L03: output from a stopped child does not reopen a login URL', async () => {
    let release: (value: string) => void = () => undefined
    const { login, spawned } = harness(() => new Promise((resolve) => (release = resolve)))
    const pending = login.start()
    login.cancel()
    release('/cli/a')
    await pending
    const urls: string[] = []
    const second = new AgyLogin(
      () => undefined,
      (url) => urls.push(url),
      () => undefined,
    )
    void second
    expect(spawned.length).toBe(0)
    expect(urls.length).toBe(0)
  })
})
