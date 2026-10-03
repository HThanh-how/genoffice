import { CLI, FakeChild, fsDeps, runDeps, tick } from './helpers/agy-fake'
import { describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@genoffice/agent-core'
import {
  AGY_DEFAULT_MODEL,
  AGY_KILL_GRACE_MS,
  agyAutoDetectHint,
  agyDefaultLocations,
  agyUsageToTokenUsage,
  buildAgyArgs,
  buildAgyPrompt,
  buildAgyStdin,
  chatAgy,
  cleanAgyError,
  clearAgyModelsCache,
  createAgyLimiter,
  isCliProvider,
  killProcessTree,
  listAgyModels,
  parseAgyModels,
  expandWindowsVariables,
  parseAgyStreamLine,
  parseRegistryPathOutput,
  resolveAgyCliPath,
  runAgy,
  streamAgy,
  validateAgyCliPath,
} from '../src/agy-cli'

// --- fixtures recorded from `agy 2026-10 -p ... --output-format stream-json` (init event trimmed) ---
const FIXTURE_OK = [
  '{"event":"init","conversation_id":"c1","init":{"model":"gemini-3.7-flash-low","cwd":"X","tools":["view_file"],"permission_mode":"request-review"}}',
  '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"PONG\\n1\\n2\\n3\\n4\\n5"}}',
  '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":2.83,"usage":{"input_tokens":14571,"output_tokens":302,"thinking_tokens":290,"cache_read_tokens":0,"total_tokens":14873}}}',
  '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"PONG\\n1\\n2\\n3\\n4\\n5\\n","duration_seconds":2.92,"num_turns":1,"usage":{"input_tokens":14571,"output_tokens":302,"thinking_tokens":290,"cache_read_tokens":0,"total_tokens":14873}}}',
]
const FIXTURE_BAD_MODEL =
  '{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"invalid model selection (--model \\"nope\\" --effort \\"\\"): model nope is not recognized as a known model or custom model in settings\\nAvailable models:\\n  Gemini 3.8 Flash (High)\\n  Gemini 3.8 Flash (Medium)"}}'

describe('agy path validation and discovery', () => {
  it('accepts an absolute existing .exe on win32 and rejects relative, meta and non-exe paths', async () => {
    const deps = fsDeps('win32', { [CLI]: { exec: false }, 'C:\\a\\agy.cmd': { exec: true } })
    await expect(validateAgyCliPath(CLI, deps)).resolves.toBeUndefined()
    await expect(validateAgyCliPath('agy.exe', deps)).rejects.toThrow(/absolute/)
    await expect(validateAgyCliPath('C:\\agy\\agy.exe & calc', deps)).rejects.toThrow(/absolute/)
    await expect(validateAgyCliPath('C:\\agy\\a"b.exe', deps)).rejects.toThrow(/absolute/)
    await expect(validateAgyCliPath('C:\\a\\agy.cmd', deps)).rejects.toThrow(/agy\.exe/)
    await expect(validateAgyCliPath('C:\\missing\\agy.exe', deps)).rejects.toThrow(/not found/)
  })

  it.each(['darwin', 'linux'] as const)(
    'on %s accepts an extensionless file only with the executable bit',
    async (platform) => {
      const deps = fsDeps(platform, {
        '/usr/local/bin/agy': { exec: true },
        '/opt/noexec/agy': { exec: false },
      })
      await expect(validateAgyCliPath('/usr/local/bin/agy', deps)).resolves.toBeUndefined()
      await expect(validateAgyCliPath('/opt/noexec/agy', deps)).rejects.toThrow(/not executable/)
      await expect(validateAgyCliPath('bin/agy', deps)).rejects.toThrow(/absolute/)
      await expect(validateAgyCliPath('/x/agy;rm -rf', deps)).rejects.toThrow(/absolute/)
      await expect(validateAgyCliPath('/x/$(id)/agy', deps)).rejects.toThrow(/absolute/)
    },
  )

  it('resolves win32: configured path, PATH entry, then %LOCALAPPDATA%', async () => {
    const files = { [CLI]: { exec: false }, 'C:\\Local\\agy\\bin\\agy.exe': { exec: false } }
    const base = fsDeps('win32', files)
    expect(await resolveAgyCliPath(CLI, base)).toBe(CLI)
    expect(
      await resolveAgyCliPath('', {
        ...base,
        env: { PATH: 'C:\\x;"C:\\agy"', LOCALAPPDATA: 'C:\\Local' },
      }),
    ).toBe(CLI)
    expect(
      await resolveAgyCliPath(undefined, { ...base, env: { LOCALAPPDATA: 'C:\\Local' } }),
    ).toBe('C:\\Local\\agy\\bin\\agy.exe')
    await expect(resolveAgyCliPath(undefined, { ...base, env: {} })).rejects.toThrow(/not found/)
    await expect(resolveAgyCliPath('C:\\nope\\agy.exe', base)).rejects.toThrow(/not found/)
  })

  it('finds agy on the PATH the registry holds now, which a running app has not seen', async () => {
    const installed = 'C:\\Users\\u\\tools\\agy.exe'
    const base = fsDeps('win32', { [installed]: { exec: false } })
    const env = { PATH: 'C:\\Windows', LOCALAPPDATA: 'C:\\Local', USERPROFILE: 'C:\\Users\\u' }
    // not on this process's PATH and not in a default place: only the registry knows
    await expect(resolveAgyCliPath(undefined, { ...base, env })).rejects.toThrow(/not found/)
    expect(
      await resolveAgyCliPath(undefined, {
        ...base,
        env,
        registryPath: async () => '%USERPROFILE%\\tools;C:\\Windows',
      }),
    ).toBe(installed)
    // a registry that cannot be read changes nothing
    await expect(
      resolveAgyCliPath(undefined, {
        ...base,
        env,
        registryPath: async () => {
          throw new Error('denied')
        },
      }),
    ).rejects.toThrow(/not found/)
  })

  it('also looks where Antigravity installs itself on Windows', async () => {
    const files = {
      'C:\\Local\\Programs\\Antigravity\\bin\\agy.exe': { exec: false },
      'C:\\Users\\u\\.agy\\bin\\agy.exe': { exec: false },
    }
    const env = { LOCALAPPDATA: 'C:\\Local', USERPROFILE: 'C:\\Users\\u' }
    expect(await resolveAgyCliPath(undefined, { ...fsDeps('win32', files), env })).toBe(
      'C:\\Local\\Programs\\Antigravity\\bin\\agy.exe',
    )
    const onlyHome = { 'C:\\Users\\u\\.agy\\bin\\agy.exe': { exec: false } }
    expect(await resolveAgyCliPath(undefined, { ...fsDeps('win32', onlyHome), env })).toBe(
      'C:\\Users\\u\\.agy\\bin\\agy.exe',
    )
  })

  it('reads the Path value out of `reg query` and fills in its %VARIABLES%', () => {
    const output =
      '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\agy\\bin;C:\\tools\r\n\r\n'
    expect(parseRegistryPathOutput(output)).toBe('%USERPROFILE%\\agy\\bin;C:\\tools')
    expect(
      parseRegistryPathOutput('ERROR: The system was unable to find the specified registry key'),
    ).toBeUndefined()
    expect(
      expandWindowsVariables('%userprofile%\\agy;%NOPE%\\x', { USERPROFILE: 'C:\\Users\\u' }),
    ).toBe('C:\\Users\\u\\agy;%NOPE%\\x')
  })

  it.each(['darwin', 'linux'] as const)(
    'resolves %s: PATH, per-user and system locations in order',
    async (platform) => {
      const files = {
        '/home/u/.agy/bin/agy': { exec: true },
        '/opt/homebrew/bin/agy': { exec: true },
        '/bin/agy': { exec: true },
      }
      const base = fsDeps(platform, files)
      expect(await resolveAgyCliPath(undefined, { ...base, env: { PATH: '/usr/bin:/bin' } })).toBe(
        '/bin/agy',
      )
      expect(await resolveAgyCliPath(undefined, { ...base, env: { PATH: '/usr/bin' } })).toBe(
        '/home/u/.agy/bin/agy',
      )
      const brewOnly = fsDeps(platform, { '/opt/homebrew/bin/agy': { exec: true } })
      expect(await resolveAgyCliPath(undefined, brewOnly)).toBe('/opt/homebrew/bin/agy')
      expect(agyDefaultLocations(base)).toEqual([
        '/home/u/.local/bin/agy',
        '/home/u/.agy/bin/agy',
        '/usr/local/bin/agy',
        '/opt/homebrew/bin/agy',
      ])
    },
  )

  it('falls back to a fixed-command login shell lookup on POSIX, validating the answer', async () => {
    const lookup = vi.fn(async () => '/Users/u/custom/agy')
    const deps = fsDeps(
      'darwin',
      { '/Users/u/custom/agy': { exec: true } },
      {
        env: { SHELL: '/bin/zsh', PATH: '/usr/bin' },
        loginShellLookup: lookup,
      },
    )
    expect(await resolveAgyCliPath(undefined, deps)).toBe('/Users/u/custom/agy')
    expect(lookup).toHaveBeenCalledWith('/bin/zsh')
    // hostile SHELL values and answers are never trusted
    const hostile = vi.fn(async () => '/tmp/x')
    await expect(
      resolveAgyCliPath(
        undefined,
        fsDeps('darwin', {}, { env: { SHELL: '/bin/sh;id' }, loginShellLookup: hostile }),
      ),
    ).rejects.toThrow(/not found/)
    expect(hostile).not.toHaveBeenCalled()
    await expect(
      resolveAgyCliPath(
        undefined,
        fsDeps(
          'darwin',
          {},
          { env: { SHELL: '/bin/zsh' }, loginShellLookup: async () => '/not/there' },
        ),
      ),
    ).rejects.toThrow(/not found/)
    // win32 never consults a login shell
    const winLookup = vi.fn(async () => CLI)
    await expect(
      resolveAgyCliPath(
        undefined,
        fsDeps('win32', {}, { env: { SHELL: '/bin/sh' }, loginShellLookup: winLookup }),
      ),
    ).rejects.toThrow()
    expect(winLookup).not.toHaveBeenCalled()
  })

  it('describes auto-detect per platform without Windows paths on POSIX', () => {
    expect(agyAutoDetectHint('win32')).toContain('%LOCALAPPDATA%')
    for (const p of ['darwin', 'linux'] as const) {
      expect(agyAutoDetectHint(p)).not.toMatch(/LOCALAPPDATA|\.exe/)
      expect(agyAutoDetectHint(p)).toContain('/opt/homebrew/bin')
    }
  })

  it('treats codex and agy as keyless CLI providers', () => {
    expect(isCliProvider('agy')).toBe(true)
    expect(isCliProvider('codex')).toBe(true)
    expect(isCliProvider('openai')).toBe(false)
  })
})

describe('agy args and model list', () => {
  it('builds an args array with the prompt left to stdin and only the staging dir added', () => {
    const args = buildAgyArgs({
      model: 'gemini-3.7-flash-low',
      stagingDir: 'C:\\t\\s p',
      timeoutMs: 240_000,
    })
    expect(args).toEqual([
      '-p',
      '',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      'gemini-3.7-flash-low',
      '--sandbox',
      '--disable-slash-commands',
      '--print-timeout',
      '235s',
      '--add-dir',
      'C:\\t\\s p',
    ])
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(1)
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  it('rejects model ids that could be read as flags or carry metacharacters', () => {
    for (const bad of ['--sandbox', '-x', 'a b', 'm;calc', '', 'x'.repeat(101), 'a\nb']) {
      expect(() => buildAgyArgs({ model: bad, stagingDir: '/t', timeoutMs: 60_000 })).toThrow()
    }
  })

  it('wraps the prompt in one JSON line, whatever characters it holds', () => {
    const prompt = 'xin chào "quoted"\nline2 \\ \u0000'
    const line = buildAgyStdin(prompt)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.indexOf('\n')).toBe(line.length - 1)
    expect(JSON.parse(line)).toEqual({ event: 'user', message: { content: prompt } })
  })

  it('parses `agy models` output and ignores stderr progress noise', () => {
    const out =
      'Fetching available models...\r\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\r\n' +
      'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n\n' +
      'Warning: something went wrong\n' +
      'gemini-3.8-flash-high\tduplicate\n' +
      '--bad\tFlag-like id\n' +
      'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n'
    expect(parseAgyModels(out)).toEqual([
      'gemini-3.8-flash-high',
      'claude-sonnet-4-6',
      'gpt-oss-120b-medium',
    ])
    expect(parseAgyModels('Fetching available models...\n')).toEqual([])
  })
})

describe('listAgyModels', () => {
  const files = { [CLI]: { exec: false } }
  it('caches for a few minutes, can be forced, and reports failures as an error', async () => {
    clearAgyModelsCache()
    let now = 1_000
    const run = vi.fn(async () => 'gemini-3.8-flash-low\tG\nclaude-sonnet-4-6\tC\n')
    const deps = { ...fsDeps('win32', files), run, now: () => now }
    const first = await listAgyModels(CLI, deps)
    expect(first).toEqual({
      models: ['gemini-3.8-flash-low', 'claude-sonnet-4-6'],
      defaultModel: AGY_DEFAULT_MODEL,
    })
    await listAgyModels(CLI, deps)
    expect(run).toHaveBeenCalledTimes(1)
    now += 4 * 60_000
    await listAgyModels(CLI, deps)
    expect(run).toHaveBeenCalledTimes(2)
    await listAgyModels(CLI, deps, { force: true })
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('never throws: a missing binary, empty list or failing run yields an error string', async () => {
    clearAgyModelsCache()
    const deps = { ...fsDeps('win32', {}), run: vi.fn(), now: () => 0 }
    expect((await listAgyModels(CLI, deps)).error).toMatch(/not found/)
    const failing = {
      ...fsDeps('win32', files),
      run: async () => Promise.reject(new Error('boom')),
      now: () => 0,
    }
    expect(await listAgyModels(CLI, failing)).toEqual({
      models: [],
      defaultModel: '',
      error: 'boom',
    })
    const empty = {
      ...fsDeps('win32', files),
      run: async () => 'Fetching available models...\n',
      now: () => 0,
    }
    expect((await listAgyModels(CLI, empty)).error).toMatch(/no models/)
  })
})

describe('stream-json parsing (recorded fixtures)', () => {
  it('reports tool steps (what the agent opens) and thinking tokens for the thinking strip', () => {
    const tool = parseAgyStreamLine(
      JSON.stringify({
        event: 'step_update',
        step_update: {
          step_index: 2,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'view_file',
          tool_info: { name: 'view_file', parameters: { AbsolutePath: '/tmp/a/image-1.jpg' } },
        },
      }),
    )
    expect(tool).toMatchObject({
      kind: 'step',
      stepType: 'tool',
      toolName: 'view_file',
      toolTarget: '/tmp/a/image-1.jpg',
    })
    const thought = parseAgyStreamLine(
      JSON.stringify({
        event: 'step_update',
        step_update: {
          step_index: 1,
          state: 'DONE',
          step_type: 'agent_response',
          duration_seconds: 3.3,
          usage: { input_tokens: 13685, output_tokens: 645, thinking_tokens: 541 },
        },
      }),
    )
    expect(thought).toMatchObject({
      kind: 'step',
      stepType: 'agent_response',
      thinkingTokens: 541,
      durationSeconds: 3.3,
    })
  })

  it('parses init, step updates and the result with usage', () => {
    const events = FIXTURE_OK.map(parseAgyStreamLine)
    expect(events[0]).toEqual({
      kind: 'init',
      model: 'gemini-3.7-flash-low',
      conversationId: 'c1',
    })
    expect(events[1]).toEqual({ kind: 'step', stepType: 'user_input', state: 'DONE' })
    expect(events[2]).toEqual({
      kind: 'text',
      text: 'PONG\n1\n2\n3\n4\n5',
      stepIndex: 1,
      done: false,
    })
    expect(events[3]).toMatchObject({ kind: 'text', text: '\n', done: true })
    expect(events[4]).toMatchObject({
      kind: 'result',
      ok: true,
      response: 'PONG\n1\n2\n3\n4\n5\n',
      usage: { input_tokens: 14571, output_tokens: 302 },
    })
  })

  it('parses the error result and strips the echoed model list', () => {
    const event = parseAgyStreamLine(FIXTURE_BAD_MODEL)
    expect(event).toMatchObject({ kind: 'result', ok: false })
    const message = cleanAgyError((event as { error: string }).error)
    expect(message).toContain('model nope is not recognized')
    expect(message).not.toContain('Gemini 3.8 Flash')
  })

  it('ignores blanks, non-JSON noise and unknown events', () => {
    expect(parseAgyStreamLine('')).toBeNull()
    expect(parseAgyStreamLine('Fetching available models...')).toBeNull()
    expect(parseAgyStreamLine('{not json')).toBeNull()
    expect(parseAgyStreamLine('{"event":"mystery"}')).toBeNull()
    expect(parseAgyStreamLine('[1]')).toBeNull()
  })

  it('maps usage onto the shared token usage shape', () => {
    expect(
      agyUsageToTokenUsage({
        input_tokens: 10,
        output_tokens: 2,
        thinking_tokens: 1,
        cache_read_tokens: 0,
        total_tokens: 12,
      }),
    ).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 2,
      thoughtsTokenCount: 1,
      cachedContentTokenCount: 0,
      totalTokenCount: 12,
    })
  })
})

describe('prompt flattening', () => {
  const png = Buffer.from('fake png bytes').toString('base64')

  it('puts the host tool protocol after app instructions and repeats it after history', () => {
    const hostTools = [
      {
        name: 'replace_text',
        description: 'Replace text in the document',
        inputSchema: { type: 'object', properties: {} },
      },
    ]
    const { prompt } = buildAgyPrompt(
      'Use available tools to edit the open document.',
      [{ role: 'user', text: 'Replace the title.' }],
      hostTools,
    )
    const appInstructions = prompt.indexOf('Instructions from the application:')
    const hostProtocol = prompt.indexOf('Do not invoke Antigravity CLI tools')
    const conversation = prompt.indexOf('Conversation:')

    expect(appInstructions).toBeGreaterThanOrEqual(0)
    expect(hostProtocol).toBeGreaterThan(appInstructions)
    expect(conversation).toBeGreaterThan(hostProtocol)
    expect(prompt.trimEnd()).toMatch(
      /For document actions, output GenOffice <tool_call> blocks only; never invoke native Antigravity tools or request their approval\.$/,
    )
  })

  it('flattens history, names attachments and keeps the system note', () => {
    const messages: AgentMessage[] = [
      { role: 'user', text: 'Hello' },
      { role: 'assistant', text: 'Hi there' },
      { role: 'user', text: 'Đọc hóa đơn này', images: [{ base64: png, mime: 'image/png' }] },
    ]
    const plan = buildAgyPrompt('Be brief.', messages)
    expect(plan.files.map((f) => f.name)).toEqual(['image-1.png'])
    expect(plan.prompt).toContain('NOT available')
    expect(plan.prompt).toContain('Be brief.')
    expect(plan.prompt).toContain('User: Hello\n\nAssistant: Hi there\n\nUser: Đọc hóa đơn này')
    expect(plan.prompt).toContain('[attached image: image-1.png]')
    expect(plan.prompt.trimEnd().endsWith('last User message.')).toBe(true)
  })

  it('drops the oldest turns when over the cap but always keeps the newest', () => {
    const big = 'x'.repeat(150_000)
    const messages: AgentMessage[] = [
      { role: 'user', text: 'OLDEST' + big },
      { role: 'assistant', text: big },
      { role: 'user', text: big },
      { role: 'user', text: 'NEWEST question' },
    ]
    const { prompt } = buildAgyPrompt('', messages)
    expect(prompt.length).toBeLessThanOrEqual(400_000)
    expect(prompt).not.toContain('OLDEST')
    expect(prompt).toContain('NEWEST question')
    expect(prompt).toContain('earlier message(s) omitted')
  })

  it('stages only images within the count limit, newest first, and tells the model about skips', () => {
    const images = Array.from({ length: 14 }, () => ({ base64: png, mime: 'image/jpeg' }))
    const plan = buildAgyPrompt('', [{ role: 'user', text: 'many', images }])
    expect(plan.files).toHaveLength(12)
    expect(plan.files[0]!.name).toBe('image-1.jpg')
    expect(plan.prompt).toContain('not available')
  })

  it('refuses oversized files at run time', async () => {
    const child = new FakeChild()
    const { deps } = runDeps(child)
    await expect(
      runAgy(
        {
          cliPath: CLI,
          model: 'm',
          prompt: 'p',
          files: [{ name: '../evil.png', bytes: new Uint8Array(1) }],
        },
        deps,
      ),
    ).rejects.toThrow(/Invalid file name/)
    await expect(
      runAgy(
        {
          cliPath: CLI,
          model: 'm',
          prompt: 'p',
          files: [{ name: 'a.png', bytes: new Uint8Array(21 * 1024 * 1024) }],
        },
        deps,
      ),
    ).rejects.toThrow(/too large/)
  })
})

describe('runAgy', () => {
  it('streams deltas, reports usage, spawns without a shell and cleans the staging dir', async () => {
    const child = new FakeChild()
    const { deps, written, removed, spawned, dirs } = runDeps(child)
    const deltas: string[] = []
    const usage = vi.fn()
    const promise = runAgy(
      {
        cliPath: CLI,
        model: 'gemini-3.7-flash-low',
        prompt: 'the prompt',
        files: [{ name: 'image-1.png', bytes: new Uint8Array(5) }],
        onText: (t) => deltas.push(t),
        onUsage: usage,
      },
      deps,
    )
    await tick()
    await tick()
    child.emitLines(FIXTURE_OK)
    child.exit(0)
    const result = await promise
    expect(result.text).toBe('PONG\n1\n2\n3\n4\n5\n')
    expect(deltas.join('')).toBe(result.text)
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({ promptTokenCount: 14571 }))
    expect(spawned[0]!.command).toBe(CLI)
    expect(spawned[0]!.cwd).toBe(dirs[0])
    expect(spawned[0]!.args).toContain('--add-dir')
    expect(JSON.parse(child.stdinText)).toEqual({
      event: 'user',
      message: { content: 'the prompt' },
    })
    expect(written).toEqual([{ path: `${dirs[0]}\\image-1.png`, size: 5 }])
    expect(removed).toEqual(dirs)
  })

  it('handles lines split across chunks and falls back to the final response text', async () => {
    const child = new FakeChild()
    const { deps } = runDeps(child)
    const deltas: string[] = []
    const promise = runAgy(
      { cliPath: CLI, model: 'm', prompt: 'p', onText: (t) => deltas.push(t) },
      deps,
    )
    await tick()
    await tick()
    const line = FIXTURE_OK[4]!
    child.stdout.write(line.slice(0, 30))
    await tick()
    child.stdout.write(line.slice(30) + '\n')
    child.exit(0)
    expect((await promise).text).toBe('PONG\n1\n2\n3\n4\n5\n')
    expect(deltas.join('')).toBe('PONG\n1\n2\n3\n4\n5\n')
  })

  it('separates later agent_response steps with a blank line', async () => {
    const child = new FakeChild()
    const { deps } = runDeps(child)
    const promise = runAgy({ cliPath: CLI, model: 'm', prompt: 'p' }, deps)
    await tick()
    await tick()
    child.emitLines([
      '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Looking"}}',
      '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"view_file"}}',
      '{"event":"step_update","step_update":{"step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"Answer"}}',
      '{"event":"result","result":{"status":"SUCCESS","response":"Answer"}}',
    ])
    child.exit(0)
    expect((await promise).text).toBe('Looking\n\nAnswer')
  })

  it('surfaces agy errors (exit 1 with an ERROR result) without echoing stderr noise', async () => {
    const child = new FakeChild()
    const { deps, removed, dirs } = runDeps(child)
    const promise = runAgy({ cliPath: CLI, model: 'nope', prompt: 'secret prompt text' }, deps)
    promise.catch(() => undefined)
    await tick()
    await tick()
    child.stderr.write('Fetching available models...\n')
    child.emitLines([FIXTURE_BAD_MODEL])
    child.exit(1)
    await expect(promise).rejects.toThrow(/model nope is not recognized/)
    await expect(promise).rejects.not.toThrow(/secret prompt/)
    expect(removed).toEqual(dirs)
  })

  it('falls back to the last stderr line when no JSON result arrives', async () => {
    const child = new FakeChild()
    const { deps } = runDeps(child)
    const promise = runAgy({ cliPath: CLI, model: 'm', prompt: 'p' }, deps)
    promise.catch(() => undefined)
    await tick()
    await tick()
    child.stderr.write('not signed in\n')
    child.exit(2)
    await expect(promise).rejects.toThrow('not signed in')
  })

  it('kills the process tree on abort, rejects with AbortError and still deletes staging', async () => {
    const child = new FakeChild()
    const { deps, removed, dirs } = runDeps(child)
    const ctrl = new AbortController()
    const promise = runAgy({ cliPath: CLI, model: 'm', prompt: 'p', signal: ctrl.signal }, deps)
    promise.catch(() => undefined)
    await tick()
    await tick()
    ctrl.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(deps.killTree).toHaveBeenCalledTimes(1)
    expect(removed).toEqual(dirs)
  })

  it('does not start when already aborted', async () => {
    const child = new FakeChild()
    const { deps, spawned } = runDeps(child)
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      runAgy({ cliPath: CLI, model: 'm', prompt: 'p', signal: ctrl.signal }, deps),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(spawned).toHaveLength(0)
  })

  it('times out, kills the tree and rejects with AiTimeoutError', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      const { deps, removed, dirs } = runDeps(child)
      const promise = runAgy({ cliPath: CLI, model: 'm', prompt: 'p', timeoutMs: 20_000 }, deps)
      promise.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(20_001)
      await expect(promise).rejects.toMatchObject({ name: 'AiTimeoutError' })
      expect(deps.killTree).toHaveBeenCalledTimes(1)
      expect(removed).toEqual(dirs)
    } finally {
      vi.useRealTimers()
    }
  })

  it('heartbeats onActivity while the process is silent', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      const { deps } = runDeps(child)
      const onActivity = vi.fn()
      const promise = runAgy(
        { cliPath: CLI, model: 'm', prompt: 'p', onActivity, timeoutMs: 60_000 },
        deps,
      )
      promise.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(11_000)
      expect(onActivity.mock.calls.length).toBeGreaterThanOrEqual(2)
      child.emitLines(FIXTURE_OK)
      child.exit(0)
      await vi.advanceTimersByTimeAsync(10)
      await promise
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a spawn failure clearly', async () => {
    const child = new FakeChild()
    const { deps } = runDeps(child)
    const promise = runAgy({ cliPath: CLI, model: 'm', prompt: 'p' }, deps)
    promise.catch(() => undefined)
    await tick()
    await tick()
    child.emit('error', new Error('spawn EACCES'))
    await expect(promise).rejects.toThrow(/Could not start Antigravity CLI: spawn EACCES/)
  })

  it('limits concurrency to 2 and releases slots on abort of a queued request', async () => {
    const limiter = createAgyLimiter(2)
    const children = [new FakeChild(), new FakeChild(), new FakeChild()]
    let next = 0
    const { deps } = runDeps(children[0]!, { spawn: () => children[next++]!.asChild() })
    const run = (signal?: AbortSignal) =>
      runAgy({ cliPath: CLI, model: 'm', prompt: 'p', limiter, signal }, deps)
    const a = run()
    const b = run()
    const ctrl = new AbortController()
    const c = run(ctrl.signal)
    c.catch(() => undefined)
    await tick()
    await tick()
    await tick()
    expect(next).toBe(2)
    ctrl.abort()
    await expect(c).rejects.toMatchObject({ name: 'AbortError' })
    expect(next).toBe(2)
    const d = run()
    await tick()
    children[0]!.emitLines(FIXTURE_OK)
    children[0]!.exit(0)
    await a
    await tick()
    await tick()
    expect(next).toBe(3)
    children[1]!.emitLines(FIXTURE_OK)
    children[1]!.exit(0)
    children[2]!.emitLines(FIXTURE_OK)
    children[2]!.exit(0)
    await Promise.all([b, d])
  })
})

describe('provider entry points', () => {
  it('streamAgy sends tools and parses tool_call', async () => {
    const child = new FakeChild()
    const { deps } = runDeps(child)
    const deltas: string[] = []
    const onUsage = vi.fn()
    const onStopReason = vi.fn()
    const onToolCall = vi.fn()
    const promise = streamAgy(
      { apiKey: '', model: 'gemini-3.7-flash-low', cliPath: CLI },
      'sys',
      [{ role: 'user', text: 'hi' }],
      [{ name: 'edit', description: 'd', inputSchema: { type: 'object', properties: {} } }],
      1000,
      {
        onDelta: (t) => deltas.push(t),
        onToolCall,
        onUsage,
        onStopReason,
        signal: new AbortController().signal,
      },
      deps,
    )
    await tick()
    await tick()
    child.emitLines([
      JSON.stringify({
        event: 'step_update',
        step_update: {
          step_type: 'agent_response',
          text_delta: 'PONG\n<tool_call>{"name":"edit","arguments":{}}</tool_call>',
        },
      }),
      JSON.stringify({
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: 'PONG\n<tool_call>{"name":"edit","arguments":{}}</tool_call>',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ])
    child.exit(0)
    await promise
    expect(deltas.join('')).toBe('PONG')
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: 'edit', input: {} }),
    )
    expect(onUsage).toHaveBeenCalled()
    expect(onStopReason).toHaveBeenCalledWith('tool_use')
    expect(child.stdinText).toContain('edit')
    expect(child.stdinText).toContain('<tool_call>')
  })

  it('streamAgy rejects an empty answer', async () => {
    const empty = new FakeChild()
    const second = runDeps(empty)
    const p2 = streamAgy(
      { apiKey: '', model: '', cliPath: CLI },
      '',
      [{ role: 'user', text: 'x' }],
      [],
      1,
      {
        onDelta: vi.fn(),
        onToolCall: vi.fn(),
        signal: new AbortController().signal,
      },
      second.deps,
    )
    p2.catch(() => undefined)
    await tick()
    await tick()
    empty.emitLines(['{"event":"result","result":{"status":"SUCCESS","response":"  "}}'])
    empty.exit(0)
    await expect(p2).rejects.toThrow(/no content/)
  })

  it('chatAgy returns failures as a response, not a rejection', async () => {
    const child = new FakeChild()
    const { deps } = runDeps(child)
    const promise = chatAgy(
      { apiKey: '', model: 'm', cliPath: 'relative/agy.exe' },
      '',
      'ping',
      undefined,
      deps,
    )
    await expect(promise).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/absolute/),
    })
  })
})

describe('killProcessTree', () => {
  it('uses taskkill /T /F on win32 only', () => {
    const taskkill = vi.fn()
    const signalGroup = vi.fn()
    killProcessTree({ pid: 77, kill: vi.fn() }, 'win32', signalGroup, taskkill)
    expect(taskkill).toHaveBeenCalledWith(77)
    expect(signalGroup).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'linux'] as const)(
    'on %s signals the process group with SIGTERM then SIGKILL after the grace period',
    (platform) => {
      vi.useFakeTimers()
      try {
        const taskkill = vi.fn()
        const signalGroup = vi.fn()
        killProcessTree({ pid: 77, kill: vi.fn() }, platform, signalGroup, taskkill)
        expect(signalGroup).toHaveBeenCalledWith(-77, 'SIGTERM')
        expect(signalGroup).toHaveBeenCalledTimes(1)
        vi.advanceTimersByTime(AGY_KILL_GRACE_MS + 1)
        expect(signalGroup).toHaveBeenLastCalledWith(-77, 'SIGKILL')
        expect(taskkill).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('falls back to child.kill when the group signal fails and is a no-op without a pid', () => {
    const kill = vi.fn()
    killProcessTree({ pid: 5, kill }, 'linux', () => {
      throw new Error('ESRCH')
    })
    expect(kill).toHaveBeenCalledWith('SIGTERM')
    const noPid = vi.fn()
    killProcessTree({ pid: undefined, kill: noPid }, 'linux', vi.fn())
    expect(noPid).not.toHaveBeenCalled()
  })
})

describe('registry wiring', () => {
  it('exposes agy as a keyless CLI provider with vision and tools and routes models through the shared IPC', async () => {
    const { AI_PROVIDERS, defaultAiSettings } = await import('../src/providers')
    const { getProviderAdapter } = await import('../src/registry')
    const { listProviderModelsForIpc } = await import('../src/provider-models')
    const meta = AI_PROVIDERS.find((m) => m.id === 'agy')!
    expect(meta).toMatchObject({ label: 'Antigravity CLI', needsCliPath: true })
    const adapter = getProviderAdapter('agy')
    expect(adapter.capabilities).toMatchObject({ vision: true, tools: true, auth: 'agy-cli' })
    expect(adapter.resolveEndpoint({ apiKey: '', model: '' }).protocol).toBe('agy-cli')
    expect(defaultAiSettings().providers.agy).toMatchObject({ apiKey: '', cliPath: '' })
    // an invalid path is rejected before anything is spawned
    const reply = (await listProviderModelsForIpc({
      provider: 'agy',
      config: { cliPath: 'not/absolute/agy' },
    })) as { models: string[]; error?: string }
    expect(reply.models).toEqual([])
    expect(reply.error).toMatch(/absolute/)
  })
})
