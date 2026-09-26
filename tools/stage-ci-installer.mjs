// Give unsigned CI installers immutable, traceable download names without
// changing electron-builder's release/update-feed filenames.
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  createReadStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [platform, arch, sourceArg] = process.argv.slice(2)
const extensions =
  platform === 'windows' && arch === 'x64'
    ? ['.exe']
    : platform === 'macos' && arch === 'arm64'
      ? ['.dmg', '.zip']
      : null
if (!extensions)
  throw new Error(
    'Usage: node tools/stage-ci-installer.mjs <windows x64|macos arm64> [source-directory]',
  )

const commit = process.env.GITHUB_SHA || ''
const runId = process.env.GITHUB_RUN_ID || ''
const attempt = process.env.GITHUB_RUN_ATTEMPT || ''
const repository = process.env.GITHUB_REPOSITORY || ''
if (
  !/^[a-f0-9]{40}$/i.test(commit) ||
  !/^\d+$/.test(runId) ||
  !/^\d+$/.test(attempt) ||
  !/^[\w.-]+\/[\w.-]+$/.test(repository)
) {
  throw new Error(
    'Complete GitHub build identity is required; refusing to label an untraceable installer',
  )
}

const version = JSON.parse(readFileSync(join(repoRoot, 'apps/shell/package.json'), 'utf8')).version
if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error('Invalid shell app version')
const identity = `GenOffice-v${version}-${platform}-${arch}-${commit.slice(0, 8)}-run${runId}-a${attempt}`
const sourceDir = sourceArg ? resolve(sourceArg) : join(repoRoot, 'apps/shell/release')
const stageDir = join(sourceDir, 'ci-artifacts', identity)
mkdirSync(stageDir, { recursive: true })

const files = []
for (const extension of extensions) {
  const matches = readdirSync(sourceDir).filter(
    (name) => name.toLowerCase().endsWith(extension) && statSync(join(sourceDir, name)).isFile(),
  )
  if (matches.length !== 1)
    throw new Error(`Expected one ${extension} installer in ${sourceDir}, found ${matches.length}`)
  const name = `${identity}${extension}`
  const destination = join(stageDir, name)
  copyFileSync(join(sourceDir, matches[0]), destination)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(destination)) hash.update(chunk)
  files.push({ name, size: statSync(destination).size, sha256: hash.digest('hex') })
}

writeFileSync(
  join(stageDir, 'SHA256SUMS'),
  files.map((file) => `${file.sha256}  ${file.name}\n`).join(''),
)
writeFileSync(
  join(stageDir, 'manifest.json'),
  JSON.stringify(
    {
      product: 'GenOffice',
      version,
      platform,
      arch,
      commit,
      runId,
      attempt,
      runUrl: `https://github.com/${repository}/actions/runs/${runId}`,
      signed: false,
      files,
    },
    null,
    2,
  ) + '\n',
)

const githubOutput = process.env.GITHUB_OUTPUT
if (githubOutput) appendFileSync(githubOutput, `name=${identity}\npath=${stageDir}\n`)
console.log(`Staged ${identity}: ${files.map((file) => basename(file.name)).join(', ')}`)
