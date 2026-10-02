const EN = {
  openInExplorer: 'Open in File Explorer',
  openInFinder: 'Open in Finder',
  copy: 'Copy',
  paste: 'Paste',
  nothingToPaste: 'There are no files on the clipboard to paste.',
  pasteFailed: 'Could not paste: {e}',
  pastedWithFailures: 'Pasted {n}; {f} could not be pasted: {e}',
  copyFailed: 'Could not copy to the clipboard.',
}
const VI: typeof EN = {
  openInExplorer: 'Mở trong File Explorer',
  openInFinder: 'Mở trong Finder',
  copy: 'Sao chép',
  paste: 'Dán',
  nothingToPaste: 'Trong clipboard không có file nào để dán.',
  pasteFailed: 'Không dán được: {e}',
  pastedWithFailures: 'Đã dán {n}; {f} file không dán được: {e}',
  copyFailed: 'Không sao chép được vào clipboard.',
}

export const folderMenuWords = (lang: string): typeof EN => (lang === 'vi' ? VI : EN)
