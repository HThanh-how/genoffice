import { createRequire } from 'node:module'

/**
 * Oldest onnxruntime-node that can load the int8 community exports of EmbeddingGemma-2 and
 * Harrier (they use com.microsoft::GatherBlockQuantized with the `bits` attribute). Verified
 * with the real files: 1.21.0 and 1.22.0 refuse to load them ("Unrecognized attribute: bits
 * for operator GatherBlockQuantized"), 1.23.2 and 1.30.0 load them and match the Python
 * reference (parity test). The Bekko exports (and the legacy profiles) load on 1.21.0.
 */
export const ORT_WITH_GATHER_BLOCK_QUANTIZED_BITS = '1.23.0'

let cachedVersion: string | null | undefined

/** Test seam: pretend another onnxruntime-node version is bundled (null = unknown, undefined = detect). */
export function overrideInstalledOrtVersion(version: string | null | undefined): void {
  cachedVersion = version
}

/**
 * Version of the bundled onnxruntime-node, read from its package.json so that the main process
 * never loads the native module just to answer this. undefined when it cannot be determined
 * (callers then assume the model is loadable and let the real load report the problem).
 */
export function installedOrtVersion(): string | undefined {
  if (cachedVersion === undefined) {
    try {
      const pkg = createRequire(import.meta.url)('onnxruntime-node/package.json') as { version?: string }
      cachedVersion = pkg.version ?? null
    } catch {
      cachedVersion = null
    }
  }
  return cachedVersion ?? undefined
}

/** Numeric `major.minor.patch` comparison; any non-numeric suffix (-dev.x) is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/**
 * True when the model can be loaded. `installed` omitted = detect the bundled version;
 * null = unknown, which counts as supported (the real load then reports any problem).
 */
export function ortSupports(minVersion: string | undefined, installed?: string | null): boolean {
  const version = installed === undefined ? installedOrtVersion() : installed
  return !minVersion || !version || compareVersions(version, minVersion) >= 0
}

export function ortTooOldMessage(
  profileId: string,
  minVersion: string,
  installed: string | undefined = installedOrtVersion(),
): string {
  return (
    `The '${profileId}' search model needs ONNX Runtime ${minVersion} or newer but this build ships ${installed ?? 'an older version'}. ` +
    `Update GenOffice or choose the Base or Balanced search model. Text search keeps working.`
  )
}
