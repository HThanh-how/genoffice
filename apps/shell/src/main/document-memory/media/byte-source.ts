import { open } from 'node:fs/promises'
import type { ByteSource } from './media-types'

/** The first window of a file that header parsers share (the bounded read the design promises). */
export const HEAD_BYTES = 64 * 1024
/** A parser may issue at most this many reads that miss the head window. */
const MAX_EXTRA_READS = 48
const MAX_READ_BYTES = 64 * 1024

const EMPTY = Buffer.alloc(0)

/** In-memory source (tests, and the head window itself). */
export function bufferSource(buffer: Buffer, size = buffer.length): ByteSource {
  return {
    size,
    async read(offset, length) {
      if (!Number.isFinite(offset) || offset < 0 || length <= 0 || offset >= buffer.length) return EMPTY
      return buffer.subarray(offset, Math.min(buffer.length, offset + Math.min(length, MAX_READ_BYTES)))
    },
  }
}

/**
 * Run `fn` over a read-only handle of `path`. Never throws: an unreadable file, a hung share
 * (`timeoutMs`) or a parser bug all yield `null`. The file is never read beyond the head window plus
 * `MAX_EXTRA_READS` small positioned reads, and never mapped or decoded.
 */
export async function withFileSource<T>(
  path: string,
  fn: (source: ByteSource) => Promise<T>,
  timeoutMs = 4_000,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = (async (): Promise<T | null> => {
    const handle = await open(path, 'r')
    try {
      const { size } = await handle.stat()
      const head = Buffer.allocUnsafe(Math.min(HEAD_BYTES, size))
      const { bytesRead } = head.length ? await handle.read(head, 0, head.length, 0) : { bytesRead: 0 }
      const window = head.subarray(0, bytesRead)
      let extra = 0
      return await fn({
        size,
        async read(offset, length) {
          if (!Number.isFinite(offset) || offset < 0 || length <= 0 || offset >= size) return EMPTY
          const want = Math.min(length, MAX_READ_BYTES, size - offset)
          if (offset + want <= window.length) return window.subarray(offset, offset + want)
          if (++extra > MAX_EXTRA_READS) return EMPTY
          const out = Buffer.allocUnsafe(want)
          const got = await handle.read(out, 0, want, offset)
          return out.subarray(0, got.bytesRead)
        },
      })
    } finally {
      // Runs when the read finishes, even after the deadline below already gave up on it.
      await handle.close().catch(() => undefined)
    }
  })().catch(() => null)
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}
