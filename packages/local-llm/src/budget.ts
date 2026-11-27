import { LocalLlmError } from './protocol'

export function contextBudget(freeBytes: number, totalBytes: number, requested = 16384): number {
  const gib = 1024 ** 3
  if (freeBytes < 2.5 * gib || totalBytes < 4 * gib)
    throw new LocalLlmError(
      'INSUFFICIENT_RAM',
      'At least 2.5 GiB available RAM is required for the local model',
    )
  // The KV cache of this model is small (about 370 MB at 32768 tokens, measured), so the window is
  // limited by what is really free, not by a fraction of it: an agent prompt (instructions, tool
  // definitions, document context) is already past 4096 tokens, which made nearly every request fail.
  const ceiling = freeBytes >= 4 * gib ? 32768 : freeBytes >= 3 * gib ? 16384 : 8192
  return Math.max(2048, Math.min(ceiling, requested, 32768))
}
