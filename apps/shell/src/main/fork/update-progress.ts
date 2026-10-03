import { spawn } from 'node:child_process'

/**
 * While an update is being installed the app is closed and the installer runs without a window, so
 * for a minute or more nothing on the screen said that anything was happening. This starts a small
 * Windows progress card, from a separate process that outlives the app: it shows "Updating…" until
 * the installer is done and the new version is running, and opens the app itself if the installer
 * finished without starting it.
 */

export interface UpdateProgressOptions {
  installerPid: number
  /** the app to start if the installer finishes without starting it */
  exePath: string
  lang: string
}

const WORDS = {
  vi: {
    title: 'Đang cập nhật GenOffice…',
    hint: 'Xin chờ một chút. GenOffice sẽ tự mở lại khi xong.',
  },
  en: {
    title: 'Updating GenOffice…',
    hint: 'One moment. GenOffice opens again by itself when it is done.',
  },
}
export const updateWords = (lang: string): { title: string; hint: string } =>
  lang === 'vi' ? WORDS.vi : WORDS.en

const quote = (text: string): string => `'${text.replace(/'/g, "''")}'`

/** The PowerShell that draws the card and watches the installer. */
export function updateProgressScript(options: UpdateProgressOptions): string {
  const words = updateWords(options.lang)
  const pid = Math.trunc(options.installerPid)
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid installer process id')
  return `$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$installerPid = ${pid}
$exe = ${quote(options.exePath)}
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'; $f.StartPosition = 'CenterScreen'; $f.TopMost = $true; $f.ShowInTaskbar = $false
$f.ClientSize = New-Object System.Drawing.Size(420, 128)
$f.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#0b1226')
$title = New-Object System.Windows.Forms.Label
$title.Text = ${quote(words.title)}; $title.ForeColor = [System.Drawing.Color]::White; $title.AutoSize = $true
$title.Font = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold); $title.Location = New-Object System.Drawing.Point(22, 30)
$hint = New-Object System.Windows.Forms.Label
$hint.Text = ${quote(words.hint)}; $hint.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#aab3c8'); $hint.AutoSize = $true
$hint.Font = New-Object System.Drawing.Font('Segoe UI', 9.5); $hint.Location = New-Object System.Drawing.Point(24, 66)
$bar = New-Object System.Windows.Forms.Panel
$bar.Size = New-Object System.Drawing.Size(140, 3); $bar.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#2b7cd3'); $bar.Location = New-Object System.Drawing.Point(-140, 125)
$f.Controls.AddRange(@($title, $hint, $bar))
$started = Get-Date; $exitedAt = $null; $x = -140; $ticks = 0
$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 40
$timer.Add_Tick({
  $script:x += 7; if ($script:x -gt 420) { $script:x = -140 }; $bar.Left = $script:x
  $script:ticks++
  if ($script:ticks % 12 -ne 0) { return }
  if (((Get-Date) - $started).TotalMinutes -gt 10) { $f.Close(); return }
  if (-not $script:exitedAt) {
    if (-not (Get-Process -Id $installerPid)) { $script:exitedAt = Get-Date }
    return
  }
  if (Get-Process -Name GenOffice) { $f.Close(); return }
  if (((Get-Date) - $script:exitedAt).TotalSeconds -gt 20) {
    if (Test-Path -LiteralPath $exe) { Start-Process -FilePath $exe }
    Start-Sleep -Seconds 2; $f.Close()
  }
})
$timer.Start()
[void]$f.ShowDialog()
`
}

/** Starts the card as a detached, hidden PowerShell. False when it could not be started. */
export function startUpdateProgress(
  options: UpdateProgressOptions,
  run: typeof spawn = spawn,
): boolean {
  try {
    const encoded = Buffer.from(updateProgressScript(options), 'utf16le').toString('base64')
    const child = run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { detached: true, stdio: 'ignore', windowsHide: true },
    )
    child.once('error', () => undefined)
    child.unref()
    return true
  } catch {
    return false
  }
}
