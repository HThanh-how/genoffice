import { rootAvailability } from './root-availability'

export type OcrSourceCode = 'missing' | 'offline' | 'source-busy' | 'source-permission'

/** Source I/O must be classified before either reader spends an attempt. */
export async function classifyOcrSourceError(
  path: string,
  error: unknown,
  probe: (root: string) => Promise<boolean> = (root) => rootAvailability.checkAfterError(root),
  sourceRoot = rootAvailability.rootOf(path),
): Promise<{ code: OcrSourceCode; detail: string }> {
  const detail = String((error as NodeJS.ErrnoException | null)?.code ?? 'UNKNOWN')
  // Permission denied is never evidence of an unplugged drive.
  if (detail === 'EACCES' || detail === 'EPERM') return { code: 'source-permission', detail }
  if (!(await probe(sourceRoot))) return { code: 'offline', detail }
  if (detail === 'ENOENT' || detail === 'ENOTDIR') return { code: 'missing', detail }
  return { code: 'source-busy', detail }
}

/** Seconds, using ledger updated_at; unlimited retries, capped at one day apart. */
export function sourceRetrySeconds(attempts: number): number {
  return Math.min(24, 2 ** Math.min(5, Math.max(0, attempts - 1))) * 3600
}
