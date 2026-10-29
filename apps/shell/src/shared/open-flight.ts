/**
 * Opening a file from Home: its icon flies up to the new tab in the strip while the tab grows out
 * of the icon. Home stays in front for the length of the flight, then the editor takes over, so the
 * main process and the renderer share this one number.
 */
export const OPEN_FLIGHT_MS = 260
