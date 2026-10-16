/**
 * The main process' mail-merge write boundary.
 *
 * The renderer proposes a name; this module decides the name that actually lands
 * on disk. `skip` and `rename` open the file with `wx`, so the existence check
 * and the write are one operation: a file created by another process between the
 * renderer choosing a name and the writer using it cannot be clobbered. Only
 * `overwrite` may replace a file, and it keeps the temp+rename path used by the
 * rest of the app.
 */
import { existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '@genoffice/electron-utils/atomic-write'
import {
  resolveSafeFileName,
  uniqueSafeFileName,
  type MailMergeOverwritePolicy,
} from './mail-merge-names'

export interface WriteOutcome {
  /** the name actually written (or the name that was skipped) */
  name: string
  path: string
  skipped: boolean
}

export async function writeMailMergeOutput(
  dir: string,
  name: string,
  data: Buffer,
  policy: MailMergeOverwritePolicy,
  allocated?: Set<string>,
): Promise<WriteOutcome> {
  const decision = resolveSafeFileName(
    name,
    policy,
    (candidate) => existsSync(join(dir, candidate)),
    allocated,
  )
  if (!decision.name) return { name: '', path: '', skipped: true }
  if (policy === 'overwrite' && !allocated?.has(decision.name)) {
    const path = join(dir, decision.name)
    await atomicWriteFile(path, data)
    allocated?.add(decision.name)
    return { name: decision.name, path, skipped: false }
  }
  let candidate = decision.name
  for (let attempt = 0; attempt < 1000; attempt++) {
    const path = join(dir, candidate)
    try {
      // `wx` makes "does it exist?" and "write it" one operation, so a file
      // created by another process between the renderer's choice and this write
      // cannot be clobbered
      const handle = await open(path, 'wx')
      try {
        await handle.write(data)
      } finally {
        await handle.close()
      }
      allocated?.add(candidate)
      return { name: candidate, path, skipped: false }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (policy === 'skip' && !allocated?.has(candidate)) {
        return { name: candidate, path, skipped: true }
      }
      candidate = uniqueSafeFileName(candidate, (other) => existsSync(join(dir, other)))
    }
  }
  throw new Error(`no free file name for ${name}`)
}
