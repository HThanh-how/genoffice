import type { IndexingMode } from '../../shared/fork/indexing-mode'
import type { BatteryInfo } from './indexing-battery'
import { createPolicyGovernor, type PolicyInput } from './indexing-policy'
import { publishIndexingPolicy, type PublishedPolicy } from './indexing-policy-bus'

/**
 * Samples power, idle time, lock state and memory every few seconds, resolves the indexing
 * policy and publishes it on the policy bus. Everything here is cheap and synchronous except
 * the battery query, which runs asynchronously, only on battery, and is cached.
 */

type Listener = (...args: unknown[]) => void

/** The slice of Electron's powerMonitor this module needs (a fake in tests). */
export interface PowerMonitorLike {
  isOnBatteryPower(): boolean
  getSystemIdleTime(): number
  /** macOS only */
  getCurrentThermalState?(): string
  on(event: string, listener: Listener): unknown
  removeListener(event: string, listener: Listener): unknown
}

export interface MonitorTimers {
  every(callback: () => void, ms: number): () => void
}

export interface MonitorDeps {
  power: PowerMonitorLike
  cores: number
  freeMemMB: () => number
  readBattery: () => Promise<BatteryInfo>
  settings: () => { mode: IndexingMode; pauseOnBattery: boolean }
  now?: () => number
  timers?: MonitorTimers
  publish?: (policy: PublishedPolicy) => unknown
  tickMs?: number
  batteryMs?: number
}

export const MONITOR_TICK_MS = 5_000
export const BATTERY_POLL_MS = 60_000

const realTimers: MonitorTimers = {
  every(callback, ms) {
    const timer = setInterval(callback, ms)
    timer.unref?.()
    return () => clearInterval(timer)
  },
}

export class IndexingMonitor {
  private readonly governor = createPolicyGovernor()
  private readonly now: () => number
  private readonly timers: MonitorTimers
  private readonly publish: (policy: PublishedPolicy) => unknown
  private readonly handlers = new Map<string, Listener>()
  private stops: (() => void)[] = []
  private locked = false
  private suspended = false
  private thermal = 'unknown'
  private battery: BatteryInfo = {}
  private batteryReadInFlight = false
  private started = false

  constructor(private readonly deps: MonitorDeps) {
    this.now = deps.now ?? Date.now
    this.timers = deps.timers ?? realTimers
    this.publish = deps.publish ?? publishIndexingPolicy
  }

  start(): void {
    if (this.started) return
    this.started = true
    const { power } = this.deps
    const listen = (event: string, handler: Listener) => {
      this.handlers.set(event, handler)
      power.on(event, handler)
    }
    listen('on-battery', () => {
      this.refreshBattery()
      this.tick()
    })
    listen('on-ac', () => {
      this.battery = {}
      this.tick()
    })
    listen('lock-screen', () => {
      this.locked = true
      this.tick()
    })
    listen('unlock-screen', () => {
      this.locked = false
      this.tick()
    })
    listen('suspend', () => {
      this.suspended = true
      this.tick()
    })
    listen('resume', () => {
      this.suspended = false
      this.refreshBattery()
      this.tick()
    })
    listen('thermal-state-change', (details) => {
      const state = (details as { state?: unknown } | undefined)?.state
      if (typeof state === 'string') this.thermal = state
      this.tick()
    })
    try {
      this.thermal = power.getCurrentThermalState?.() ?? 'unknown'
    } catch {
      // Not available on this platform.
    }
    this.stops.push(this.timers.every(() => this.tick(), this.deps.tickMs ?? MONITOR_TICK_MS))
    this.stops.push(
      this.timers.every(() => this.refreshBattery(), this.deps.batteryMs ?? BATTERY_POLL_MS),
    )
    this.refreshBattery()
    this.tick()
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    for (const stop of this.stops) stop()
    this.stops = []
    for (const [event, handler] of this.handlers) this.deps.power.removeListener(event, handler)
    this.handlers.clear()
  }

  /** Re-resolve now (settings changed, or a test advanced the clock). */
  tick(): PublishedPolicy | null {
    if (!this.started) return null
    let onBattery = false
    let idle = 0
    try {
      onBattery = this.deps.power.isOnBatteryPower()
    } catch {
      // Unknown power source: treat as AC (the safe default for a desktop).
    }
    try {
      idle = this.deps.power.getSystemIdleTime()
    } catch {
      // Unknown idle time: treat the user as active.
    }
    const { mode, pauseOnBattery } = this.deps.settings()
    const input: PolicyInput = {
      mode,
      pauseOnBattery,
      onBattery,
      userIdleSeconds: Number.isFinite(idle) && idle > 0 ? idle : 0,
      cores: this.deps.cores,
      freeMemMB: this.deps.freeMemMB(),
      locked: this.locked || this.suspended,
      suspended: this.suspended,
      thermalCritical: this.thermal === 'critical',
      ...(onBattery && this.battery.percent !== undefined
        ? { batteryPercent: this.battery.percent }
        : {}),
      ...(onBattery && this.battery.saver !== undefined
        ? { batterySaver: this.battery.saver }
        : {}),
    }
    const policy: PublishedPolicy = { ...this.governor.update(input, this.now()), onBattery }
    this.publish(policy)
    return policy
  }

  private refreshBattery(): void {
    if (this.batteryReadInFlight) return
    let onBattery = false
    try {
      onBattery = this.deps.power.isOnBatteryPower()
    } catch {
      // Treated as AC.
    }
    // Charge and saver only matter on battery; on AC there is nothing to query.
    if (!onBattery) {
      this.battery = {}
      return
    }
    this.batteryReadInFlight = true
    void this.deps
      .readBattery()
      .then((info) => {
        this.battery = info
      })
      .catch(() => {
        this.battery = {}
      })
      .finally(() => {
        this.batteryReadInFlight = false
        this.tick()
      })
  }
}

/** Free memory the way the rest of the app should see it (see resolve in the IPC module). */
export function electronFreeMemMB(
  getInfo: (() => { free: number }) | undefined,
  fallback: () => number,
): number {
  try {
    if (getInfo) return getInfo().free / 1024 // Electron reports kilobytes
  } catch {
    // fall through
  }
  return fallback() / (1024 * 1024)
}
