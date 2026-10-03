import { describe, expect, it } from 'vitest'
import {
  BUSY_PAUSE_MS,
  CONVERT_CONCURRENCY,
  LegacyConverter,
  type LegacyConvertMode,
  type LegacyConvertOutcome,
} from '../src/main/legacy-converter'

function rig(options: {
  files: string[]
  mode?: LegacyConvertMode
  concurrency?: number
  outcome?: (path: string) => LegacyConvertOutcome | 'throw'
  paused?: () => boolean
  /** hold each conversion until released, to see how many run at once */
  gate?: boolean
}) {
  const converted: string[] = []
  const waits: number[] = []
  const asked: string[][] = []
  const releases: Array<() => void> = []
  let running = 0
  let peak = 0
  const mode: LegacyConvertMode = options.mode ?? 'all'
  const converter = new LegacyConverter({
    mode: () => mode,
    concurrency: options.concurrency ?? 1,
    list: (extensions) => {
      asked.push([...extensions])
      // the index keeps listing a file until it notices the move: never drop one from here
      return options.files.filter((p) => extensions.some((e) => p.endsWith(e)))
    },
    convert: async (path) => {
      running++
      peak = Math.max(peak, running)
      if (options.gate) await new Promise<void>((resolve) => releases.push(resolve))
      running--
      const outcome = options.outcome?.(path) ?? 'converted'
      if (outcome === 'throw') throw new Error('boom')
      converted.push(path)
      return outcome
    },
    paused: options.paused ?? (() => false),
    wait: async (ms) => {
      waits.push(ms)
    },
  })
  return {
    converter,
    converted,
    waits,
    asked,
    releases,
    peak: () => peak,
    releaseAll: () => releases.splice(0).forEach((release) => release()),
  }
}

const settle = async (converter: LegacyConverter) => {
  for (let i = 0; i < 80 && converter.state().running; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

describe('the background converter', () => {
  it('converts every old file once, even while the index still lists it', async () => {
    const { converter, converted } = rig({ files: ['/a/1.xls', '/a/2.xls'] })
    converter.kick()
    await settle(converter)
    expect(converted).toEqual(['/a/1.xls', '/a/2.xls'])
    expect(converter.state()).toMatchObject({ running: false, converted: 2, failed: 0 })
  })

  it('does nothing when it is off', async () => {
    const { converter, converted } = rig({ files: ['/a/1.xls'], mode: 'off' })
    converter.kick()
    await settle(converter)
    expect(converted).toEqual([])
  })

  it('asks for every old format when it is on', async () => {
    const all = rig({ files: [] })
    all.converter.kick()
    await settle(all.converter)
    expect(all.asked[0]).toEqual(['.xls', '.doc', '.ppt'])
  })

  it('does not try a failing file again, and carries on with the next', async () => {
    const { converter, converted } = rig({
      files: ['/a/bad.xls', '/a/good.xls'],
      outcome: (p) => (p.includes('bad') ? 'throw' : 'converted'),
    })
    converter.kick()
    await settle(converter)
    expect(converted).toEqual(['/a/good.xls'])
    expect(converter.state()).toMatchObject({ converted: 1, failed: 1 })
  })

  it('leaves a file that is not ready for the next start', async () => {
    let ready = false
    const { converter, converted } = rig({
      files: ['/a/new.xls'],
      outcome: () => (ready ? 'converted' : 'skipped'),
    })
    converter.kick()
    await settle(converter)
    expect(converted).toEqual(['/a/new.xls'])
    expect(converter.state().failed).toBe(0)
    ready = true
    converter.kick()
    await settle(converter)
    expect(converter.state().converted).toBe(1)
  })

  it('waits while the machine is saving power instead of converting', async () => {
    let paused = true
    const { converter, converted, waits } = rig({
      files: ['/a/1.xls'],
      paused: () => {
        const was = paused
        paused = false
        return was
      },
    })
    converter.kick()
    await settle(converter)
    expect(waits[0]).toBe(30_000)
    expect(converted).toEqual(['/a/1.xls'])
  })

  it('does not pause between files: the old files are converted as fast as the service allows', async () => {
    const { converter, waits } = rig({ files: ['/a/1.xls', '/a/2.doc', '/a/3.ppt'] })
    converter.kick()
    await settle(converter)
    expect(waits).toEqual([])
  })
})

describe('converting several files at the same time', () => {
  it('runs as many at once as it is allowed to, no more, and converts each file once', async () => {
    const files = Array.from({ length: 10 }, (_, i) => `/a/${i}.doc`)
    const { converter, converted, peak, releases, releaseAll } = rig({
      files,
      concurrency: 4,
      gate: true,
    })
    converter.kick()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(releases).toHaveLength(4)
    expect(peak()).toBe(4)
    for (let i = 0; i < 40 && converter.state().running; i++) {
      releaseAll()
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    expect(peak()).toBe(4)
    expect([...converted].sort()).toEqual([...files].sort())
    expect(new Set(converted).size).toBe(10)
  })

  it('uses four at a time by default, to keep the four-slot service full', () => {
    expect(CONVERT_CONCURRENCY).toBe(4)
  })

  it('keeps going when one of the files in flight fails', async () => {
    const files = ['/a/1.doc', '/a/2.doc', '/a/3.doc', '/a/4.doc', '/a/5.doc']
    const { converter, converted } = rig({
      files,
      concurrency: 3,
      outcome: (p) => (p.includes('2') ? 'throw' : 'converted'),
    })
    converter.kick()
    await settle(converter)
    expect([...converted].sort()).toEqual(['/a/1.doc', '/a/3.doc', '/a/4.doc', '/a/5.doc'])
    expect(converter.state()).toMatchObject({ converted: 4, failed: 1 })
  })

  it('stops all workers when the service asks for a pause, then tries the same file again', async () => {
    let busyOnce = true
    const { converter, converted, waits } = rig({
      files: ['/a/1.doc', '/a/2.doc', '/a/3.doc'],
      concurrency: 3,
      outcome: (p) => {
        if (p.includes('1') && busyOnce) {
          busyOnce = false
          return 'busy'
        }
        return 'converted'
      },
    })
    converter.kick()
    await settle(converter)
    expect(waits.filter((w) => w === BUSY_PAUSE_MS)).toHaveLength(1)
    // the paused file is asked for twice (busy, then converted); the others once
    expect([...converted].sort()).toEqual(['/a/1.doc', '/a/1.doc', '/a/2.doc', '/a/3.doc'])
    expect(converter.state()).toMatchObject({ converted: 3, failed: 0 })
  })
})
