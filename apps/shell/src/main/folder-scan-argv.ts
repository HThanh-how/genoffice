const FLAG = '--genoffice-scan-folder'

export function parseFolderScanArgv(argv: readonly string[], additionalData?: unknown): string[] {
  const paths: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === FLAG && argv[i + 1] && !argv[i + 1].startsWith('--')) paths.push(argv[++i])
  }
  if (additionalData && typeof additionalData === 'object') {
    const extra = (additionalData as { folderScanPaths?: unknown }).folderScanPaths
    if (Array.isArray(extra))
      for (const path of extra) if (typeof path === 'string' && path.trim()) paths.push(path)
  }
  return [...new Set(paths)]
}

export function withoutFolderScanArgs(argv: readonly string[]): string[] {
  const result: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === FLAG) {
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++
    } else result.push(argv[i])
  }
  return result
}
