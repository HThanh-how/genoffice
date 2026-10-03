import { describe, expect, it } from 'vitest'
import {
  LegacyConverter,
  type LegacyConvertMode,
  type LegacyConvertOutcome,
} from '../src/main/legacy-converter'

function rig(options: {
  files: string[]
  mode?: LegacyConvertMode
  outcome?: (path: string) => LegacyConvertOutcome | 'throw'
  paused?: () => boolean
}) {
  const left = [...options.files]
  const converted: string[] = []
  const waits: number[] = []
  let mode: LegacyConvertMode = options.mode ?? 'xls'
  const asked: string[][] = []
  const converter = new LegacyConverter({
    mode: () => mode,
    list: (extensions) => {
      asked.push([...extensions])
      return left.filter((p) => extensions.some((e) => p.endsWith(e)))
    },
    convert: async (path) => {
      const outcome = options.outcome?.(path) ?? 'converted'
      if (outcome === 'throw') throw new Error('boom')
      converted.push(path)
      // the index keeps listing a file until it notices the move: keep it in the list
      return outcome
    },
    paused: options.paused ?? (() => false),
    wait: async (ms) => {
      waits.push(ms)
    },
  })
  return { converter, converted, waits, asked, setMode: (m: LegacyConvertMode) => (mode = m) }
}

const settle = async (converter: LegacyConverter) => {
  for (let i = 0; i < 50 && converter.state().running; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 5))
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

  it('asks for .doc and .ppt only in the "all" mode', async () => {
    const xls = rig({ files: [], mode: 'xls' })
    xls.converter.kick()
    await settle(xls.converter)
    expect(xls.asked[0]).toEqual(['.xls'])
    const all = rig({ files: [], mode: 'all' })
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
})
