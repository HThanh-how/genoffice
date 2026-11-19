import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export type DownloadNetwork = 'offline' | 'metered' | 'online' | 'unknown'
async function windowsCost(): Promise<string> {
  const command =
    '[Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]::GetInternetConnectionProfile().GetConnectionCost().NetworkCostType.ToString()'
  return (
    await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 },
    )
  ).stdout.trim()
}

/** Best effort OS cost hint. A manual Download action remains available on metered networks. */
export async function downloadNetwork(
  online: boolean,
  platform: string = process.platform,
  probe: () => Promise<string> = windowsCost,
): Promise<DownloadNetwork> {
  if (!online) return 'offline'
  if (platform !== 'win32') return 'online'
  try {
    const cost = await probe()
    if (cost === 'Fixed' || cost === 'Variable') return 'metered'
    return cost === 'Unrestricted' ? 'online' : 'unknown'
  } catch {
    return 'unknown'
  }
}
