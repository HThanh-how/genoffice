export interface BackgroundCpuSet {
  id: number
  group: number
  index: number
  core: number
  efficiencyClass: number
}

/** Reserve at least 20% of the available logical processors for other work. */
export function backgroundThreadCap(count: number): number {
  return Math.max(1, Math.floor((Number.isFinite(count) ? count : 1) * 0.8))
}

/** Prefer efficient cores, then the highest numbered physical cores and their CPU indices. */
export function selectBackgroundCpuSets(sets: BackgroundCpuSet[], requested: number): number[] {
  if (!sets.length) return []
  const classes = sets.map((cpu) => cpu.efficiencyClass)
  const efficient = Math.min(...classes)
  const hybrid = efficient !== Math.max(...classes)
  const pool = (hybrid ? sets.filter((cpu) => cpu.efficiencyClass === efficient) : sets)
    .slice()
    .sort((a, b) => b.group - a.group || b.index - a.index)
  const physicalCores = new Set(sets.map((cpu) => `${cpu.group}:${cpu.core}`)).size
  const physicalLimit = backgroundThreadCap(physicalCores)
  const allowedCores = new Set<string>()
  const limit = Math.min(
    backgroundThreadCap(sets.length),
    Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1,
  )
  const selected: number[] = []
  for (const cpu of pool) {
    const core = `${cpu.group}:${cpu.core}`
    if (!allowedCores.has(core) && allowedCores.size >= physicalLimit) continue
    allowedCores.add(core)
    selected.push(cpu.id)
    if (selected.length >= limit) break
  }
  return selected
}
