import { execFile as nodeExecFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Battery percentage and battery-saver state for the indexing policy. Electron only reports
 * "on battery or not", so the rest comes from small, read-only OS queries run asynchronously at
 * low frequency (see indexing-monitor.ts). Every reader swallows its errors: a missing value
 * just means the policy is resolved without it.
 */

export interface BatteryInfo {
  /** 0..100 */
  percent?: number
  /** OS battery saver / low power mode */
  saver?: boolean
}

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean; maxBuffer: number },
) => Promise<{ stdout: string }>

export interface BatteryDeps {
  platform: NodeJS.Platform
  execFile: ExecFileFn
  readFile: (path: string) => Promise<string>
  readdir: (path: string) => Promise<string[]>
  /** %SystemRoot% on Windows */
  systemRoot?: string
}

const EXEC = { timeout: 8000, windowsHide: true, maxBuffer: 64 * 1024 } as const

/**
 * Windows: Win32_Battery for the charge, WinRT PowerManager for battery saver (both exist on
 * stock Windows PowerShell 5.1; no compilation, no wmic). Output: "<percent>|<saver status>".
 */
export const WINDOWS_BATTERY_SCRIPT =
  "$ErrorActionPreference='SilentlyContinue'; " +
  '$b=Get-CimInstance Win32_Battery | Select-Object -First 1; ' +
  '$e=try{[void][Windows.System.Power.PowerManager,Windows.System.Power,ContentType=WindowsRuntime];' +
  "[string][Windows.System.Power.PowerManager]::EnergySaverStatus}catch{''}; " +
  "('{0}|{1}' -f $b.EstimatedChargeRemaining,$e)"

function clampPercent(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : undefined
}

export function parseWindowsBattery(stdout: string): BatteryInfo {
  const [rawPercent = '', rawSaver = ''] = stdout.trim().split('|')
  const percent = rawPercent.trim() === '' ? undefined : clampPercent(Number(rawPercent))
  const saver = rawSaver.trim().toLowerCase()
  return {
    ...(percent === undefined ? {} : { percent }),
    ...(saver === 'on'
      ? { saver: true }
      : saver === 'off' || saver === 'disabled'
        ? { saver: false }
        : {}),
  }
}

export function parsePmsetBattery(stdout: string): number | undefined {
  const match = /(\d{1,3})%/.exec(stdout)
  return match ? clampPercent(Number(match[1])) : undefined
}

export function parsePmsetLowPowerMode(stdout: string): boolean | undefined {
  const match = /\blowpowermode\s+(\d)/.exec(stdout)
  return match ? match[1] === '1' : undefined
}

async function readWindows(deps: BatteryDeps): Promise<BatteryInfo> {
  const root = deps.systemRoot || 'C:\\Windows'
  const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const { stdout } = await deps.execFile(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      WINDOWS_BATTERY_SCRIPT,
    ],
    EXEC,
  )
  return parseWindowsBattery(stdout)
}

async function readMac(deps: BatteryDeps): Promise<BatteryInfo> {
  const info: BatteryInfo = {}
  try {
    const { stdout } = await deps.execFile('/usr/bin/pmset', ['-g', 'batt'], EXEC)
    const percent = parsePmsetBattery(stdout)
    if (percent !== undefined) info.percent = percent
  } catch {
    // pmset unavailable: no percentage.
  }
  try {
    const { stdout } = await deps.execFile('/usr/bin/pmset', ['-g'], EXEC)
    const saver = parsePmsetLowPowerMode(stdout)
    if (saver !== undefined) info.saver = saver
  } catch {
    // Low Power Mode state unknown.
  }
  return info
}

async function readLinux(deps: BatteryDeps): Promise<BatteryInfo> {
  const info: BatteryInfo = {}
  const base = '/sys/class/power_supply'
  try {
    for (const name of (await deps.readdir(base)).sort()) {
      const type = (await deps.readFile(`${base}/${name}/type`).catch(() => '')).trim()
      if (type !== 'Battery') continue
      const percent = clampPercent(Number((await deps.readFile(`${base}/${name}/capacity`)).trim()))
      if (percent !== undefined) {
        info.percent = percent
        break
      }
    }
  } catch {
    // No power_supply class (desktop, container): no percentage.
  }
  try {
    const { stdout } = await deps.execFile('powerprofilesctl', ['get'], EXEC)
    info.saver = stdout.trim() === 'power-saver'
  } catch {
    // power-profiles-daemon not installed: saver state unknown.
  }
  return info
}

/** Never throws; returns {} when nothing could be read. */
export async function readBattery(deps: BatteryDeps): Promise<BatteryInfo> {
  try {
    if (deps.platform === 'win32') return await readWindows(deps)
    if (deps.platform === 'darwin') return await readMac(deps)
    return await readLinux(deps)
  } catch {
    return {}
  }
}

export function realBatteryDeps(): BatteryDeps {
  return {
    platform: process.platform,
    execFile: (file, args, options) =>
      new Promise((resolve, reject) => {
        nodeExecFile(file, args, options, (error, stdout) =>
          error ? reject(error) : resolve({ stdout: String(stdout) }),
        )
      }),
    readFile: (path) => readFile(path, 'utf8'),
    readdir: (path) => readdir(path),
    systemRoot: process.env.SystemRoot,
  }
}
