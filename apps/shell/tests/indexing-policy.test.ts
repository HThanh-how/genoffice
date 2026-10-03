import { describe, expect, it } from 'vitest'
import {
  memoryThresholds,
  IDLE_STABLE_MS,
  createPolicyGovernor,
  resolvePolicy,
  type PolicyInput,
} from '../src/main/fork/indexing-policy'

const base: PolicyInput = {
  mode: 'balanced',
  onBattery: false,
  userIdleSeconds: 0,
  cores: 16,
  freeMemMB: 8000,
  locked: false,
  pauseOnBattery: true,
}
const policy = (patch: Partial<PolicyInput>) => resolvePolicy({ ...base, ...patch })

describe('resolvePolicy on AC power', () => {
  const rows: {
    name: string
    input: Partial<PolicyInput>
    threads: number
    share: number
    tier: string
  }[] = [
    { name: 'light, active', input: { mode: 'light' }, threads: 1, share: 0.3, tier: 'light' },
    {
      name: 'light, idle stays light',
      input: { mode: 'light', userIdleSeconds: 600 },
      threads: 1,
      share: 0.3,
      tier: 'light',
    },
    { name: 'balanced, active', input: {}, threads: 2, share: 0.5, tier: 'active' },
    {
      name: 'balanced, idle just under 120 s',
      input: { userIdleSeconds: 119 },
      threads: 2,
      share: 0.5,
      tier: 'active',
    },
    {
      name: 'balanced, idle 120 s',
      input: { userIdleSeconds: 120 },
      threads: 4,
      share: 1,
      tier: 'idle',
    },
    {
      name: 'balanced, idle on 4 cores caps at 2',
      input: { userIdleSeconds: 900, cores: 4 },
      threads: 2,
      share: 1,
      tier: 'idle',
    },
    { name: 'fast, active', input: { mode: 'fast' }, threads: 3, share: 0.6, tier: 'active' },
    {
      name: 'fast, idle on 16 cores',
      input: { mode: 'fast', userIdleSeconds: 300 },
      threads: 8,
      share: 1,
      tier: 'idle',
    },
    {
      name: 'fast, idle on 8 cores',
      input: { mode: 'fast', userIdleSeconds: 300, cores: 8 },
      threads: 4,
      share: 1,
      tier: 'idle',
    },
    {
      name: 'fast, idle on 32 cores still 8',
      input: { mode: 'fast', userIdleSeconds: 300, cores: 32 },
      threads: 8,
      share: 1,
      tier: 'idle',
    },
    {
      name: 'fast, active on 4 cores caps at 2',
      input: { mode: 'fast', cores: 4 },
      threads: 2,
      share: 0.6,
      tier: 'active',
    },
    {
      name: 'dual core keeps one thread',
      input: { mode: 'fast', userIdleSeconds: 999, cores: 2 },
      threads: 1,
      share: 1,
      tier: 'idle',
    },
    {
      name: 'single core keeps one thread',
      input: { mode: 'balanced', cores: 1 },
      threads: 1,
      share: 0.5,
      tier: 'active',
    },
    {
      name: 'desktop without battery info is plain AC',
      input: { batteryPercent: undefined, batterySaver: undefined, userIdleSeconds: 500 },
      threads: 4,
      share: 1,
      tier: 'idle',
    },
    {
      name: 'locked on AC keeps running',
      input: { locked: true, userIdleSeconds: 500 },
      threads: 4,
      share: 1,
      tier: 'idle',
    },
    {
      name: 'low battery percent is ignored on AC',
      input: { batteryPercent: 5, batterySaver: true },
      threads: 2,
      share: 0.5,
      tier: 'active',
    },
    {
      name: 'unknown mode falls back to balanced behaviour',
      input: { mode: 'bogus' as never },
      threads: 2,
      share: 0.5,
      tier: 'active',
    },
  ]
  it.each(rows)('$name', ({ input, threads, share, tier }) => {
    const result = policy(input)
    expect(result.paused).toBe(false)
    expect(result.threads).toBe(threads)
    expect(result.cpuShare).toBeCloseTo(share)
    expect(result.tier).toBe(tier)
    expect(result.priority).toBe('below-normal')
  })

  it('never uses more than half of the logical cores', () => {
    for (const cores of [1, 2, 3, 4, 6, 8, 12, 16, 24, 64])
      for (const mode of ['light', 'balanced', 'fast'] as const)
        for (const idle of [0, 1000])
          expect(policy({ cores, mode, userIdleSeconds: idle }).threads).toBeLessThanOrEqual(
            Math.max(1, Math.floor(cores / 2)),
          )
  })
})

describe('resolvePolicy on battery', () => {
  it.each(['light', 'balanced', 'fast'] as const)('%s mode runs light-like at 60%%', (mode) => {
    const result = policy({ mode, onBattery: true, batteryPercent: 60, userIdleSeconds: 900 })
    expect(result.paused).toBe(false)
    expect(result.threads).toBe(1)
    expect(result.cpuShare).toBeLessThanOrEqual(0.3)
    expect(result.tier).toBe('battery')
  })

  it('uses the idle OS class only for Light on battery', () => {
    expect(policy({ mode: 'light', onBattery: true }).priority).toBe('idle')
    expect(policy({ mode: 'balanced', onBattery: true }).priority).toBe('below-normal')
    expect(policy({ mode: 'fast', onBattery: true }).priority).toBe('below-normal')
  })

  it('runs when the battery percentage is unknown and nothing else is wrong', () => {
    expect(policy({ onBattery: true }).paused).toBe(false)
  })

  it('shrinks the work as the charge falls instead of all or nothing', () => {
    const share = (batteryPercent: number) =>
      policy({ mode: 'balanced', onBattery: true, batteryPercent }).cpuShare
    expect(share(100)).toBe(0.4)
    expect(share(80)).toBe(0.4)
    expect(share(79)).toBe(0.3)
    expect(share(50)).toBe(0.3)
    expect(share(49)).toBe(0.15)
    expect(share(30)).toBe(0.15)
    expect(policy({ onBattery: true, batteryPercent: 29 }).paused).toBe(true)
  })

  it('takes a fifth less in light mode at every level', () => {
    expect(policy({ mode: 'light', onBattery: true, batteryPercent: 90 }).cpuShare).toBe(0.32)
    expect(policy({ mode: 'light', onBattery: true, batteryPercent: 40 }).cpuShare).toBe(0.12)
  })

  it('keeps a trickle going with battery saver on while the charge is half or more', () => {
    const result = policy({
      mode: 'balanced',
      onBattery: true,
      batterySaver: true,
      batteryPercent: 90,
    })
    expect(result.paused).toBe(false)
    expect(result.cpuShare).toBe(0.1)
    expect(result.threads).toBe(1)
    expect(policy({ onBattery: true, batterySaver: true, batteryPercent: 49 }).paused).toBe(true)
  })

  it('keeps going with the screen locked while the charge is still good', () => {
    const result = policy({ onBattery: true, batteryPercent: 80, locked: true })
    expect(result.paused).toBe(false)
    expect(result.batteryBand).toBe(3)
  })

  const pauses: { name: string; input: Partial<PolicyInput>; reason: string }[] = [
    { name: 'under 30%', input: { batteryPercent: 29 }, reason: 'low-battery' },
    { name: 'at 1%', input: { batteryPercent: 1 }, reason: 'low-battery' },
    {
      name: 'battery saver below half a charge',
      input: { batterySaver: true, batteryPercent: 40 },
      reason: 'battery-saver',
    },
    {
      name: 'battery saver and the charge unknown',
      input: { batterySaver: true },
      reason: 'battery-saver',
    },
    { name: 'locked screen on 40%', input: { locked: true, batteryPercent: 40 }, reason: 'locked' },
    { name: 'locked screen, charge unknown', input: { locked: true }, reason: 'locked' },
  ]
  it.each(pauses)('pauses on battery: $name', ({ input, reason }) => {
    const result = policy({ onBattery: true, ...input })
    expect(result.paused).toBe(true)
    expect(result.pauseReason).toBe(reason)
    expect(result.tier).toBe('paused')
  })

  it('does not pause at exactly 30%', () => {
    expect(policy({ onBattery: true, batteryPercent: 30 }).paused).toBe(false)
  })

  it('keeps running on battery when pauseOnBattery is off', () => {
    const result = policy({
      onBattery: true,
      pauseOnBattery: false,
      batteryPercent: 5,
      batterySaver: true,
      locked: true,
    })
    expect(result.paused).toBe(false)
    expect(result.threads).toBe(1)
  })
})

describe('resolvePolicy global pauses', () => {
  it('pauses on low memory regardless of power', () => {
    expect(policy({ freeMemMB: 1499 })).toMatchObject({ paused: true, pauseReason: 'low-memory' })
    expect(policy({ freeMemMB: 1500 }).paused).toBe(false)
    expect(policy({ freeMemMB: 100, onBattery: true })).toMatchObject({ pauseReason: 'low-memory' })
  })
  it('pauses when the thermal state is critical', () => {
    expect(policy({ thermalCritical: true })).toMatchObject({
      paused: true,
      pauseReason: 'thermal',
    })
  })
  it('reports a user pause first', () => {
    expect(policy({ userPaused: true, freeMemMB: 10, thermalCritical: true })).toMatchObject({
      pauseReason: 'user',
    })
  })
  it('a paused policy asks for no CPU', () => {
    expect(policy({ freeMemMB: 10 })).toMatchObject({ cpuShare: 0, priority: 'idle' })
  })
})

describe('createPolicyGovernor', () => {
  it('needs 10 s of stable idle before ramping up, and drops at once on activity', () => {
    const governor = createPolicyGovernor()
    expect(governor.update({ ...base, userIdleSeconds: 119 }, 0).tier).toBe('active')
    expect(governor.update({ ...base, userIdleSeconds: 125 }, 5_000).tier).toBe('active')
    expect(governor.update({ ...base, userIdleSeconds: 130 }, 5_000 + IDLE_STABLE_MS).tier).toBe(
      'idle',
    )
    // The user touches the machine: immediate ramp-down.
    expect(governor.update({ ...base, userIdleSeconds: 0 }, 20_000).tier).toBe('active')
    // Idle again: the stability timer starts over.
    expect(governor.update({ ...base, userIdleSeconds: 121 }, 21_000).tier).toBe('active')
    expect(governor.update({ ...base, userIdleSeconds: 140 }, 31_000).tier).toBe('idle')
  })

  it('pauses below 30% battery and resumes only from 35%', () => {
    const governor = createPolicyGovernor()
    const on = (percent: number, at: number) =>
      governor.update({ ...base, onBattery: true, batteryPercent: percent }, at)
    expect(on(31, 0).paused).toBe(false)
    expect(on(29, 1).paused).toBe(true)
    expect(on(31, 2).paused).toBe(true)
    expect(on(34, 3).paused).toBe(true)
    expect(on(35, 4).paused).toBe(false)
    expect(on(30, 5).paused).toBe(false)
  })

  it('forgets the low-battery latch on AC', () => {
    const governor = createPolicyGovernor()
    governor.update({ ...base, onBattery: true, batteryPercent: 10 }, 0)
    expect(governor.update({ ...base, onBattery: false }, 1).paused).toBe(false)
    expect(governor.update({ ...base, onBattery: true, batteryPercent: 31 }, 2).paused).toBe(false)
  })

  it('pauses below 1500 MB free and resumes from 2000 MB', () => {
    const governor = createPolicyGovernor()
    const mem = (freeMemMB: number, at: number) => governor.update({ ...base, freeMemMB }, at)
    expect(mem(1600, 0).paused).toBe(false)
    expect(mem(1400, 1).paused).toBe(true)
    expect(mem(1800, 2).paused).toBe(true)
    expect(mem(2000, 3).paused).toBe(false)
  })

  it('scales the memory pause to the computer, so an 8 GB laptop is not stopped for good', () => {
    // 7104 MB in all (an 8 GB laptop): pauses below 568 MB, resumes from 767 MB
    const total = 7104
    expect(memoryThresholds(total)).toEqual({ low: 568, resume: 767 })
    const governor = createPolicyGovernor()
    const mem = (freeMemMB: number, at: number) =>
      governor.update({ ...base, freeMemMB, totalMemMB: total }, at)
    // the 1.7 GB such a laptop usually has free is plenty: it was paused here before
    expect(mem(1732, 0).paused).toBe(false)
    expect(mem(500, 1).paused).toBe(true)
    expect(mem(700, 2).paused).toBe(true)
    expect(mem(800, 3).paused).toBe(false)
  })

  it('keeps the fixed thresholds on a big computer and when the total is not known', () => {
    expect(memoryThresholds(32768)).toEqual({ low: 1500, resume: 2000 })
    expect(memoryThresholds(undefined)).toEqual({ low: 1500, resume: 2000 })
    expect(memoryThresholds(Number.NaN)).toEqual({ low: 1500, resume: 2000 })
    // a very small computer still pauses somewhere sensible
    expect(memoryThresholds(2048).low).toBe(512)
    expect(resolvePolicy({ ...base, freeMemMB: 1499 })).toMatchObject({
      paused: true,
      pauseReason: 'low-memory',
    })
  })
})
