import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentTarget, detectAgents } from '../src/agent-skills'
import { mcpConfigFile, mcpSnippet, readMcpEntry } from '../src/agent-mcp'
import { run, tempDir } from './helpers'

// The Antigravity CLI (`agy`) is a different tool from the Gemini CLI. Verified on agy 1.3.2 (macOS):
//  - `agy mcp add` writes ~/.gemini/config/mcp_config.json as { mcpServers: { <name>: { args, command,
//    disabled, env } } } and `agy mcp list` reads it back;
//  - `agy -p /skills` lists the skills in ~/.gemini/config/skills;
//  - the Gemini CLI keeps ~/.gemini/settings.json and ~/.gemini/skills, which this CLI still targets.

const LAUNCHER = resolve(__dirname, '..', 'bin', 'genoffice')
const LAUNCH = { command: LAUNCHER, args: ['mcp'] }

function fakeMachine(dirs: string[]) {
  const home = tempDir()
  for (const dir of dirs) mkdirSync(join(home, dir), { recursive: true })
  const userData = join(home, 'userData')
  mkdirSync(userData)
  return { home, env: { GENOFFICE_HOME: home, GENOFFICE_USER_DATA: userData } }
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf-8'))

describe('agy detection and paths', () => {
  it('is detected by ~/.gemini/config, not by ~/.gemini alone (that is the Gemini CLI)', () => {
    const geminiOnly = tempDir()
    mkdirSync(join(geminiOnly, '.gemini'))
    expect(detectAgents({}, geminiOnly).map((a) => a.id)).toEqual(['gemini'])
    const both = tempDir()
    mkdirSync(join(both, '.gemini', 'config'), { recursive: true })
    expect(detectAgents({}, both).map((a) => a.id)).toEqual(['gemini', 'agy'])
  })

  it('keeps skills and MCP servers in ~/.gemini/config while the gemini target stays put', () => {
    const h = tempDir()
    expect(agentTarget('agy', {}, h)).toMatchObject({
      label: 'Antigravity CLI',
      skillsDir: join(h, '.gemini', 'config', 'skills'),
    })
    expect(agentTarget('gemini', {}, h)!.skillsDir).toBe(join(h, '.gemini', 'skills'))
    expect(mcpConfigFile('agy', { env: {}, home: h })).toBe(
      join(h, '.gemini', 'config', 'mcp_config.json'),
    )
    expect(mcpConfigFile('gemini', { env: {}, home: h })).toBe(join(h, '.gemini', 'settings.json'))
  })

  it('writes the documented stdio shape: command, args and env under mcpServers', () => {
    expect(
      JSON.parse(mcpSnippet('agy', { ...LAUNCH, env: { ELECTRON_RUN_AS_NODE: '1' } })),
    ).toEqual({
      mcpServers: {
        genoffice: { command: LAUNCHER, args: ['mcp'], env: { ELECTRON_RUN_AS_NODE: '1' } },
      },
    })
  })
})

describe('genoffice mcp with agy', () => {
  it("installs into mcp_config.json, keeping the user's other servers, and is idempotent", async () => {
    const m = fakeMachine(['.gemini/config'])
    const file = join(m.home, '.gemini', 'config', 'mcp_config.json')
    // what `agy mcp add` itself wrote for another server
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { webby: { disabled: false, serverUrl: 'https://example.com/mcp' } },
      }),
    )
    const first = await run(['mcp', 'install', 'agy', '--json'], { env: m.env })
    expect(first.code).toBe(0)
    expect(first.json().detail.agents[0]).toMatchObject({
      agent: 'agy',
      status: 'installed',
      registered: true,
      config: file,
    })
    const doc = readJson(file)
    expect(doc.mcpServers.webby).toEqual({ disabled: false, serverUrl: 'https://example.com/mcp' })
    expect(doc.mcpServers.genoffice).toEqual({ command: LAUNCHER, args: ['mcp'] })
    const again = await run(['mcp', 'install', 'agy', '--json'], { env: m.env })
    expect(again.json().detail.agents[0]).toMatchObject({ status: 'unchanged' })
  })

  it('reads an entry written by `agy mcp add` (with disabled) as registered, and keeps a disabled toggle', async () => {
    const m = fakeMachine(['.gemini/config'])
    const file = join(m.home, '.gemini', 'config', 'mcp_config.json')
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          genoffice: { args: ['mcp'], command: LAUNCHER, disabled: false },
        },
      }),
    )
    expect(readMcpEntry('agy', file, LAUNCH)).toEqual({ status: 'registered', command: LAUNCHER })
    // the user turns it off with `agy mcp disable genoffice`; an update must not switch it back on
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          genoffice: { args: ['mcp'], command: '/old/path/genoffice', disabled: true },
        },
      }),
    )
    expect(readMcpEntry('agy', file, LAUNCH).status).toBe('stale')
    const r = await run(['mcp', 'install', 'agy', '--json'], { env: m.env })
    expect(r.code).toBe(0)
    expect(readJson(file).mcpServers.genoffice).toEqual({
      command: LAUNCHER,
      args: ['mcp'],
      disabled: true,
    })
  })

  it('does not replace a different program named genoffice, and uninstall removes only ours', async () => {
    const m = fakeMachine(['.gemini/config'])
    const file = join(m.home, '.gemini', 'config', 'mcp_config.json')
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { genoffice: { command: 'npx', args: ['other'] } } }),
    )
    const blocked = await run(['mcp', 'install', 'agy', '--json'], { env: m.env })
    expect(blocked.code).toBe(2)
    expect(blocked.json()).toMatchObject({
      error: 'output_exists',
      detail: { agent: 'agy', status: 'occupied', command: 'npx' },
    })
    expect(readJson(file).mcpServers.genoffice.command).toBe('npx')
    await run(['mcp', 'install', 'agy', '--force', '--json'], { env: m.env })
    const gone = await run(['mcp', 'uninstall', 'agy', '--json'], { env: m.env })
    expect(gone.code).toBe(0)
    expect(readJson(file).mcpServers).toEqual({})
  })

  it('lists agy next to gemini and leaves the Gemini CLI settings alone', async () => {
    const m = fakeMachine(['.gemini', '.gemini/config'])
    const geminiFile = join(m.home, '.gemini', 'settings.json')
    writeFileSync(geminiFile, JSON.stringify({ theme: 'dark' }))
    const listed = await run(['mcp', 'list', '--json'], { env: m.env })
    const agents = listed.json().detail.agents as Array<Record<string, unknown>>
    expect(agents.find((a) => a.agent === 'agy')).toMatchObject({
      detected: true,
      registered: false,
      status: 'absent',
      config: join(m.home, '.gemini', 'config', 'mcp_config.json'),
    })
    expect(agents.find((a) => a.agent === 'gemini')).toMatchObject({ detected: true })
    const r = await run(['mcp', 'install', 'agy', '--json'], { env: m.env })
    expect(r.code).toBe(0)
    expect(readJson(geminiFile)).toEqual({ theme: 'dark' })
  })

  it('install all registers agy only when ~/.gemini/config exists', async () => {
    const geminiOnly = fakeMachine(['.gemini'])
    const a = await run(['mcp', 'install', 'all', '--json'], { env: geminiOnly.env })
    const rows = a.json().detail.agents as Array<Record<string, unknown>>
    expect(rows.find((x) => x.agent === 'agy')).toMatchObject({ status: 'not_detected' })
    expect(rows.find((x) => x.agent === 'gemini')).toMatchObject({ status: 'installed' })
    expect(existsSync(join(geminiOnly.home, '.gemini', 'config'))).toBe(false)
  })
})

describe('genoffice skill with agy', () => {
  it('installs into ~/.gemini/config/skills and reports it apart from the Gemini CLI', async () => {
    const m = fakeMachine(['.gemini', '.gemini/config'])
    const listed = await run(['skill', 'list', '--json'], { env: m.env })
    const agents = listed.json().detail.agents as Array<Record<string, unknown>>
    expect(agents.find((a) => a.agent === 'agy')).toMatchObject({
      detected: true,
      status: 'missing',
      skills_dir: join(m.home, '.gemini', 'config', 'skills'),
    })
    expect(agents.find((a) => a.agent === 'gemini')).toMatchObject({
      skills_dir: join(m.home, '.gemini', 'skills'),
    })
    const r = await run(['skill', 'install', 'agy', '--json'], { env: m.env })
    expect(r.code).toBe(0)
    const skill = join(m.home, '.gemini', 'config', 'skills', 'genoffice', 'SKILL.md')
    expect(existsSync(skill)).toBe(true)
    expect(readFileSync(skill, 'utf-8')).toMatch(/^---\r?\nname: genoffice\r?\n/)
    expect(existsSync(join(m.home, '.gemini', 'skills'))).toBe(false)
  })
})
