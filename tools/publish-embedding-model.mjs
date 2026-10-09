#!/usr/bin/env node
// Re-verifies a local copy of a pinned embedding model against the manifest in
// model-specs.ts and PRINTS (never runs) the commands that publish it to the two mirrors:
// the GitHub release and the d2x web root. See docs/embedding-model-hosting.md.
//
//   node --no-warnings tools/publish-embedding-model.mjs <dir> [--model a8m|a25m]
//
// <dir> holds the files at their manifest paths (tokenizer.json, onnx/model.onnx, ...) and,
// when present, the upstream LICENSE file, which is published next to the weights.
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  BEKKO_A8M,
  BEKKO_A25M,
} from '../apps/shell/src/main/document-memory/embedding/model-specs.ts'
import {
  DEFAULT_MIRROR_TEMPLATES,
  mirrorAssetName,
  mirrorReleaseTag,
} from '../apps/shell/src/main/document-memory/embedding/model-mirrors.ts'

const SPECS = { a8m: BEKKO_A8M, a25m: BEKKO_A25M }
const REPO = 'HThanh-how/genoffice'

const args = process.argv.slice(2)
const modelFlag = args.indexOf('--model')
const modelKey = modelFlag >= 0 ? args.splice(modelFlag, 2)[1] : 'a8m'
const dir = args[0] && resolve(args[0])
if (!dir || !SPECS[modelKey]) {
  console.error('usage: node tools/publish-embedding-model.mjs <dir> [--model a8m|a25m]')
  process.exit(2)
}
const spec = SPECS[modelKey]

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolveHash(hash.digest('hex')))
  })
}

let failed = false
for (const file of spec.files) {
  const path = join(dir, file.path)
  if (!existsSync(path)) {
    console.error(`MISSING   ${file.path}`)
    failed = true
    continue
  }
  const size = statSync(path).size
  const digest = await sha256(path)
  const ok = size === file.bytes && digest === file.sha256
  console.log(`${ok ? 'OK       ' : 'MISMATCH '} ${file.path}  ${size} B  sha256 ${digest}`)
  if (!ok) {
    console.error(`          expected ${file.bytes} B  sha256 ${file.sha256}`)
    failed = true
  }
}
if (failed) {
  console.error('\nRefusing to print publish commands: fix the files above first.')
  process.exit(1)
}

const tag = mirrorReleaseTag(spec.repo, spec.revision)
const stage = `./release-stage/${tag}`
const hasLicense = existsSync(join(dir, 'LICENSE'))
const assets = [
  ...spec.files.map((f) => mirrorAssetName(f.path)),
  ...(hasLicense ? ['LICENSE'] : []),
]

console.log(`\n# 1. GitHub release ${tag} (flat asset names; run from ${dir})`)
console.log(`mkdir -p ${stage}`)
for (const file of spec.files) console.log(`cp ${file.path} ${stage}/${mirrorAssetName(file.path)}`)
if (hasLicense) console.log(`cp LICENSE ${stage}/LICENSE`)
else
  console.log(
    '# WARNING: no LICENSE file in the directory; download the upstream licence and add it.',
  )
console.log(
  `gh release create ${tag} --repo ${REPO} --prerelease --latest=false --title "Embedding model ${spec.slug} @ ${spec.revision.slice(0, 10)}" ` +
    `--notes "Mirror of ${spec.repo}@${spec.revision} (${spec.license}). Verified against the sha256 pinned in model-specs.ts." ` +
    assets.map((name) => `${stage}/${name}`).join(' '),
)
console.log(
  `# re-upload a single asset later: gh release upload ${tag} --repo ${REPO} --clobber ${stage}/<asset>`,
)

const d2x = DEFAULT_MIRROR_TEMPLATES[0].replace('{repo}/{revision}/{path}', '')
console.log(
  `\n# 2. d2x web root: ${d2x}${spec.repo}/${spec.revision}/<path> (immutable, Range + Content-Length, no compression)`,
)
console.log(
  `rsync -avP --relative ${spec.files.map((f) => `./${f.path}`).join(' ')}${hasLicense ? ' ./LICENSE' : ''} \\`,
)
console.log(
  `  <user>@<d2x-host>:<web-root>/models/${spec.repo}/${spec.revision}/   # run from ${dir}`,
)
console.log(
  '# or with scp, one file at a time, after: ssh <user>@<d2x-host> mkdir -p <web-root>/models/<repo>/<revision>/onnx',
)
