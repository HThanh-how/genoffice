import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { killProcessTree, resolveAgyCliPath } from './agy-cli'
import { parseAgyUsageJson, type AgyUsageReading } from './agy-ocr'

/**
 * Reads the Antigravity quota (`agy -p "/usage"`): a built-in slash command that costs no model
 * tokens and answers in a few seconds. Node-only (spawns the CLI); the pure parser and the
 * threshold logic live in agy-ocr.ts, which the renderer may import.
 *
 * Every failure (CLI missing, timeout, unrecognisable output) is reported as `null`, and the
 * caller treats null as "do not run". If a future CLI stopped understanding `/usage` it would
 * send the text to the model and spend tokens; an answer that carries no usage table but did
 * consume tokens therefore switches this reader off for the rest of the session.
 */

export const AGY_USAGE_ARGS = [
  '-p',
  '/usage',
  '--output-format',
  'json',
  '--sandbox',
  '--print-timeout',
  '60s',
] as const
export const AGY_USAGE_TIMEOUT_MS = 45_000
const MAX_OUTPUT_CHARS = 512_000

export interface AgyUsageDeps {
  resolveCli(cliPath: string | undefined): Promise<string>
  /** run `agy <args>` and resolve with stdout; reject on spawn failure, non-zero exit or timeout */
  run(cliPath: string, args: readonly string[], timeoutMs: number): Promise<string>
  now(): number
}

const realDeps: AgyUsageDeps = {
  resolveCli: (cliPath) => resolveAgyCliPath(cliPath),
  now: () => Date.now(),
  run: (cliPath, args, timeoutMs) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(cliPath, [...args], {
        cwd: tmpdir(),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
      let out = ''
      let settled = false
      const finish = (action: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        action()
      }
      const timer = setTimeout(
        () =>
          finish(() => {
            killProcessTree(child)
            reject(new Error('Timed out reading Antigravity usage'))
          }),
        timeoutMs,
      )
      // Not signed in: the CLI prints this and then waits for a browser login, which never
      // comes from here. Stop at once instead of spinning until the timeout.
      const watchLogin = (chunk: Buffer) => {
        if (!/Authentication required/i.test(chunk.toString('utf8'))) return
        needsLogin = true
        finish(() => {
          killProcessTree(child)
          reject(new Error('Antigravity is not signed in'))
        })
      }
      child.stdout.on('data', (chunk: Buffer) => {
        watchLogin(chunk)
        if (out.length < MAX_OUTPUT_CHARS) out += chunk.toString('utf8')
      })
      child.stderr.on('data', watchLogin)
      child.on('error', (error) => finish(() => reject(error)))
      child.on('close', (code) =>
        finish(() =>
          code === 0 ? resolve(out) : reject(new Error(`agy exited with code ${code ?? '?'}`)),
        ),
      )
    }),
}

let unsupported = false
let needsLogin = false
let cliMissing = false

/** True when the last usage read stopped because the CLI is not signed in. */
export function agyUsageNeedsLogin(): boolean {
  return needsLogin
}

/** True when the last usage read stopped because there is no `agy` on this computer. */
export function agyUsageCliMissing(): boolean {
  return cliMissing
}

/** Test seam: forget that `/usage` was found unsupported. */
export function resetAgyUsageSupport(): void {
  unsupported = false
}

/** The JSON object in the CLI's stdout (progress noise may surround it). */
function extractJson(output: string): unknown {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(output.slice(start, end + 1))
  } catch {
    return null
  }
}

/** Current quota, or null when it cannot be read. Never throws. */
export async function readAgyUsage(
  cliPath?: string,
  deps: AgyUsageDeps = realDeps,
): Promise<AgyUsageReading | null> {
  if (unsupported) return null
  needsLogin = false
  cliMissing = false
  try {
    let cli: string
    try {
      cli = await deps.resolveCli(cliPath)
    } catch (error) {
      cliMissing = /Antigravity CLI \(agy\) was not found|Antigravity CLI not found/i.test(
        error instanceof Error ? error.message : '',
      )
      return null
    }
    const output = await deps.run(cli, AGY_USAGE_ARGS, AGY_USAGE_TIMEOUT_MS)
    const json = extractJson(output)
    const reading = parseAgyUsageJson(json, deps.now())
    if (reading) return reading
    const usage = (json as { usage?: { total_tokens?: unknown } } | null)?.usage
    if (typeof usage?.total_tokens === 'number' && usage.total_tokens > 0) unsupported = true
    return null
  } catch {
    return null
  }
}
