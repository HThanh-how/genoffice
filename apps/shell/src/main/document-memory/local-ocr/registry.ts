/**
 * Tier-aware engine selection.
 *
 *   macOS    : Apple Vision accurate, then Tesseract as the fallback
 *   elsewhere: Tesseract
 *   (RapidOCR is a descriptor only and is never selected)
 *
 * RAM guard: an engine is never started when free RAM is below the figure measured for it
 * (Vision ~0.55 GB, Tesseract ~0.3 GB). When the preferred engine is refused for RAM the next
 * one in the chain gets its turn; when none fits the answer is `null` and the job waits.
 */
import { freemem, totalmem } from 'node:os'
import type { LocalOcrEngine, LocalOcrEngineDescriptor } from '../runtime/local-ocr-engine'
import { RAPIDOCR_DESCRIPTOR } from './rapidocr-descriptor'
import { AppleVisionEngine, VISION_ENGINE_ID } from './vision-engine'
import { TesseractEngine, TESSERACT_ENGINE_ID } from './tesseract-engine'

export type LocalOcrEnginePreference = 'auto' | typeof VISION_ENGINE_ID | typeof TESSERACT_ENGINE_ID

/** Descriptors of every engine, including the ones that cannot run (for diagnostics). */
export function listEngineDescriptors(): LocalOcrEngineDescriptor[] {
  return [
    new AppleVisionEngine({ helperPath: null }).descriptor,
    new TesseractEngine({ langPath: null }).descriptor,
    RAPIDOCR_DESCRIPTOR,
  ]
}

/** Engine ids in the order they are tried on this platform. */
export function engineChain(
  platform: NodeJS.Platform,
  preference: LocalOcrEnginePreference = 'auto',
): string[] {
  const natural = platform === 'darwin' ? [VISION_ENGINE_ID, TESSERACT_ENGINE_ID] : [TESSERACT_ENGINE_ID]
  if (preference === 'auto') return natural
  // an explicit choice goes first but the fallback stays behind it; Vision is macOS-only
  const chosen = preference === VISION_ENGINE_ID && platform !== 'darwin' ? [] : [preference]
  return [...chosen, ...natural.filter((id) => id !== preference)]
}

/**
 * RAM an engine could use right now, in MB. Electron's own figure counts reclaimable memory
 * (os.freemem() on macOS does not, and would refuse everything); a plain Node process on macOS
 * has neither, so it is estimated from total RAM.
 */
export function availableRamMB(): number {
  try {
    const info = (process as { getSystemMemoryInfo?: () => { free: number } }).getSystemMemoryInfo?.()
    if (info) return info.free / 1024 // kilobytes
  } catch {
    // fall through
  }
  const free = freemem() / (1024 * 1024)
  return process.platform === 'darwin' ? Math.max(free, (totalmem() / (1024 * 1024)) * 0.5) : free
}

export interface EngineSelection {
  engine: LocalOcrEngine
  /** engines passed over before this one, with why */
  skipped: Array<{ id: string; reason: 'unavailable' | 'low-ram' }>
}

export interface EngineRegistryOptions {
  platform?: NodeJS.Platform
  freeRamMB?: () => number
  /** replaces the real engines (tests) */
  factories?: Partial<Record<string, () => LocalOcrEngine>>
}

export class LocalOcrEngineRegistry {
  private readonly platform: NodeJS.Platform
  private readonly freeRamMB: () => number
  private readonly factories: Record<string, () => LocalOcrEngine>
  private readonly instances = new Map<string, LocalOcrEngine>()

  constructor(options: EngineRegistryOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.freeRamMB = options.freeRamMB ?? availableRamMB
    this.factories = {
      [VISION_ENGINE_ID]: () => new AppleVisionEngine(),
      [TESSERACT_ENGINE_ID]: () => new TesseractEngine(),
      ...options.factories,
    }
  }

  private get(id: string): LocalOcrEngine | null {
    let engine = this.instances.get(id)
    if (!engine) {
      const factory = this.factories[id]
      if (!factory) return null
      engine = factory()
      this.instances.set(id, engine)
    }
    return engine
  }

  /** The first engine of the chain that can run now; null when none can (no RAM, no resources). */
  select(preference: LocalOcrEnginePreference = 'auto'): EngineSelection | null {
    const skipped: EngineSelection['skipped'] = []
    const ram = this.freeRamMB()
    for (const id of engineChain(this.platform, preference)) {
      const engine = this.get(id)
      if (!engine) continue
      if (engine.isAvailable(this.platform, ram)) return { engine, skipped }
      // distinguish "would run if RAM allowed" from "cannot run here at all"
      skipped.push({
        id,
        reason: engine.isAvailable(this.platform, Number.POSITIVE_INFINITY) ? 'low-ram' : 'unavailable',
      })
    }
    return null
  }

  async disposeAll(): Promise<void> {
    const engines = [...this.instances.values()]
    this.instances.clear()
    await Promise.all(engines.map((engine) => engine.dispose().catch(() => undefined)))
  }
}
