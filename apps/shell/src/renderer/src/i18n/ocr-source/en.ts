import type { zh } from './zh'

export const en = {
  waiting:
    '{root} is not connected (since {date}). {n} files are waiting; they resume automatically when it is back.',
  check: 'Check now',
  title: 'Drive or folder not available — will retry automatically',
  hint: 'GenOffice will check and read these files again when the location is available.',
} satisfies Record<keyof typeof zh, string>
