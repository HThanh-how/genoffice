import { CLI, FakeChild, runDeps, tick } from './helpers/agy-fake'
import { describe, expect, it, vi } from 'vitest'
import { AgyError } from '../src/agy-errors'
import { buildAgyArgs, createAgyLimiter, parseAgyStreamLine, runAgy } from '../src/agy-cli'
import type { AgyRunDeps } from '../src/agy-cli'
import type { AgyMachineSemaphore } from '../src/agy-lock'

const OK_LINES = [
  '{"event":"init","conversation_id":"c1","init":{"model":"m"}}',
  '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Tea began in China."}}',
  '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"Tea began in China."}}',
]

// Recorded from a real `agy 1.3.2 ... --print-timeout 4s` run (2026-10-09): exit 0, a SUCCESS
// result with nothing in it, and only this stderr line to say the turn was cut off.
const PRINT_TIMEOUT_STDERR =
  '[agy] print timeout after 4s with turn in progress; returning partial output\n'
const PRINT_TIMEOUT_RESULT =
  '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"","duration_seconds":0,"num_turns":1,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}'

async function start<T>(
  options: Parameters<typeof runAgy>[0],
  deps: AgyRunDeps,
  child: FakeChild,
  settle: (child: FakeChild) => void,
): Promise<{ value?: T; error?: unknown }> {
  const promise = runAgy(options, deps)
  promise.catch(() => undefined)
  await tick()
  await tick()
  await tick()
  settle(child)
  try {
    return { value: (await promise) as T }
  } catch (error) {
    return { error }
  }
}

describe('runAgy: typed failures', () => {
  it('exit code 3 with an AGY_ERROR line is a typed quota error carrying the reset time', async () => {
    const child = new FakeChild()
    const { deps } = runDeps(child)
    const resetAt = Date.now() + 3 * 3_600_000
    const { error } = await start({ cliPath: CLI, model: 'm', prompt: 'p' }, deps, child, (c) => {
      c.stderr.write(
        `AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"retryable":false,"message":"Quota exceeded. Resets at ${new Date(resetAt).toISOString()}"}\n`,
      )
      c.exit(3)
    })
    expect(error).toBeInstanceOf(AgyError)
    expect(error).toMatchObject({ kind: 'quota', retryable: false, exitCode: 3 })
    expect((error as AgyError).resetAt).toBe(resetAt)
  })

  it('a failure after part of the answer streamed (exit 3) rejects even though a result arrived', async () => {
    const child = new FakeChild()
    const { deps } = runDeps(child)
    const deltas: string[] = []
    const { error } = await start(
      { cliPath: CLI, model: 'm', prompt: 'p', onText: (t) => deltas.push(t) },
      deps,
      child,
      (c) => {
        c.emitLines(OK_LINES)
        c.stderr.write('AGY_ERROR: {"status":"UNAVAILABLE","code":503,"retryable":true}\n')
        c.exit(3)
      },
    )
    expect(error).toMatchObject({
      kind: 'model',
      retryable: true,
      partialText: 'Tea began in China.',
    })
    expect(deltas.join('')).toBe('Tea began in China.')
  })

  it('a signed-out CLI is an auth error, whatever the exit code', async () => {
    const child = new FakeChild()
    const { deps } = runDeps(child)
    const { error } = await start({ cliPath: CLI, model: 'm', prompt: 'p' }, deps, child, (c) => {
      c.stderr.write('Authentication required\n')
      c.exit(1)
    })
    expect(error).toMatchObject({ kind: 'auth', retryable: false })
    expect((error as Error).message).toMatch(/not signed in/)
  })

  it('finds the AGY_ERROR line even after more than 8000 characters of progress noise', async () => {
    const child = new FakeChild()
    const { deps } = runDeps(child)
    const { error } = await start({ cliPath: CLI, model: 'm', prompt: 'p' }, deps, child, (c) => {
      c.stderr.write(`${'working...\n'.repeat(2000)}`)
      c.stderr.write(
        'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","retryable":false,"message":"daily quota exhausted"}\n',
      )
      c.exit(3)
    })
    expect(error).toMatchObject({ kind: 'quota' })
  })
})

describe('runAgy: --print-timeout expiry', () => {
  it('is a failure, not an empty success: the CLI exits 0 and only warns on stderr', async () => {
    const child = new FakeChild()
    const { deps, removed, dirs } = runDeps(child)
    const { error } = await start({ cliPath: CLI, model: 'm', prompt: 'p' }, deps, child, (c) => {
      c.stderr.write(PRINT_TIMEOUT_STDERR)
      c.emitLines([PRINT_TIMEOUT_RESULT])
      c.exit(0)
    })
    expect(error).toBeInstanceOf(AgyError)
    expect(error).toMatchObject({ kind: 'timeout', retryable: true })
    expect((error as Error).message).toMatch(/timed out/)
    expect(removed).toEqual(dirs)
  })

  it('never presents a cut-off answer as complete, but keeps it on the error', async () => {
    const child = new FakeChild()
    const { deps } = runDeps(child)
    const { error } = await start({ cliPath: CLI, model: 'm', prompt: 'p' }, deps, child, (c) => {
      c.stderr.write(PRINT_TIMEOUT_STDERR)
      c.emitLines(OK_LINES)
      c.exit(0)
    })
    expect(error).toMatchObject({ kind: 'timeout', partialText: 'Tea began in China.' })
  })

  it('allowPartial hands the partial text back marked as truncated', async () => {
    const child = new FakeChild()
    const { deps } = runDeps(child)
    const { value } = await start<{ text: string; truncated?: boolean }>(
      { cliPath: CLI, model: 'm', prompt: 'p', allowPartial: true },
      deps,
      child,
      (c) => {
        c.stderr.write(PRINT_TIMEOUT_STDERR)
        c.emitLines(OK_LINES)
        c.exit(0)
      },
    )
    expect(value).toMatchObject({ text: 'Tea began in China.', truncated: true })
  })

  it('a normal finish is not marked truncated', async () => {
    const child = new FakeChild()
    const { deps } = runDeps(child)
    const { value } = await start<{ text: string; truncated?: boolean }>(
      { cliPath: CLI, model: 'm', prompt: 'p' },
      deps,
      child,
      (c) => {
        c.stderr.write('Fetching available models...\n')
        c.emitLines(OK_LINES)
        c.exit(0)
      },
    )
    expect(value?.text).toBe('Tea began in China.')
    expect(value?.truncated).toBeUndefined()
  })
})

describe('runAgy: machine-wide limiter', () => {
  function semaphore() {
    const released = vi.fn()
    const acquire = vi.fn(async (_hold: number, _signal?: AbortSignal) => async () => {
      released()
    })
    return { sem: { acquire } as AgyMachineSemaphore, acquire, released }
  }

  it('takes a machine slot for the run (hold = request timeout) and gives it back', async () => {
    const child = new FakeChild()
    const { sem, acquire, released } = semaphore()
    const { deps } = runDeps(child, { machineSemaphore: sem })
    const ctrl = new AbortController()
    const { value } = await start(
      { cliPath: CLI, model: 'm', prompt: 'p', timeoutMs: 90_000, signal: ctrl.signal },
      deps,
      child,
      (c) => {
        expect(released).not.toHaveBeenCalled()
        c.emitLines(OK_LINES)
        c.exit(0)
      },
    )
    expect(value).toBeDefined()
    expect(acquire).toHaveBeenCalledWith(90_000, ctrl.signal)
    expect(released).toHaveBeenCalledTimes(1)
  })

  it('gives the slot back when the run fails or is aborted', async () => {
    const child = new FakeChild()
    const { sem, released } = semaphore()
    const { deps, spawned } = runDeps(child, { machineSemaphore: sem })
    const failed = await start({ cliPath: CLI, model: 'm', prompt: 'p' }, deps, child, (c) => {
      c.stderr.write('boom\n')
      c.exit(1)
    })
    expect(failed.error).toBeDefined()
    expect(released).toHaveBeenCalledTimes(1)

    const ctrl = new AbortController()
    const second = new FakeChild()
    const again = runDeps(second, { machineSemaphore: sem })
    const promise = runAgy(
      { cliPath: CLI, model: 'm', prompt: 'p', signal: ctrl.signal },
      again.deps,
    )
    promise.catch(() => undefined)
    await tick()
    await tick()
    await tick()
    ctrl.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(released).toHaveBeenCalledTimes(2)
    expect(spawned).toHaveLength(1)
  })

  it('does not spawn when the machine slot never comes, and frees the process slot', async () => {
    const limiter = createAgyLimiter(1)
    const child = new FakeChild()
    const sem: AgyMachineSemaphore = {
      acquire: async () => {
        throw new Error('Other GenOffice windows are using Antigravity right now.')
      },
    }
    const { deps, spawned } = runDeps(child, { machineSemaphore: sem })
    await expect(runAgy({ cliPath: CLI, model: 'm', prompt: 'p', limiter }, deps)).rejects.toThrow(
      /Other GenOffice windows/,
    )
    expect(spawned).toHaveLength(0)
    // the single in-process slot is free again
    const release = await limiter.acquire()
    release()
  })
})

describe('runAgy: --effort', () => {
  const caps =
    (effort: boolean, jsonSchema = false) =>
    async () => ({ effort, jsonSchema })

  async function argsFor(
    options: Partial<Parameters<typeof runAgy>[0]>,
    overrides: Partial<AgyRunDeps>,
  ): Promise<string[]> {
    const child = new FakeChild()
    const { deps, spawned } = runDeps(child, overrides)
    await start(
      { cliPath: CLI, model: 'claude-sonnet-4-6', prompt: 'p', ...options },
      deps,
      child,
      (c) => {
        c.emitLines(OK_LINES)
        c.exit(0)
      },
    )
    return spawned[0]!.args
  }

  it('passes the task default when the installed agy lists --effort', async () => {
    expect(await argsFor({ task: 'search' }, { capabilities: caps(true) })).toEqual(
      expect.arrayContaining(['--effort', 'low']),
    )
    expect(await argsFor({ task: 'chat' }, { capabilities: caps(true) })).toEqual(
      expect.arrayContaining(['--effort', 'medium']),
    )
    expect(await argsFor({ task: 'ocr' }, { capabilities: caps(true) })).toContain('low')
  })

  it('an explicit level wins over the task default', async () => {
    const args = await argsFor({ task: 'search', effort: 'high' }, { capabilities: caps(true) })
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual([
      '--effort',
      'high',
    ])
  })

  it('does not pass it when agy lacks the flag, no capability probe exists, or nothing asked for it', async () => {
    expect(await argsFor({ task: 'search' }, { capabilities: caps(false) })).not.toContain(
      '--effort',
    )
    expect(await argsFor({ task: 'search' }, {})).not.toContain('--effort')
    expect(await argsFor({}, { capabilities: caps(true) })).not.toContain('--effort')
  })

  it('leaves models that carry their effort in the id alone (the user chose them)', async () => {
    for (const model of ['gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'gpt-oss-120b-medium']) {
      expect(await argsFor({ model, task: 'search' }, { capabilities: caps(true) })).not.toContain(
        '--effort',
      )
    }
  })

  it('GENOFFICE_AGY_EFFORT=off switches the flag off and a level forces it', async () => {
    const base = runDeps(new FakeChild()).deps
    expect(
      await argsFor(
        { task: 'search' },
        { capabilities: caps(true), env: { ...base.env, GENOFFICE_AGY_EFFORT: 'off' } },
      ),
    ).not.toContain('--effort')
    const forced = await argsFor(
      { task: 'search' },
      { capabilities: caps(true), env: { ...base.env, GENOFFICE_AGY_EFFORT: 'max' } },
    )
    expect(forced.slice(forced.indexOf('--effort'), forced.indexOf('--effort') + 2)).toEqual([
      '--effort',
      'max',
    ])
  })

  it('buildAgyArgs adds the flags only when given, before --add-dir', () => {
    const args = buildAgyArgs({
      model: 'm',
      stagingDir: '/s',
      timeoutMs: 60_000,
      effort: 'low',
      jsonSchemaPath: '/s/schema.json',
    })
    expect(args.slice(-6)).toEqual([
      '--effort',
      'low',
      '--json-schema',
      '/s/schema.json',
      '--add-dir',
      '/s',
    ])
  })
})

describe('runAgy: --json-schema', () => {
  const schema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  }
  const STRUCTURED_RESULT =
    '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"{\\"answer\\":\\"pong\\",\\"toolAction\\":\\"x\\"}","structured_output":{"answer":"pong"},"json_schema":{"type":"object"}}}'

  it('parses structured_output from the result event (shape recorded from a real run)', () => {
    expect(parseAgyStreamLine(STRUCTURED_RESULT)).toMatchObject({
      kind: 'result',
      ok: true,
      structured: { answer: 'pong' },
    })
  })

  it('stages the schema next to the request, passes its path and returns the validated object', async () => {
    const child = new FakeChild()
    const { deps, spawned, written } = runDeps(child, {
      capabilities: async () => ({ effort: false, jsonSchema: true }),
    })
    const { value } = await start<{ structured?: unknown }>(
      { cliPath: CLI, model: 'm', prompt: 'p', jsonSchema: schema },
      deps,
      child,
      (c) => {
        c.emitLines([STRUCTURED_RESULT])
        c.exit(0)
      },
    )
    const args = spawned[0]!.args
    const flag = args.indexOf('--json-schema')
    expect(flag).toBeGreaterThan(-1)
    expect(args[flag + 1]).toMatch(/stage-0\\agy-response-schema\.json$/)
    expect(written.map((w) => w.path)).toContain(args[flag + 1])
    expect(value?.structured).toEqual({ answer: 'pong' })
  })

  it('drops the schema when the installed agy does not support it', async () => {
    const child = new FakeChild()
    const { deps, spawned } = runDeps(child, {
      capabilities: async () => ({ effort: false, jsonSchema: false }),
    })
    await start({ cliPath: CLI, model: 'm', prompt: 'p', jsonSchema: schema }, deps, child, (c) => {
      c.emitLines(OK_LINES)
      c.exit(0)
    })
    expect(spawned[0]!.args).not.toContain('--json-schema')
  })

  it('refuses a schema whose root is not an object before anything starts', async () => {
    const child = new FakeChild()
    const { deps, spawned } = runDeps(child)
    await expect(
      runAgy({ cliPath: CLI, model: 'm', prompt: 'p', jsonSchema: { type: 'string' } }, deps),
    ).rejects.toThrow(/root must be "type": "object"/)
    expect(spawned).toHaveLength(0)
  })
})
