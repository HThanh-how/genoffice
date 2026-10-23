import { rootAvailability } from '../root-availability'

/** Electron events are wired at startup; the existing idle poll supplies periodic probes. */
export function watchRootAvailability(
  app: {
    on(event: 'browser-window-focus', listener: () => void): unknown
    once(event: 'will-quit', listener: () => void): unknown
    removeListener(event: 'browser-window-focus', listener: () => void): unknown
  },
  power: {
    on(event: 'resume', listener: () => void): unknown
    removeListener(event: 'resume', listener: () => void): unknown
  },
): void {
  const check = () => {
    void rootAvailability.probeDue(true)
  }
  app.on('browser-window-focus', check)
  power.on('resume', check)
  app.once('will-quit', () => {
    app.removeListener('browser-window-focus', check)
    power.removeListener('resume', check)
  })
}
