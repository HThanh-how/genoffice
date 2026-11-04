/**
 * Stops the parts of something one by one: a part that throws is named (`onFail`) and the ones after it
 * are still stopped, so a failure at the start cannot leave a timer running or a store unclosed at the end.
 */
export function stopEach(
  parts: ReadonlyArray<readonly [name: string, stop: () => void]>,
  onFail?: (name: string) => void,
): void {
  for (const [name, stop] of parts) {
    try {
      stop()
    } catch {
      try {
        onFail?.(name)
      } catch {
        // the report is not allowed to stop the others
      }
    }
  }
}
