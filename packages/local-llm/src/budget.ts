import { LocalLlmError } from './protocol'

export function contextBudget(freeBytes: number, totalBytes: number, requested = 16384): number {
  const gib = 1024 ** 3
  if (freeBytes < 2.5 * gib || totalBytes < 4 * gib)
    throw new LocalLlmError(
      'INSUFFICIENT_RAM',
      'At least 2.5 GiB available RAM is required for the local model',
    )
  // The window follows the machine's RAM, not the memory that happens to be free this second: the
  // KV cache of this model is small (about 370 MB at 32768 tokens, measured), and "free" swings with
  // whatever else is open. Free memory only decides whether the model can start at all (above).
  // An agent prompt is already past 4096 tokens, so no machine gets less than 8192.
  const ceiling = totalBytes >= 16 * gib ? 32768 : totalBytes >= 8 * gib ? 16384 : 8192
  return Math.max(2048, Math.min(ceiling, requested, 32768))
}
