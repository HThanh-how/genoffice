import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import yaml from 'js-yaml'
import {
  validateMacUpdateFeed,
  validateCodesign,
  validateAppMetadata,
} from './verify-mac-release.mjs'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'genoffice-release-regression-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const app = join(dir, 'GenOffice.app')
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
  const zip = 'GenOffice-0.11.117-arm64-mac.zip'
  const dmg = 'GenOffice-0.11.117-arm64.dmg'
  writeFileSync(join(dir, zip), 'signed notarized zip fixture')
  writeFileSync(join(dir, dmg), 'signed dmg fixture')
  const entry = (name) => ({
    url: name,
    size: readFileSync(join(dir, name)).length,
    sha512: createHash('sha512')
      .update(readFileSync(join(dir, name)))
      .digest('base64'),
  })
  const feed = {
    version: '0.11.117',
    files: [entry(zip), entry(dmg)],
    path: zip,
    sha512: entry(zip).sha512,
  }
  const save = () => writeFileSync(join(dir, 'latest-mac.yml'), yaml.dump(feed))
  save()
  writeFileSync(
    join(app, 'Contents', 'Resources', 'app-update.yml'),
    yaml.dump({ provider: 'github', owner: 'HThanh-how', repo: 'genoffice' }),
  )
  return { dir, app, zip, dmg, feed, save }
}

test('accepts real electron-builder mixed ZIP and DMG feeds, checks each digest', (t) => {
  const f = fixture(t)
  assert.equal(
    validateMacUpdateFeed({ releaseDir: f.dir, expectedVersion: '0.11.117' }).files.length,
    2,
  )
  writeFileSync(join(f.dir, f.dmg), 'corrupted artifact')
  assert.throws(() => validateMacUpdateFeed({ releaseDir: f.dir }), /Size mismatch|hash mismatch/)
})

test('rejects stale version, mismatched root metadata and feeds without updater ZIP', (t) => {
  const f = fixture(t)
  assert.throws(
    () => validateMacUpdateFeed({ releaseDir: f.dir, expectedVersion: '0.11.118' }),
    /version mismatch/,
  )
  f.feed.sha512 = 'wrong'
  f.save()
  assert.throws(() => validateMacUpdateFeed({ releaseDir: f.dir }), /root path\/sha512/)
  f.feed.files.shift()
  f.feed.path = f.dmg
  f.feed.sha512 = f.feed.files[0].sha512
  f.save()
  assert.throws(() => validateMacUpdateFeed({ releaseDir: f.dir }), /updater ZIP/)
})

test('rejects feed traversal and malformed entries instead of silently dropping them', (t) => {
  const f = fixture(t)
  f.feed.files.push({ url: '../GenOffice-0.11.117-mac.zip', sha512: 'bad' })
  f.save()
  assert.throws(() => validateMacUpdateFeed({ releaseDir: f.dir }), /Artifact name/)
  f.feed.files.pop()
  f.feed.files.push({ size: 4 })
  f.save()
  assert.throws(() => validateMacUpdateFeed({ releaseDir: f.dir }), /Artifact name/)
})

test('rejects ad-hoc signatures, wrong teams and failed inspection despite integrity success', (t) => {
  const f = fixture(t)
  const inspect = (details) => (_cmd, args) => ({
    ok: true,
    stdout: '',
    stderr: args[0] === '-dv' ? details : '',
  })
  assert.throws(
    () =>
      validateCodesign({
        appPath: f.app,
        expectedTeamId: 'TEAM123',
        exec: inspect('Signature=adhoc\n'),
      }),
    /Ad-hoc/,
  )
  assert.throws(
    () =>
      validateCodesign({
        appPath: f.app,
        expectedTeamId: 'TEAM123',
        exec: inspect('Authority=Developer ID Application: Example\nTeamIdentifier=OTHER\n'),
      }),
    /mismatch/,
  )
  assert.throws(
    () =>
      validateCodesign({
        appPath: f.app,
        expectedTeamId: 'TEAM123',
        exec: (_cmd, args) => ({ ok: args[0] !== '-dv', stdout: '', stderr: '' }),
      }),
    /Cannot inspect/,
  )
  assert.equal(
    validateCodesign({
      appPath: f.app,
      expectedTeamId: 'TEAM123',
      exec: inspect('Authority=Developer ID Application: Example\nTeamIdentifier=TEAM123\n'),
    }).teamId,
    'TEAM123',
  )
})

test('packaged version, bundle identifier and fork feed must agree', (t) => {
  const f = fixture(t)
  const exec = (_cmd, args) => ({
    ok: true,
    stdout: args[1].includes('CFBundleIdentifier') ? 'com.genoffice.app\n' : '0.11.117\n',
  })
  const input = {
    appPath: f.app,
    expectedVersion: '0.11.117',
    expectedRepository: 'HThanh-how/genoffice',
    exec,
  }
  assert.equal(validateAppMetadata(input).ok, true)
  assert.throws(() => validateAppMetadata({ ...input, expectedVersion: '0.11.118' }), /version/)
  writeFileSync(
    join(f.app, 'Contents', 'Resources', 'app-update.yml'),
    yaml.dump({ provider: 'github', owner: 'genspark-ai', repo: 'genoffice' }),
  )
  assert.throws(() => validateAppMetadata(input), /repository/)
})

test('post-package DMG stapling cannot invalidate the signed lane ZIP-only feed', (t) => {
  const f = fixture(t)
  f.feed.files = f.feed.files.filter((file) => file.url === f.zip)
  f.save()
  const hook = { exports: {} }
  const calls = []
  vm.runInNewContext(
    readFileSync(new URL('../apps/shell/build/notarize-dmg.js', import.meta.url), 'utf8'),
    {
      exports: hook.exports,
      process: { platform: 'darwin', env: { APPLE_KEYCHAIN_PROFILE: 'test-profile' } },
      console,
      require: () => ({
        execFileSync: (_cmd, args) => {
          calls.push(args)
          if (args[0] === 'stapler') writeFileSync(join(f.dir, f.dmg), 'stapled dmg changes bytes')
        },
      }),
    },
  )
  hook.exports.default({ artifactPaths: [join(f.dir, f.dmg), join(f.dir, f.zip)] })
  assert.deepEqual(
    calls.map((args) => args[0]),
    ['notarytool', 'stapler'],
  )
  assert.equal(validateMacUpdateFeed({ releaseDir: f.dir }).files.length, 1)
})

test('workflow prepares all editors/native assets and uploads Mac artifacts only after verification', () => {
  const workflow = yaml.load(
    readFileSync(new URL('../.github/workflows/release-updates.yml', import.meta.url), 'utf8'),
  )
  const steps = workflow.jobs.macos.steps
  const build = steps.findIndex((step) => step.run?.includes('npm run dist:mac'))
  const verify = steps.findIndex((step) => step.run?.includes('node tools/verify-mac-release.mjs'))
  const upload = steps.findIndex((step) => step.run?.includes('gh release upload'))
  assert.match(steps[build].run, /build:all/)
  assert.match(steps[build].run, /native:build:universal/)
  assert.match(steps[build].run, /--publish never/)
  assert.ok(build < verify && verify < upload)
  assert.equal(workflow.jobs.macos.needs, 'prepare')
  assert.match(workflow.jobs.publish.if, /always\(\)/)
})

test('release preparation reuses drafts, verifies new tags, and refuses published releases', (t) => {
  const f = fixture(t)
  const workflow = yaml.load(
    readFileSync(new URL('../.github/workflows/release-updates.yml', import.meta.url), 'utf8'),
  )
  const script = workflow.jobs.prepare.steps.find((step) =>
    step.name?.startsWith('Create private draft'),
  ).run
  const mockGh = join(f.dir, 'gh')
  const log = join(f.dir, 'calls.jsonl')
  writeFileSync(
    mockGh,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_TEST_LOG, JSON.stringify(args) + String.fromCharCode(10));
if (args[1] === 'view') {
  if (process.env.GH_TEST_STATE === 'missing') process.exit(1);
  process.stdout.write(process.env.GH_TEST_STATE === 'draft' ? 'true' : 'false');
} else if (args[1] !== 'create') process.exit(2);
`,
  )
  chmodSync(mockGh, 0o755)
  for (const state of ['draft', 'missing', 'published']) {
    writeFileSync(log, '')
    const result = spawnSync('bash', ['-e', '-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${f.dir}:${process.env.PATH}`,
        GH_TEST_LOG: log,
        GH_TEST_STATE: state,
        GITHUB_REF_NAME: 'v0.11.117',
        GITHUB_REPOSITORY: 'HThanh-how/genoffice',
      },
    })
    assert.equal(result.status, state === 'published' ? 1 : 0, result.stderr)
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    assert.ok(
      calls.every((args) => args.includes('--repo') && args.includes('HThanh-how/genoffice')),
    )
    const creates = calls.filter((args) => args[1] === 'create')
    assert.equal(creates.length, state === 'missing' ? 1 : 0)
    if (creates.length) assert.ok(creates[0].includes('--verify-tag'))
  }
})
