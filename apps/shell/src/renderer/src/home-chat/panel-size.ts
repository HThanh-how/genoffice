/** Keep a saved chat size usable after moving to a smaller screen. */
export function fitChatPanel(
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): { w: number; h: number } {
  const availableWidth = Math.max(1, viewportWidth - 32)
  const availableHeight = Math.max(1, viewportHeight - 96)
  const fit = (value: number, available: number, minimum: number, fallback: number) =>
    Math.round(
      Math.max(
        Math.min(minimum, available),
        Math.min(Number.isFinite(value) ? value : fallback, available),
      ),
    )
  return {
    w: fit(width, availableWidth, 460, 880),
    h: fit(height, availableHeight, 380, 660),
  }
}
