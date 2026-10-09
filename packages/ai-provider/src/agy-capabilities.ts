import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { helpMentionsFlag } from './agy-effort'

/**
 * Which optional flags the installed `agy` knows, read once from `agy --help` (no model call, no
 * quota, no login needed) and remembered per executable. Node-only. A failed probe answers
 * "unsupported" for this call but is not remembered, so a later call may succeed.
 */

export const AGY_HELP_TIMEOUT_MS = 10_000
const MAX_HELP_CHARS = 64_000

export interface AgyCapabilities {
  effort: boolean
  jsonSchema: boolean
}

export interface AgyCapabilityDeps {
  /** run `agy --help` and resolve with everything it printed; reject on spawn failure or timeout */
  help(cliPath: string): Promise<string>
}

const realDeps: AgyCapabilityDeps = {
  help: (cliPath) =>
    new Promise<string>((resolve, reject) => {
      let out = ''
      let settled = false
      const finish = (action: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        action()
      }
      const child = spawn(cliPath, ['--help'], {
        cwd: tmpdir(),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const timer = setTimeout(
        () =>
          finish(() => {
            child.kill()
            reject(new Error('Timed out reading agy --help'))
          }),
        AGY_HELP_TIMEOUT_MS,
      )
      const collect = (chunk: Buffer) => {
        if (out.length < MAX_HELP_CHARS) out += chunk.toString('utf8')
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      child.on('error', (error) => finish(() => reject(error)))
      child.on('close', () => finish(() => resolve(out)))
    }),
}

const cache = new Map<string, AgyCapabilities>()
const inflight = new Map<string, Promise<AgyCapabilities>>()

const NONE: AgyCapabilities = { effort: false, jsonSchema: false }

/** Test seam: forget every remembered answer. */
export function clearAgyCapabilitiesCache(): void {
  cache.clear()
  inflight.clear()
}

/** The flags `cliPath` supports. Never throws; concurrent callers share one `--help` run. */
export async function readAgyCapabilities(
  cliPath: string,
  deps: AgyCapabilityDeps = realDeps,
): Promise<AgyCapabilities> {
  const known = cache.get(cliPath)
  if (known) return known
  const pending = inflight.get(cliPath)
  if (pending) return pending
  const run = (async (): Promise<AgyCapabilities> => {
    try {
      const help = await deps.help(cliPath)
      // an empty answer is a failed probe, not "no flags"
      if (!help.trim()) return NONE
      const result: AgyCapabilities = {
        effort: helpMentionsFlag(help, '--effort'),
        jsonSchema: helpMentionsFlag(help, '--json-schema'),
      }
      cache.set(cliPath, result)
      return result
    } catch {
      return NONE
    } finally {
      inflight.delete(cliPath)
    }
  })()
  inflight.set(cliPath, run)
  return run
}
