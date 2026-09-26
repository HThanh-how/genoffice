import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = join(dirname(fileURLToPath(import.meta.url)), 'stage-ci-installer.mjs')
const commit = 'a'.repeat(40)
const version = JSON.parse(
  readFileSync(resolve(dirname(script), '../apps/shell/package.json'), 'utf8'),
).version

test('stages uniquely named Windows and macOS installers with verifiable provenance', () => {
  const root = mkdtempSync(join(tmpdir(), 'genoffice-ci-artifact-test-'))
  try {
    for (const [platform, arch, extensions] of [
      ['windows', 'x64', ['.exe']],
      ['macos', 'arm64', ['.dmg', '.zip']],
    ]) {
      for (const extension of extensions)
        writeFileSync(join(root, `original${extension}`), `${platform}${extension}`)
      const outputFile = join(root, `${platform}-output.txt`)
      execFileSync(process.execPath, [script, platform, arch, root], {
        env: {
          ...process.env,
          GITHUB_SHA: commit,
          GITHUB_RUN_ID: '12345',
          GITHUB_RUN_ATTEMPT: '2',
          GITHUB_REPOSITORY: 'example/genoffice',
          GITHUB_OUTPUT: outputFile,
        },
      })
      const output = Object.fromEntries(
        readFileSync(outputFile, 'utf8')
          .trim()
          .split('\n')
          .map((line) => line.split('=')),
      )
      assert.equal(output.name, `GenOffice-v${version}-${platform}-${arch}-aaaaaaaa-run12345-a2`)
      const manifest = JSON.parse(readFileSync(join(output.path, 'manifest.json'), 'utf8'))
      assert.equal(manifest.commit, commit)
      assert.equal(manifest.runUrl, 'https://github.com/example/genoffice/actions/runs/12345')
      assert.equal(manifest.signed, false)
      assert.equal(manifest.files.length, extensions.length)
      const checksums = readFileSync(join(output.path, 'SHA256SUMS'), 'utf8')
      for (const file of manifest.files) {
        assert.equal(
          createHash('sha256')
            .update(readFileSync(join(output.path, file.name)))
            .digest('hex'),
          file.sha256,
        )
        assert.ok(checksums.includes(`${file.sha256}  ${file.name}`))
      }
    }
  } finally {
    const resolvedRoot = realpathSync(root)
    const tempRelative = relative(realpathSync(tmpdir()), resolvedRoot)
    assert.ok(!tempRelative.startsWith('..') && !isAbsolute(tempRelative))
    assert.ok(basename(resolvedRoot).startsWith('genoffice-ci-artifact-test-'))
    rmSync(resolvedRoot, { recursive: true, force: true })
  }
})
