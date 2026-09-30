import test from 'node:test'
import assert from 'node:assert/strict'
import { publishRelease } from './publish-fork-release.mjs'

const commit = 'a'.repeat(40)
const otherCommit = 'b'.repeat(40)
const input = {
  repository: 'HThanh-how/genoffice',
  commit,
  version: '0.11.1',
  files: ['/tmp/GenOffice-v0.11.1-macos-arm64.zip', '/tmp/manifest.json'],
}

function response(sha) {
  return { ok: true, stdout: JSON.stringify({ object: { type: 'commit', sha } }) }
}

test('creates a release at this commit and uploads this platform assets', async () => {
  const calls = []
  let refLookups = 0
  const runGh = async (args, _options = {}) => {
    calls.push(args)
    if (args[0] === 'api') {
      refLookups++
      return refLookups === 1 ? { ok: false, stderr: 'gh: Not Found (HTTP 404)' } : response(commit)
    }
    if (args[1] === 'create') return { ok: true, stdout: '' }
    if (args[1] === 'view')
      return refLookups === 1 ? { ok: false, stderr: 'Not Found' } : { ok: true, stdout: 'release' }
    return { ok: true, stdout: '' }
  }

  const tag = await publishRelease({ ...input, runGh })

  assert.equal(tag, 'v0.11.1')
  assert.deepEqual(
    calls.find((args) => args[0] === 'release' && args[1] === 'create'),
    [
      'release',
      'create',
      'v0.11.1',
      '--target',
      commit,
      '--title',
      'v0.11.1',
      '--notes',
      `Unsigned fork build for v0.11.1 (${commit}).`,
    ],
  )
  assert.deepEqual(calls.at(-1), ['release', 'upload', 'v0.11.1', ...input.files])
})

test('adds assets to an existing release only when its tag has the same commit', async () => {
  const calls = []
  const runGh = async (args) => {
    calls.push(args)
    if (args[0] === 'api') return response(commit)
    if (args[1] === 'view') return { ok: true, stdout: 'release' }
    return { ok: true, stdout: '' }
  }

  await publishRelease({ ...input, runGh })
  assert.equal(
    calls.some((args) => args[0] === 'release' && args[1] === 'create'),
    false,
  )
  assert.deepEqual(calls.at(-1), ['release', 'upload', 'v0.11.1', ...input.files])
})

test('refuses an existing tag at another commit before release changes', async () => {
  const calls = []
  const runGh = async (args) => {
    calls.push(args)
    if (args[0] === 'api') return response(otherCommit)
    throw new Error('unexpected release operation')
  }

  await assert.rejects(
    publishRelease({ ...input, runGh }),
    /already points to .*refusing to replace it/,
  )
  assert.equal(calls.length, 1)
})

test('handles two platform jobs racing to create the same release', async () => {
  let refLookups = 0
  let waited = false
  const calls = []
  const runGh = async (args) => {
    calls.push(args)
    if (args[0] === 'api') {
      refLookups++
      return refLookups === 1 ? { ok: false, stderr: 'gh: Not Found (HTTP 404)' } : response(commit)
    }
    if (args[1] === 'create') return { ok: false, stderr: 'Release already exists' }
    if (args[1] === 'view')
      return refLookups === 1 ? { ok: false, stderr: 'Not Found' } : { ok: true, stdout: 'release' }
    return { ok: true, stdout: '' }
  }

  await publishRelease({
    ...input,
    runGh,
    wait: async () => {
      waited = true
    },
  })
  assert.equal(waited, true)
  assert.deepEqual(calls.at(-1), ['release', 'upload', 'v0.11.1', ...input.files])
})

test('rejects invalid repository, commit, version, and asset metadata', async () => {
  const runGh = async () => {
    throw new Error('gh must not be called')
  }
  await assert.rejects(
    publishRelease({ ...input, repository: 'owner/repo; touch /tmp/pwned', runGh }),
    /valid owner\/repository/,
  )
  await assert.rejects(
    publishRelease({ ...input, commit: 'not-a-sha', runGh }),
    /full 40-character/,
  )
  await assert.rejects(
    publishRelease({ ...input, version: '1.2.3; echo unsafe', runGh }),
    /valid release version/,
  )
  await assert.rejects(publishRelease({ ...input, files: [], runGh }), /At least one release asset/)
})
