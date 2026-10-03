import type {
  IndexingMode,
  IndexingPauseReason,
  IndexingTier,
} from '../../shared/fork/indexing-mode'

/**
 * Pure policy for the background document-index job. The user and the UI always come first:
 * the job never takes more than half the logical cores, backs off at once when the user is
 * active, and only ramps up after the machine has been idle (and on AC power) for a while.
 */

export interface PolicyInput {
  mode: IndexingMode
  onBattery: boolean
  /** 0..100; undefined on desktops or when it could not be read */
  batteryPercent?: number
  batterySaver?: boolean
  userIdleSeconds: number
  cores: number
  freeMemMB: number
  locked: boolean
  /** the machine is going to sleep: nothing runs, whatever the charge */
  suspended?: boolean
  thermalCritical?: boolean
  pauseOnBattery: boolean
  /** the user switched indexing off */
  userPaused?: boolean
}

export interface ResolvedPolicy {
  paused: boolean
  pauseReason?: IndexingPauseReason
  threads: number
  /** duty cycle 0..1; 1 means uncapped */
  cpuShare: number
  priority: 'idle' | 'below-normal'
  tier: IndexingTier
  reason: string
  /** on battery: 3 = 80% or more, 2 = 50-79% (or unknown), 1 = below 50%; the work shrinks with it */
  batteryBand?: BatteryBand
}

export type BatteryBand = 1 | 2 | 3

export const IDLE_AFTER_SECONDS = 120
export const IDLE_STABLE_MS = 10_000
export const LOW_BATTERY_PERCENT = 30
export const LOW_BATTERY_RESUME_PERCENT = 35
export const LOW_MEMORY_MB = 1500
export const LOW_MEMORY_RESUME_MB = 2000

const LIGHT_SHARE = 0.3
/**
 * On battery the work shrinks with the charge instead of being all or nothing: more than 80% is
 * still a modest share of one core, half a charge about a third, and below 50% a trickle, until
 * LOW_BATTERY_PERCENT pauses it.
 */
const BATTERY_SHARES: Record<BatteryBand, number> = { 3: 0.4, 2: 0.3, 1: 0.15 }
/**
 * With battery saver on (some people leave it on all the time) the work is a trickle, and only
 * while the charge is half or more: a request to save power is honoured, not turned into "never".
 */
const SAVER_SHARE = 0.1
/** "light" mode takes a fifth less than the others at every level */
const LIGHT_FACTOR = 0.8
export const OCR_MIN_BATTERY_BAND: BatteryBand = 2

export function batteryBand(percent: number | undefined): BatteryBand {
  if (typeof percent !== 'number') return 2
  return percent >= 80 ? 3 : percent >= 50 ? 2 : 1
}
const BALANCED_ACTIVE_SHARE = 0.5
const FAST_ACTIVE_SHARE = 0.6

function paused(reason: IndexingPauseReason, why: string): ResolvedPolicy {
  return {
    paused: true,
    pauseReason: reason,
    threads: 1,
    cpuShare: 0,
    priority: 'idle',
    tier: 'paused',
    reason: why,
  }
}

export function resolvePolicy(input: PolicyInput): ResolvedPolicy {
  const cores = Number.isFinite(input.cores) ? Math.floor(input.cores) : 1
  // The UI keeps at least half of the cores free.
  const cap = Math.max(1, Math.floor(cores / 2))
  const threads = (wanted: number) => Math.max(1, Math.min(wanted, cap))
  const percent = input.batteryPercent

  if (input.userPaused) return paused('user', 'paused by the user')
  if (input.thermalCritical) return paused('thermal', 'thermal state is critical')
  if (input.freeMemMB < LOW_MEMORY_MB) return paused('low-memory', 'free memory is low')
  if (input.onBattery && input.pauseOnBattery) {
    if (
      input.batterySaver &&
      !(typeof percent === 'number' && batteryBand(percent) >= OCR_MIN_BATTERY_BAND)
    )
      return paused('battery-saver', 'battery saver is on and the charge is below half')
    if (typeof percent === 'number' && percent < LOW_BATTERY_PERCENT)
      return paused('low-battery', 'battery is low')
    // a locked screen on a charge that is still good is no reason to stop; on a low or unreadable one it is
    if (input.suspended) return paused('locked', 'the machine is asleep')
    if (
      input.locked &&
      (typeof percent !== 'number' || batteryBand(percent) < OCR_MIN_BATTERY_BAND)
    )
      return paused('locked', 'screen is locked on a low battery')
  }

  if (input.onBattery) {
    const light = input.mode === 'light'
    const band = batteryBand(percent)
    const share =
      (input.batterySaver ? SAVER_SHARE : BATTERY_SHARES[band]) * (light ? LIGHT_FACTOR : 1)
    return {
      paused: false,
      threads: 1,
      cpuShare: Math.round(share * 100) / 100,
      priority: light ? 'idle' : 'below-normal',
      tier: 'battery',
      reason: `on battery${input.batterySaver ? ' with battery saver' : ''} (${typeof percent === 'number' ? `${percent}%` : 'level unknown'}): one thread, ${Math.round(share * 100)}% duty cycle`,
      batteryBand: band,
    }
  }

  const idle = input.userIdleSeconds >= IDLE_AFTER_SECONDS
  switch (input.mode) {
    case 'light':
      return {
        paused: false,
        threads: 1,
        cpuShare: LIGHT_SHARE,
        priority: 'below-normal',
        tier: 'light',
        reason: 'light mode: one thread, low duty cycle',
      }
    case 'fast':
      return idle
        ? {
            paused: false,
            threads: threads(8),
            cpuShare: 1,
            priority: 'below-normal',
            tier: 'idle',
            reason: 'fast mode, idle on AC: uncapped',
          }
        : {
            paused: false,
            threads: threads(3),
            cpuShare: FAST_ACTIVE_SHARE,
            priority: 'below-normal',
            tier: 'active',
            reason: 'fast mode, user active: modest share',
          }
    default:
      return idle
        ? {
            paused: false,
            threads: threads(4),
            cpuShare: 1,
            priority: 'below-normal',
            tier: 'idle',
            reason: 'balanced mode, idle on AC: uncapped',
          }
        : {
            paused: false,
            threads: threads(2),
            cpuShare: BALANCED_ACTIVE_SHARE,
            priority: 'below-normal',
            tier: 'active',
            reason: 'balanced mode, user active: half a core',
          }
  }
}

/**
 * Adds hysteresis around resolvePolicy so the effective policy does not flap: ramping up after
 * idleness needs IDLE_STABLE_MS of stable idle; ramping down on activity is immediate; low
 * battery and low memory pause at one threshold and resume at a higher one.
 */
export function createPolicyGovernor(): {
  update(input: PolicyInput, nowMs: number): ResolvedPolicy
} {
  let idleSince: number | null = null
  let lowBattery = false
  let lowMemory = false
  return {
    update(input, nowMs) {
      let { batteryPercent, freeMemMB, userIdleSeconds } = input
      if (input.onBattery && typeof batteryPercent === 'number') {
        lowBattery =
          batteryPercent < LOW_BATTERY_PERCENT ||
          (lowBattery && batteryPercent < LOW_BATTERY_RESUME_PERCENT)
        if (lowBattery) batteryPercent = Math.min(batteryPercent, LOW_BATTERY_PERCENT - 1)
      } else lowBattery = false
      lowMemory = freeMemMB < LOW_MEMORY_MB || (lowMemory && freeMemMB < LOW_MEMORY_RESUME_MB)
      if (lowMemory) freeMemMB = Math.min(freeMemMB, LOW_MEMORY_MB - 1)
      if (userIdleSeconds >= IDLE_AFTER_SECONDS) {
        idleSince ??= nowMs
        if (nowMs - idleSince < IDLE_STABLE_MS) userIdleSeconds = 0
      } else idleSince = null
      return resolvePolicy({ ...input, batteryPercent, freeMemMB, userIdleSeconds })
    },
  }
}
