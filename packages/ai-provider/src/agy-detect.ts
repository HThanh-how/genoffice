import { listAgyModels, type AgyModelCatalog } from './agy-cli'
import {
  agyDefaultsUsable,
  agyUsabilityCheckedAt,
  agyUsabilityKnown,
  setAgyUsable,
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

let inflight: Promise<boolean> | null = null

/** Run (or join) one probe and record its answer. Never throws. */
export function probeAgyUsable(cliPath?: string, deps: AgyDetectDeps = realDeps): Promise<boolean> {
  if (inflight) return inflight
  const run = (async () => {
    let ok: boolean
    try {
      const catalog = await deps.list(cliPath?.trim() || undefined)
      ok = !catalog.error && catalog.models.length > 0
    } catch {
      ok = false
    }
    setAgyUsable(ok, deps.now())
    return ok
  })().finally(() => {
    inflight = null
  })
  inflight = run
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
  if (agyUsabilityKnown()) {
    if (deps.now() - agyUsabilityCheckedAt() > AGY_USABLE_FRESH_MS)
      void probeAgyUsable(cliPath, deps)
    return agyDefaultsUsable()
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
