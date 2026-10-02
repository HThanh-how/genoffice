import { execFile } from 'node:child_process'
import { parseClipboardFiles, type ClipboardFiles } from './folder-paste'

const TIMEOUT_MS = 8_000

type Run = (
  file: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) => Promise<{ ok: boolean; stdout: string }>

const run: Run = (file, args, env) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: TIMEOUT_MS, encoding: 'utf8', env: { ...process.env, ...env } },
      (error, stdout) => resolve({ ok: !error, stdout: typeof stdout === 'string' ? stdout : '' }),
    )
  })

// PowerShell needs a single-threaded apartment to talk to the clipboard, and UTF-8 output so
// Vietnamese file names come back whole.
const WINDOWS_READ = [
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$files=[System.Windows.Forms.Clipboard]::GetFileDropList()',
  'if($files.Count -eq 0){exit 0}',
  '$eff=5',
  "$d=[System.Windows.Forms.Clipboard]::GetData('Preferred DropEffect')",
  'if($d -is [System.IO.MemoryStream]){$b=$d.ToArray();if($b.Length -ge 4){$eff=[BitConverter]::ToInt32($b,0)}}',
  '"EFFECT=$eff"',
  '$files|ForEach-Object{$_}',
].join(';')

// the paths travel in an environment variable (JSON), never spliced into the script text
const WINDOWS_WRITE = '$p=$env:GENOFFICE_PATHS|ConvertFrom-Json;Set-Clipboard -LiteralPath $p'

const POWERSHELL = [
  '-NoProfile',
  '-NonInteractive',
  '-STA',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
]

/** The files on the system clipboard (empty when it holds none, or on a system we cannot read). */
export async function readClipboardFiles(
  platform: NodeJS.Platform = process.platform,
  exec: Run = run,
): Promise<ClipboardFiles> {
  if (platform === 'win32') {
    const out = await exec('powershell.exe', [...POWERSHELL, WINDOWS_READ])
    return out.ok ? parseClipboardFiles(out.stdout) : { paths: [], cut: false }
  }
  if (platform === 'darwin') {
    const out = await exec('osascript', [
      '-e',
      'set f to the clipboard as «class furl»',
      '-e',
      'POSIX path of f',
    ])
    return out.ok ? parseClipboardFiles(out.stdout) : { paths: [], cut: false }
  }
  return { paths: [], cut: false }
}

/** Put files on the system clipboard so Explorer / Finder can paste them. */
export async function writeClipboardFiles(
  paths: string[],
  platform: NodeJS.Platform = process.platform,
  exec: Run = run,
): Promise<boolean> {
  if (paths.length === 0) return false
  if (platform === 'win32') {
    const out = await exec('powershell.exe', [...POWERSHELL, WINDOWS_WRITE], {
      GENOFFICE_PATHS: JSON.stringify(paths),
    })
    return out.ok
  }
  if (platform === 'darwin') {
    // one file: AppleScript's clipboard takes a single file reference this way
    const out = await exec('osascript', [
      '-e',
      'on run argv',
      '-e',
      'set the clipboard to (POSIX file (item 1 of argv))',
      '-e',
      'end run',
      paths[0]!,
    ])
    return out.ok
  }
  return false
}
