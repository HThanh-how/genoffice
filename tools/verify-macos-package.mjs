// Ad-hoc signing is still required for local Apple Silicon builds. Verify the
// distributed archives, not just the build tree, before CI uploads installers.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

if (process.platform !== 'darwin') throw new Error('macOS package verification requires macOS')
const archives = process.argv.slice(2).map((path) => resolve(path))
if (!archives.length || archives.some((path) => !['.zip', '.dmg'].includes(extname(path))))
  throw new Error('Usage: node tools/verify-macos-package.mjs <archive.zip|archive.dmg> [...]')

for (const archive of archives) {
  const root = mkdtempSync(join(tmpdir(), 'genoffice-package-verify-'))
  const contents = join(root, 'contents')
  let mounted = false
  try {
    if (extname(archive) === '.zip') {
      execFileSync('ditto', ['-x', '-k', archive, contents], { stdio: 'inherit' })
    } else {
      execFileSync(
        'hdiutil',
        ['attach', '-readonly', '-nobrowse', '-mountpoint', contents, archive],
        {
          stdio: 'inherit',
        },
      )
      mounted = true
    }
    execFileSync('codesign', ['--verify', '--deep', '--strict', join(contents, 'GenOffice.app')], {
      stdio: 'inherit',
    })
    console.log(`Verified macOS package signature: ${archive}`)
  } finally {
    // Do not remove a mount point if detaching fails; preserve the cleanup error.
    if (mounted) execFileSync('hdiutil', ['detach', contents], { stdio: 'inherit' })
    rmSync(root, { recursive: true, force: true })
  }
}
