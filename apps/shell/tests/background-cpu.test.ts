import { describe, expect, it } from 'vitest'
import {
  backgroundThreadCap,
  selectBackgroundCpuSets,
  type BackgroundCpuSet,
} from '../src/main/fork/background-cpu'

const cpu = (index: number, patch: Partial<BackgroundCpuSet> = {}): BackgroundCpuSet => ({
  id: 100 + index,
  group: 0,
  index,
  core: index,
  efficiencyClass: 0,
  ...patch,
})

describe('background CPU placement', () => {
  it('reserves CPU capacity on small laptops and large servers', () => {
    expect([1, 2, 4, 8, 16, 128].map(backgroundThreadCap)).toEqual([1, 1, 3, 6, 12, 102])
    expect(backgroundThreadCap(NaN)).toBe(1)
  })

  it('chooses the farthest E-cores even if a P-core has a higher index', () => {
    const sets = [
      cpu(0, { efficiencyClass: 1 }),
      cpu(1, { efficiencyClass: 1 }),
      cpu(2),
      cpu(3),
      cpu(4, { efficiencyClass: 1 }),
      cpu(5),
    ]
    expect(selectBackgroundCpuSets(sets, 2)).toEqual([105, 103])
    expect(selectBackgroundCpuSets(sets, 6)).toEqual([105, 103, 102])
  })

  it('leaves complete physical cores free on an SMT laptop', () => {
    const sets = Array.from({ length: 8 }, (_, i) => cpu(i, { core: Math.floor(i / 2) }))
    expect(selectBackgroundCpuSets(sets, 8)).toEqual([107, 106, 105, 104, 103, 102])
    expect(selectBackgroundCpuSets(sets, 1)).toEqual([107])
  })

  it('uses real CPU set IDs across processor groups rather than 32/64-bit shifts', () => {
    const sets = Array.from({ length: 8 }, (_, i) =>
      cpu(i % 4, { id: 2000 + i, group: Math.floor(i / 4) }),
    )
    expect(selectBackgroundCpuSets(sets, 8)).toEqual([2007, 2006, 2005, 2004, 2003, 2002])
  })

  it('respects a process-restricted pool and missing topology', () => {
    expect(selectBackgroundCpuSets([cpu(6), cpu(7)], 8)).toEqual([107])
    expect(selectBackgroundCpuSets([], 8)).toEqual([])
    expect(selectBackgroundCpuSets([cpu(5), cpu(7)], NaN)).toEqual([107])
  })
})
