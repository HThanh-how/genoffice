import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SHA_PATTERN = /^[a-f0-9]{40}$/i

function validateIdentity({ repository, commit, version }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? ''))
    throw new Error('GITHUB_REPOSITORY must be a valid owner/repository name')
  if (!SHA_PATTERN.test(commit ?? ''))
    throw new Error('GITHUB_SHA must be a full 40-character commit SHA')
  if (!VERSION_PATTERN.test(version ?? ''))
    throw new Error('Shell package version is not a valid release version')
  return `v${version}`
}

async function defaultRunGh(args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    })
    return { ok: true, stdout: stdout.trim() }
  } catch (error) {
    const secret =
      process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_ENTERPRISE_TOKEN
    const stderr = String(error.stderr || error.message || '').replaceAll(
      secret || '\0',
      '[redacted]',
    )
    if (allowFailure) return { ok: false, stderr }
    throw new Error(`gh ${args[0]} failed: ${stderr.trim()}`, { cause: error })
  }
}

async function lookupTagCommit(repository, tag, runGh) {
  const ref = await runGh(['api', `repos/${repository}/git/ref/tags/${tag}`], {
    allowFailure: true,
  })
  if (!ref.ok) {
    if (/HTTP 404|Not Found/i.test(ref.stderr)) return null
    throw new Error(`Could not check Git tag ${tag}: ${ref.stderr.trim()}`)
  }

  let object
  try {
    object = JSON.parse(ref.stdout).object
  } catch {
    throw new Error(`GitHub returned an invalid response for tag ${tag}`)
  }
  for (let depth = 0; depth < 10; depth++) {
    if (object.type === 'commit') return object.sha
    if (object.type !== 'tag' || !SHA_PATTERN.test(object.sha ?? ''))
      throw new Error(`Git tag ${tag} does not resolve to a commit`)
    const annotated = await runGh(['api', `repos/${repository}/git/tags/${object.sha}`])
    try {
      object = JSON.parse(annotated.stdout).object
    } catch {
      throw new Error(`GitHub returned an invalid annotated tag for ${tag}`)
    }
  }
  throw new Error(`Git tag ${tag} has too many nested annotated tags`)
}

export async function publishRelease({
  repository,
  commit,
  version,
  files,
  runGh = defaultRunGh,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const tag = validateIdentity({ repository, commit, version })
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    files.some((file) => typeof file !== 'string' || !file)
  )
    throw new Error('At least one release asset path is required')

  let tagCommit = await lookupTagCommit(repository, tag, runGh)
  if (tagCommit && tagCommit.toLowerCase() !== commit.toLowerCase())
    throw new Error(
      `Release tag ${tag} already points to ${tagCommit}, not this build commit ${commit}; refusing to replace it`,
    )

  let releaseExists = (await runGh(['release', 'view', tag], { allowFailure: true })).ok
  if (!releaseExists) {
    const created = await runGh(
      [
        'release',
        'create',
        tag,
        '--target',
        commit,
        '--title',
        tag,
        '--notes',
        `Unsigned fork build for ${tag} (${commit}).`,
      ],
      { allowFailure: true },
    )
    if (!created.ok) {
      // The other platform workflow may create the same tag and release concurrently.
      for (let attempt = 0; attempt < 5; attempt++) {
        await wait(1000 * (attempt + 1))
        tagCommit = await lookupTagCommit(repository, tag, runGh)
        if (tagCommit && tagCommit.toLowerCase() !== commit.toLowerCase())
          throw new Error(
            `Release tag ${tag} was concurrently created at ${tagCommit}, not this build commit ${commit}; refusing to replace it`,
          )
        releaseExists = (await runGh(['release', 'view', tag], { allowFailure: true })).ok
        if (releaseExists) break
      }
      if (!releaseExists)
        throw new Error(`Could not create release ${tag}: ${created.stderr.trim()}`)
    } else {
      releaseExists = true
    }
  }
  if (!releaseExists)
    throw new Error(
      `Git tag ${tag} points to this commit, but GitHub Release ${tag} was not created`,
    )

  const actualCommit = await lookupTagCommit(repository, tag, runGh)
  if (!actualCommit || actualCommit.toLowerCase() !== commit.toLowerCase())
    throw new Error(
      `Release tag ${tag} no longer points to this build commit; refusing to upload assets`,
    )
  await runGh(['release', 'upload', tag, ...files])
  return tag
}

async function main() {
  const [assetDirectory, extra] = process.argv.slice(2)
  if (!assetDirectory || extra)
    throw new Error('Usage: node tools/publish-fork-release.mjs <staged-asset-directory>')
  const directory = resolve(assetDirectory)
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  const pkg = JSON.parse(await readFile(join(repoRoot, 'apps/shell/package.json'), 'utf8'))
  const repository = process.env.GITHUB_REPOSITORY
  const commit = process.env.GITHUB_SHA
  if (manifest.version !== pkg.version || manifest.commit?.toLowerCase() !== commit?.toLowerCase())
    throw new Error('Staged installer manifest does not match this workflow version and commit')
  const names = [...manifest.files.map((file) => file.name), 'SHA256SUMS', 'manifest.json']
  const files = []
  for (const name of names) {
    if (name !== name.split(/[\\/]/).at(-1) || name === '.' || name === '..')
      throw new Error(`Invalid release asset filename in manifest: ${name}`)
    const path = join(directory, name)
    if (!(await stat(path)).isFile()) throw new Error(`Missing staged release asset: ${name}`)
    files.push(path)
  }
  const actualFiles = (await readdir(directory)).filter(
    (name) => name !== 'manifest.json' && name !== 'SHA256SUMS',
  )
  if (
    actualFiles.length !== manifest.files.length ||
    actualFiles.some((name) => !manifest.files.some((file) => file.name === name))
  )
    throw new Error('Staged directory contains files that are not listed in manifest.json')
  // Both platform workflows share one Release; give metadata distinct names.
  const suffix = `${manifest.platform}-${manifest.arch}`
  if (!/^(macos-arm64|windows-x64)$/.test(suffix)) throw new Error('Invalid platform manifest')
  for (const name of ['SHA256SUMS', 'manifest.json']) {
    const source = join(directory, name)
    const destination = join(directory, `${suffix}-${name}`)
    await copyFile(source, destination)
    files[files.indexOf(source)] = destination
  }
  const tag = await publishRelease({ repository, commit, version: pkg.version, files })
  console.log(`Published ${files.length} assets to ${repository} release ${tag}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
