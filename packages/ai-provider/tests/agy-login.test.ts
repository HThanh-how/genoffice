import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { AgyLogin, type AgyLoginState } from '../src/agy-login'

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { write: ReturnType<typeof vi.fn> }
    exitCode: number | null
    pid: number
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { write: vi.fn() }
  child.exitCode = null
  child.pid = 0
  child.kill = vi.fn()
  return child
}

const URL_LINE =
  'Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?client_id=1&state=x\n\nWaiting for authentication (timeout 60s)...\n'

function setup() {
  const child = fakeChild()
  const states: AgyLoginState[] = []
  const openUrl = vi.fn()
  const login = new AgyLogin({
    resolveCli: async () => '/bin/agy',
    spawn: () => child as never,
    openUrl,
    onChange: (s) => states.push(s),
  })
  return { child, states, openUrl, login }
}

describe('AgyLogin', () => {
  it('opens the sign-in page once the CLI prints it and waits for the code', async () => {
    const { child, states, openUrl, login } = setup()
    await login.start()
    child.stderr.emit('data', Buffer.from(URL_LINE))
    child.stderr.emit('data', Buffer.from('more'))
    expect(openUrl).toHaveBeenCalledTimes(1)
    expect(openUrl).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/auth?client_id=1&state=x',
    )
    expect(states.at(-1)).toMatchObject({ phase: 'waiting' })
  })

  it('writes the pasted code to the CLI and finishes when it exits cleanly', async () => {
    const { child, login } = setup()
    await login.start()
    child.stdout.emit('data', Buffer.from(URL_LINE))
    expect(login.submitCode('  4/abc  ')).toBe(true)
    expect(child.stdin.write).toHaveBeenCalledWith('4/abc\n')
    expect(login.state().phase).toBe('checking')
    child.stdout.emit('data', Buffer.from('{"event":"command_result"}'))
    child.emit('close', 0)
    expect(login.state().phase).toBe('done')
  })

  it('reports a rejected code, and ignores a code before the page is open', async () => {
    const { child, login } = setup()
    await login.start()
    expect(login.submitCode('x')).toBe(false)
    child.stdout.emit('data', Buffer.from(URL_LINE))
    login.submitCode('bad')
    child.emit('close', 1)
    expect(login.state()).toMatchObject({ phase: 'failed', error: 'rejected' })
  })

  it('reports a missing CLI', async () => {
    const login = new AgyLogin({
      resolveCli: async () => Promise.reject(new Error('nope')),
      spawn: () => fakeChild() as never,
      openUrl: vi.fn(),
      onChange: () => undefined,
    })
    await login.start()
    expect(login.state()).toMatchObject({ phase: 'failed', error: 'cli-missing' })
  })
})
