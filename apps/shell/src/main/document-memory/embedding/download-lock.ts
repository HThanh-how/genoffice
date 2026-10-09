import { readFile, rm, stat, writeFile } from 'node:fs/promises'

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * One writer per partial download. A recycled worker can overlap its dying predecessor for a few
 * seconds, and two writers appending to the same `.part` would corrupt it. The lock names its
 * owner's pid, so a lock left by a killed process is taken over immediately.
 * Returns the release function, or null when another live process still holds the lock after `waitMs`.
 */
export async function acquireDownloadLock(
  lockPath: string,
  waitMs = 15_000,
): Promise<(() => Promise<void>) | null> {
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: 'wx' })
      return () => rm(lockPath, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const text = await readFile(lockPath, 'utf8').catch(() => null)
    if (text === null) continue // released between the two calls
    const owner = Number(text)
    // an empty file is a writer between create and write; only a stale one is garbage
    const garbage = !Number.isInteger(owner) || owner <= 0
    const stale = garbage
      ? Date.now() - ((await stat(lockPath).catch(() => null))?.mtimeMs ?? 0) > 5_000
      : owner !== process.pid && !processAlive(owner)
    if (stale) {
      await rm(lockPath, { force: true })
      continue
    }
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
