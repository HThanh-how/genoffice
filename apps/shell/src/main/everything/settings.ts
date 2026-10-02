import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** What the person chose about Everything (the optional fast file-name search). */
export interface EverythingSettings {
  enabled: boolean
  /** es.exe, when it is not where it is usually found */
  path?: string
}

const DEFAULTS: EverythingSettings = { enabled: true }

export function readEverythingSettings(file: string): EverythingSettings {
  try {
    if (!existsSync(file)) return { ...DEFAULTS }
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!value || typeof value !== 'object') return { ...DEFAULTS }
    const { enabled, path } = value as Partial<EverythingSettings>
    return {
      enabled: enabled !== false,
      ...(typeof path === 'string' && path.trim() && path.length < 1024
        ? { path: path.trim() }
        : {}),
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function writeEverythingSettings(file: string, settings: EverythingSettings): void {
  writeFileSync(file, JSON.stringify(settings), 'utf8')
}
