import { listAgyModels, type AgyModelCatalog } from './agy-cli'
import {
  agyChatDefaultKey,
  agyActiveCliKey,
  agyCliCheckedAt,
  agyCliUsable,
  agyDefaultsUsable,
  agyUsabilityCheckedAt,
  agyUsabilityKnown,
  recordAgyChatDefault,
  recordAgyCliUsable,
  setAgyActiveCli,
} from './agy-default'
/**
 * Async detection behind the agy-first defaults. "Usable" means the same thing the settings UI
 * means by a connected Antigravity CLI: `agy` is found and `agy models` answers with a model
 * list (i.e. it is signed in). Node-only; the answer is kept in agy-default.ts.
 */

/** An answer younger than this is served as is; older ones are refreshed in the background. */
export const AGY_USABLE_FRESH_MS = 3 * 60_000
/** How long a settings read waits for the very first probe before using the fallback defaults. */
export const AGY_USABLE_FIRST_WAIT_MS = 3_000

export interface AgyDetectDeps {
  list(cliPath: string | undefined): Promise<Pick<AgyModelCatalog, 'models' | 'error'>>
  now(): number
}

const realDeps: AgyDetectDeps = {
  list: (cliPath) => listAgyModels(cliPath),
  now: () => Date.now(),
}

/** One probe per configured CLI path, so switching paths never joins an unrelated in-flight run. */
const inflight = new Map<string, Promise<boolean>>()

/** Run (or join) one probe for a CLI path and record its answer. Never throws. */
export function probeAgyUsable(cliPath?: string, deps: AgyDetectDeps = realDeps): Promise<boolean> {
  const key = agyChatDefaultKey(cliPath)
  const path = cliPath?.trim() || undefined
  // The CLI this request is about is the configured one, even when a probe for it is already
  // running: joining an in-flight probe must not leave the active identity on an older path.
  setAgyActiveCli(path)
  const running = inflight.get(key)
  if (running) return running
  const run = (async () => {
    let ok: boolean
    try {
      const catalog = await deps.list(path)
      ok = !catalog.error && catalog.models.length > 0
      // remember which chat model this executable really has, keyed by the configured path, so a
      // first run never starts on a model another CLI (or a removed one) reported
      recordAgyChatDefault(path, catalog, deps.now())
    } catch {
      ok = false
      recordAgyChatDefault(path, { models: [], error: 'probe failed' }, deps.now())
    }
    recordAgyCliUsable(path, ok, deps.now())
    return ok
  })().finally(() => {
    if (inflight.get(key) === run) inflight.delete(key)
  })
  inflight.set(key, run)
  return run
}

/**
 * The answer a settings read should use. Known and fresh: returned at once. Known but stale:
 * returned at once while a refresh runs behind it. Unknown: waits for the first probe, but only
 * up to `waitMs`, then answers false (today's fallback defaults) and lets the probe finish.
 */
export async function agyUsableForDefaults(
  cliPath?: string,
  deps: AgyDetectDeps = realDeps,
  waitMs: number = AGY_USABLE_FIRST_WAIT_MS,
): Promise<boolean> {
  // The answer must belong to the CLI that is configured now: a fresh answer for another
  // executable is never served as this one's verified usability. `agyActiveCliKey() === null`
  // alone is not enough - that global was learned from whichever executable was probed first.
  if (
    agyUsabilityKnown() &&
    (agyActiveCliKey() === agyChatDefaultKey(cliPath) ||
      (agyActiveCliKey() === null && agyChatDefaultKey(cliPath) === ''))
  ) {
    if (deps.now() - agyUsabilityCheckedAt() > AGY_USABLE_FRESH_MS)
      void probeAgyUsable(cliPath, deps)
    return agyDefaultsUsable()
  }
  const knownForPath = agyCliUsable(cliPath)
  if (knownForPath !== null) {
    if (deps.now() - agyCliCheckedAt(cliPath) > AGY_USABLE_FRESH_MS)
      void probeAgyUsable(cliPath, deps)
    return knownForPath
  }
  const probe = probeAgyUsable(cliPath, deps)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), waitMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([probe, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
