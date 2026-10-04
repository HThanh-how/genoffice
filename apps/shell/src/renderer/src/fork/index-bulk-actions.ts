/** OCR is offered for scans, not every PDF that happens to be selected. */
export function isOcrCandidate(item: { path: string; reason?: string }): boolean {
  return /\.pdf$/i.test(item.path) && item.reason === 'no-text'
}

/** Polling can briefly put the same file in two groups; actions must run only once. */
export function selectedIndexFiles<T extends { id: number }>(
  groups: Array<{ items: T[] } | undefined>,
  selected: ReadonlySet<number>,
): T[] {
  const unique = new Map<number, T>()
  for (const group of groups) {
    for (const item of group?.items ?? []) {
      if (selected.has(item.id)) unique.set(item.id, item)
    }
  }
  return [...unique.values()]
}
