import { LocalLlmError } from './protocol'

export function contextBudget(freeBytes: number, totalBytes: number, requested = 16384): number {
  const gib = 1024 ** 3
  if (freeBytes < 2.5 * gib || totalBytes < 4 * gib)
    throw new LocalLlmError(
      'INSUFFICIENT_RAM',
      'At least 2.5 GiB available RAM is required for the local model',
    )
  const ceiling =
    freeBytes >= 8 * gib && totalBytes >= 24 * gib
      ? 32768
      : freeBytes >= 6 * gib
        ? 16384
        : freeBytes >= 4 * gib
          ? 8192
          : 4096
  return Math.max(2048, Math.min(ceiling, requested, 32768))
}
