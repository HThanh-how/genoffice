import { describe, expect, it } from 'vitest'
import { availableMemoryBytes, parseVmStat } from '../src/host/memory'

const GiB = 1024 ** 3
const sample = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               21070.
Pages active:                            311173.
Pages inactive:                          358894.
Pages speculative:                        11181.
Pages throttled:                              0.
Pages wired down:                        124985.
Pages purgeable:                          10026.
`

describe('available memory', () => {
  it('counts inactive, speculative and purgeable pages as available on macOS', () => {
    expect(parseVmStat(sample)).toBe((21070 + 358894 + 11181 + 10026) * 16384)
    const bytes = availableMemoryBytes('darwin', () => sample, 0.48 * GiB, 16 * GiB)
    expect(bytes / GiB).toBeGreaterThan(6)
  })
  it('never reports more than the machine has, nor less than the kernel says is free', () => {
    expect(availableMemoryBytes('darwin', () => sample, 1 * GiB, 4 * GiB)).toBeLessThanOrEqual(
      4 * GiB,
    )
    expect(availableMemoryBytes('darwin', () => sample, 9 * GiB, 16 * GiB)).toBeGreaterThanOrEqual(
      9 * GiB,
    )
  })
  it('falls back to a quarter of the RAM when vm_stat cannot be read, and trusts freemem elsewhere', () => {
    const fail = () => {
      throw new Error('ENOENT')
    }
    expect(availableMemoryBytes('darwin', fail, 0.4 * GiB, 16 * GiB)).toBe(4 * GiB)
    expect(availableMemoryBytes('darwin', () => 'garbage', 0.4 * GiB, 16 * GiB)).toBe(4 * GiB)
    expect(availableMemoryBytes('win32', fail, 3 * GiB, 16 * GiB)).toBe(3 * GiB)
  })
})
