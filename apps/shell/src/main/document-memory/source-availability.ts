import { stat } from 'node:fs/promises'

/** Bound UI waits and reuse an outstanding OS lookup instead of flooding a disconnected share. */
export function createSourceAvailabilityProbe(
  lookup = async (path: string) =>
    stat(path).then(
      (value) => value.isDirectory(),
      () => false,
    ),
  timeoutMs = 1500,
  cacheMs = 10_000,
) {
  const entries = new Map<
    string,
    { pending?: Promise<boolean>; unavailable?: boolean; checkedAt: number }
  >()
  return async (path: string): Promise<boolean> => {
    let entry = entries.get(path)
    if (entry?.unavailable !== undefined && Date.now() - entry.checkedAt < cacheMs)
      return entry.unavailable
    if (!entry) {
      entry = { checkedAt: 0 }
      entries.set(path, entry)
    }
    const current = entry
    if (!current.pending)
      current.pending = Promise.resolve()
        .then(() => lookup(path))
        .then(
          (available) => !available,
          () => true,
        )
        .then((unavailable) => {
          current.unavailable = unavailable
          current.checkedAt = Date.now()
          current.pending = undefined
          return unavailable
        })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        current.pending,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => {
            current.unavailable = true
            current.checkedAt = Date.now()
            resolve(true)
          }, timeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}
