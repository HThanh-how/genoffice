import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  WINDOWS_BATTERY_SCRIPT,
  parsePmsetBattery,
  parsePmsetLowPowerMode,
  parseWindowsBattery,
  readBattery,
  type BatteryDeps,
  type BatteryInfo,
  type ExecFileFn,
} from '../src/main/fork/indexing-battery'
import {
  IndexingMonitor,
  electronFreeMemMB,
  type MonitorTimers,
} from '../src/main/fork/indexing-monitor'
import {
  currentIndexingPolicy,
  isIndexingPaused,
  publishIndexingPolicy,
  resetIndexingPolicyBus,
  subscribeIndexingPolicy,
  type PublishedPolicy,
} from '../src/main/fork/indexing-policy-bus'

class FakePower extends EventEmitter {
  battery = false
  idle = 0
  thermal: string | undefined = undefined
  throwIdle = false
  isOnBatteryPower() {
    return this.battery
  }
  getSystemIdleTime() {
    if (this.throwIdle) throw new Error('unsupported')
    return this.idle
  }
  getCurrentThermalState() {
    return this.thermal as string
  }
}

class FakeTimers implements MonitorTimers {
  callbacks: { fn: () => void; ms: number; active: boolean }[] = []
  every(fn: () => void, ms: number) {
    const entry = { fn, ms, active: true }
    this.callbacks.push(entry)
    return () => {
      entry.active = false
    }
  }
  fire(ms: number) {
    for (const entry of this.callbacks) if (entry.active && entry.ms === ms) entry.fn()
  }
}

function setup(options: { battery?: BatteryInfo; mem?: number; cores?: number } = {}) {
  const power = new FakePower()
  const timers = new FakeTimers()
  let clock = 0
  let mem = options.mem ?? 8000
  let info: BatteryInfo = options.battery ?? {}
  let reads = 0
  const published: PublishedPolicy[] = []
  const settings = { mode: 'balanced' as 'light' | 'balanced' | 'fast', pauseOnBattery: true }
  const monitor = new IndexingMonitor({
    power,
    cores: options.cores ?? 16,
    freeMemMB: () => mem,
    readBattery: async () => {
      reads++
      return info
    },
    settings: () => settings,
    now: () => clock,
    timers,
    publish: (policy) => {
      published.push(policy)
      return publishIndexingPolicy(policy)
    },
  })
  return {
    power,
    timers,
    monitor,
    settings,
    published,
    advance: (ms: number) => (clock += ms),
    setMem: (value: number) => (mem = value),
    setBattery: (value: BatteryInfo) => (info = value),
    reads: () => reads,
    last: () => published.at(-1)!,
  }
}
const flush = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => resetIndexingPolicyBus())

describe('IndexingMonitor', () => {
  it('publishes a first policy on start and tolerates a missing thermal API', () => {
    const t = setup()
    t.monitor.start()
    expect(t.last()).toMatchObject({ paused: false, tier: 'active', threads: 2, onBattery: false })
    expect(currentIndexingPolicy()?.threads).toBe(2)
  })

  it('ramps up only after stable idle on AC and drops immediately on activity', () => {
    const t = setup()
    t.monitor.start()
    t.power.idle = 200
    t.advance(5_000)
    t.timers.fire(5_000)
    expect(t.last().tier).toBe('active') // idle seen, not yet stable for 10 s
    t.power.idle = 215
    t.advance(10_000)
    t.timers.fire(5_000)
    expect(t.last()).toMatchObject({ tier: 'idle', threads: 4, cpuShare: 1 })
    t.power.idle = 0
    t.advance(1_000)
    t.timers.fire(5_000)
    expect(t.last()).toMatchObject({ tier: 'active', threads: 2 })
  })

  it('reacts to on-battery / on-ac events at once and reads the battery only on battery', async () => {
    const t = setup({ battery: { percent: 80 } })
    t.monitor.start()
    expect(t.reads()).toBe(0) // AC: nothing to query
    t.power.battery = true
    t.power.emit('on-battery')
    await flush()
    expect(t.reads()).toBe(1)
    expect(t.last()).toMatchObject({ tier: 'battery', threads: 1, onBattery: true })
    t.setBattery({ percent: 20 })
    t.timers.fire(60_000)
    await flush()
    expect(t.last()).toMatchObject({ paused: true, pauseReason: 'low-battery' })
    expect(isIndexingPaused()).toBe(true)
    t.power.battery = false
    t.power.emit('on-ac')
    expect(isIndexingPaused()).toBe(false)
    expect(t.last().onBattery).toBe(false)
  })

  it('pauses for battery saver and for a locked screen on battery, resumes on unlock', async () => {
    const t = setup({ battery: { percent: 40, saver: true } })
    t.power.battery = true
    t.monitor.start()
    await flush()
    expect(t.last()).toMatchObject({ paused: true, pauseReason: 'battery-saver' })
    // battery saver on a good charge is a trickle, not a stop
    t.setBattery({ percent: 90, saver: true })
    t.timers.fire(60_000)
    await flush()
    expect(t.last()).toMatchObject({ paused: false, cpuShare: 0.1 })
    t.setBattery({ percent: 90, saver: false })
    t.timers.fire(60_000)
    await flush()
    expect(t.last().paused).toBe(false)
    // a locked screen on a good charge keeps working (slowly); on a low one it stops
    t.power.emit('lock-screen')
    expect(t.last().paused).toBe(false)
    t.setBattery({ percent: 40, saver: false })
    t.timers.fire(60_000)
    await flush()
    expect(t.last()).toMatchObject({ paused: true, pauseReason: 'locked' })
    t.power.emit('unlock-screen')
    expect(t.last().paused).toBe(false)
  })

  it('pauses on suspend until resume', async () => {
    const t = setup({ battery: { percent: 90 } })
    t.power.battery = true
    t.monitor.start()
    await flush()
    t.power.emit('suspend')
    expect(t.last().pauseReason).toBe('suspended')
    t.power.emit('resume')
    await flush()
    expect(t.last().paused).toBe(false)
  })

  it('pauses on suspend on AC until resume', () => {
    const t = setup()
    t.monitor.start()
    t.power.emit('suspend')
    expect(t.last()).toMatchObject({ paused: true, pauseReason: 'suspended' })
    t.power.emit('resume')
    expect(t.last().paused).toBe(false)
  })

  it('does not pause a locked screen on AC', () => {
    const t = setup()
    t.monitor.start()
    t.power.emit('lock-screen')
    expect(t.last().paused).toBe(false)
  })

  it('pauses on low memory with hysteresis', () => {
    const t = setup()
    t.monitor.start()
    t.setMem(1000)
    t.timers.fire(5_000)
    expect(t.last()).toMatchObject({ paused: true, pauseReason: 'low-memory' })
    t.setMem(1700)
    t.timers.fire(5_000)
    expect(t.last().paused).toBe(true)
    t.setMem(2100)
    t.timers.fire(5_000)
    expect(t.last().paused).toBe(false)
  })

  it('pauses when macOS reports a critical thermal state', () => {
    const t = setup()
    t.power.thermal = 'nominal'
    t.monitor.start()
    t.power.emit('thermal-state-change', { state: 'critical' })
    expect(t.last()).toMatchObject({ paused: true, pauseReason: 'thermal' })
    t.power.emit('thermal-state-change', { state: 'fair' })
    expect(t.last().paused).toBe(false)
  })

  it('reads an initial critical thermal state', () => {
    const t = setup()
    t.power.thermal = 'critical'
    t.monitor.start()
    expect(t.last().pauseReason).toBe('thermal')
  })

  it('follows setting changes on the next tick', () => {
    const t = setup()
    t.monitor.start()
    t.settings.mode = 'light'
    t.monitor.tick()
    expect(t.last()).toMatchObject({ tier: 'light', threads: 1 })
    t.settings.mode = 'fast'
    t.monitor.tick()
    expect(t.last()).toMatchObject({ tier: 'active', threads: 3 })
  })

  it('treats an idle-time failure as an active user (Wayland / unsupported)', () => {
    const t = setup()
    t.power.throwIdle = true
    t.monitor.start()
    expect(t.last().tier).toBe('active')
  })

  it('survives battery reads that fail', async () => {
    const power = new FakePower()
    power.battery = true
    const monitor = new IndexingMonitor({
      power,
      cores: 8,
      freeMemMB: () => 8000,
      readBattery: () => Promise.reject(new Error('boom')),
      settings: () => ({ mode: 'balanced', pauseOnBattery: true }),
      timers: new FakeTimers(),
      publish: publishIndexingPolicy,
    })
    monitor.start()
    await flush()
    expect(currentIndexingPolicy()).toMatchObject({ paused: false, tier: 'battery' })
  })

  it('stops cleanly: timers cleared, listeners removed, no more publishes', () => {
    const t = setup()
    t.monitor.start()
    const count = t.published.length
    t.monitor.stop()
    expect(t.power.listenerCount('on-battery')).toBe(0)
    expect(t.timers.callbacks.every((entry) => !entry.active)).toBe(true)
    t.monitor.tick()
    expect(t.published.length).toBe(count)
  })

  it('does not notify subscribers when nothing changed', () => {
    const t = setup()
    const seen: PublishedPolicy[] = []
    subscribeIndexingPolicy((next) => seen.push(next))
    t.monitor.start()
    t.timers.fire(5_000)
    t.timers.fire(5_000)
    expect(seen).toHaveLength(1)
  })
})

describe('electronFreeMemMB', () => {
  it('prefers Electron (kilobytes) and falls back to os bytes', () => {
    expect(
      electronFreeMemMB(
        () => ({ free: 4 * 1024 * 1024 }),
        () => 0,
      ),
    ).toBe(4096)
    expect(electronFreeMemMB(undefined, () => 2048 * 1024 * 1024)).toBe(2048)
    expect(
      electronFreeMemMB(
        () => {
          throw new Error('no')
        },
        () => 1024 * 1024 * 1024,
      ),
    ).toBe(1024)
  })
})

describe('battery readers', () => {
  it('parses the Windows output', () => {
    expect(parseWindowsBattery('99|Disabled\r\n')).toEqual({ percent: 99, saver: false })
    expect(parseWindowsBattery('42|On')).toEqual({ percent: 42, saver: true })
    expect(parseWindowsBattery('|')).toEqual({})
    expect(parseWindowsBattery('')).toEqual({})
    expect(parseWindowsBattery('250|Off')).toEqual({ saver: false })
    expect(parseWindowsBattery('77|Uninitialized')).toEqual({ percent: 77 })
  })

  it('parses pmset output', () => {
    const batt =
      "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t78%; discharging; 3:20 remaining present: true"
    expect(parsePmsetBattery(batt)).toBe(78)
    expect(parsePmsetBattery("Now drawing from 'AC Power'")).toBeUndefined()
    expect(parsePmsetLowPowerMode(' sleep 1\n lowpowermode         1\n')).toBe(true)
    expect(parsePmsetLowPowerMode(' lowpowermode 0')).toBe(false)
    expect(parsePmsetLowPowerMode('nothing')).toBeUndefined()
  })

  function deps(
    platform: NodeJS.Platform,
    exec: ExecFileFn,
    files: Record<string, string> = {},
  ): BatteryDeps {
    return {
      platform,
      execFile: exec,
      systemRoot: 'C:\\Windows',
      readFile: async (path) => {
        if (path in files) return files[path]!
        throw new Error('ENOENT')
      },
      readdir: async (path) => {
        const prefix = path.endsWith('/') ? path : `${path}/`
        const names = new Set(
          Object.keys(files)
            .filter((file) => file.startsWith(prefix))
            .map((file) => file.slice(prefix.length).split('/')[0]!),
        )
        if (!names.size) throw new Error('ENOENT')
        return [...names]
      },
    }
  }

  it('Windows: runs PowerShell by absolute path with an argument array and a timeout', async () => {
    const calls: { file: string; args: string[]; timeout: number }[] = []
    const result = await readBattery(
      deps('win32', async (file, args, options) => {
        calls.push({ file, args, timeout: options.timeout })
        return { stdout: '55|On\r\n' }
      }),
    )
    expect(result).toEqual({ percent: 55, saver: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.file.toLowerCase()).toContain('windowspowershell')
    expect(calls[0]!.file.toLowerCase().endsWith('powershell.exe')).toBe(true)
    expect(calls[0]!.args).toContain(WINDOWS_BATTERY_SCRIPT)
    expect(calls[0]!.timeout).toBeGreaterThan(0)
    expect(WINDOWS_BATTERY_SCRIPT).not.toMatch(/wmic/i)
  })

  it('macOS: uses pmset for percentage and Low Power Mode', async () => {
    const seen: string[] = []
    const result = await readBattery(
      deps('darwin', async (file, args) => {
        seen.push(`${file} ${args.join(' ')}`)
        return {
          stdout: args.includes('batt')
            ? ' -InternalBattery-0 (id=1)\t64%; discharging'
            : ' lowpowermode 1\n',
        }
      }),
    )
    expect(result).toEqual({ percent: 64, saver: true })
    expect(seen).toEqual(['/usr/bin/pmset -g batt', '/usr/bin/pmset -g'])
  })

  it('macOS: a failing pmset yields what it can', async () => {
    const result = await readBattery(
      deps('darwin', async (_file, args) => {
        if (args.includes('batt')) throw new Error('nope')
        return { stdout: 'lowpowermode 0' }
      }),
    )
    expect(result).toEqual({ saver: false })
  })

  it('Linux: reads /sys/class/power_supply capacity and powerprofilesctl', async () => {
    const files = {
      '/sys/class/power_supply/AC/type': 'Mains\n',
      '/sys/class/power_supply/BAT0/type': 'Battery\n',
      '/sys/class/power_supply/BAT0/capacity': '47\n',
    }
    const result = await readBattery(
      deps('linux', async () => ({ stdout: 'power-saver\n' }), files),
    )
    expect(result).toEqual({ percent: 47, saver: true })
  })

  it('Linux: a desktop (no battery, no power-profiles-daemon) returns nothing', async () => {
    const result = await readBattery(
      deps('linux', async () => {
        throw new Error('ENOENT')
      }),
    )
    expect(result).toEqual({})
  })

  it('Linux: balanced profile is not battery saver', async () => {
    const files = {
      '/sys/class/power_supply/BAT1/type': 'Battery',
      '/sys/class/power_supply/BAT1/capacity': '90',
    }
    expect(await readBattery(deps('linux', async () => ({ stdout: 'balanced\n' }), files))).toEqual(
      {
        percent: 90,
        saver: false,
      },
    )
  })

  it('never throws', async () => {
    const result = await readBattery(
      deps('win32', async () => {
        throw new Error('timed out')
      }),
    )
    expect(result).toEqual({})
  })
})
