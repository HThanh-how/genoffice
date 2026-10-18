#!/usr/bin/env node
/**
 * tools/verify-mac-release.mjs — Verification gate for signed macOS releases.
 *
 * Enforces:
 *   1. Developer ID Application code signing (rejects ad-hoc and unverified certificates).
 *   2. AppleTeamID matches repository/signing configuration (rejects unauthorized team IDs).
 *   3. Strict Gatekeeper assessment (spctl --assess --type execute).
 *   4. Notarization ticket stapling on both the packaged .app bundle and the .dmg installer.
 *   5. Electron-builder original ZIP naming and latest-mac.yml auto-update feed integrity:
 *      every asset listed in the feed must exist on disk with matching file size and base64 SHA-512 digest.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

export function defaultExec(cmd, args, options = {}) {
  try {
    const res = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    })
    return { ok: true, stdout: res || '', stderr: '' }
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : '',
      status: err.status ?? 1,
      error: err,
    }
  }
}

/**
 * Validates Developer ID code signing and Apple Team ID on an app bundle.
 * Rejects ad-hoc signatures, unverified signatures, and team mismatches.
 */
export function validateCodesign({ appPath, expectedTeamId, exec = defaultExec }) {
  if (!appPath || !existsSync(appPath)) {
    throw new Error(`Target app bundle does not exist: ${appPath}`)
  }
  if (!statSync(appPath).isDirectory()) {
    throw new Error(`Target app bundle is not a directory: ${appPath}`)
  }
  if (!expectedTeamId || typeof expectedTeamId !== 'string' || !expectedTeamId.trim()) {
    throw new Error('AppleTeamID is required for signed Mac release verification')
  }
  const cleanTeamId = expectedTeamId.trim()

  // 1. Verify strict signature integrity
  const verifyRes = exec('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  if (!verifyRes.ok) {
    throw new Error(
      `codesign verification failed for ${appPath}: ${verifyRes.stderr || verifyRes.stdout || verifyRes.error?.message}`,
    )
  }

  // 2. Inspect signature details and certificates
  const infoRes = exec('codesign', ['-dv', '--verbose=4', appPath])
  if (!infoRes.ok) throw new Error(`Cannot inspect signature: ${appPath}`)
  const details = `${infoRes.stdout}\n${infoRes.stderr}`

  // Reject ad-hoc signing
  if (/Signature=adhoc/i.test(details)) {
    throw new Error(`Ad-hoc code signing is rejected for release: ${appPath}`)
  }

  // Must be signed with Developer ID Application certificate
  if (!/Authority=Developer ID Application:/i.test(details)) {
    throw new Error(`App is not signed with Developer ID Application certificate: ${appPath}`)
  }

  // Must match expected Apple Team ID
  const teamMatch = /TeamIdentifier=([A-Za-z0-9]+)/m.exec(details)
  if (!teamMatch) {
    throw new Error(`Missing or invalid TeamIdentifier in codesign details for ${appPath}`)
  }
  const actualTeamId = teamMatch[1]
  if (actualTeamId !== cleanTeamId) {
    throw new Error(
      `TeamIdentifier mismatch for ${appPath}: expected ${cleanTeamId}, got ${actualTeamId}`,
    )
  }

  return { ok: true, teamId: actualTeamId }
}

/**
 * Validates that Gatekeeper accepts the app bundle (spctl assess).
 */
export function validateGatekeeper({ appPath, exec = defaultExec }) {
  if (!appPath || !existsSync(appPath)) {
    throw new Error(`Target app bundle does not exist: ${appPath}`)
  }
  const assessRes = exec('spctl', ['--assess', '--type', 'execute', '--verbose', appPath])
  const out = `${assessRes.stdout}\n${assessRes.stderr}`
  if (!assessRes.ok || !out.includes('accepted')) {
    throw new Error(
      `spctl Gatekeeper assessment failed for ${appPath}: ${out || assessRes.error?.message}`,
    )
  }
  return { ok: true, output: out.trim() }
}

/**
 * Validates that a notarization ticket is stapled to the target (.app or .dmg).
 */
export function validateStaple({ targetPath, exec = defaultExec }) {
  if (!targetPath || !existsSync(targetPath)) {
    throw new Error(`Target does not exist for staple validation: ${targetPath}`)
  }
  const stapleRes = exec('xcrun', ['stapler', 'validate', targetPath])
  const out = `${stapleRes.stdout}\n${stapleRes.stderr}`
  if (!stapleRes.ok || !out.includes('The validate action worked!')) {
    throw new Error(
      `xcrun stapler validate failed for ${targetPath}: ${out || stapleRes.error?.message}`,
    )
  }
  return { ok: true }
}

/**
 * Parses electron-builder metadata using the same installed YAML parser as its publisher.
 */
export function parseUpdateFeed(content) {
  const feed = yaml.load(content)
  if (!feed || typeof feed !== 'object' || !Array.isArray(feed.files)) {
    throw new Error('Update feed must contain a files array')
  }
  return feed
}

/**
 * Validates latest-mac.yml update feed and verifies that original ZIP artifact
 * names are preserved and that on-disk files match feed sizes and SHA-512 hashes.
 */
export function validateMacUpdateFeed({ releaseDir, expectedVersion, ymlPath }) {
  const targetYml = ymlPath ? resolve(ymlPath) : join(resolve(releaseDir), 'latest-mac.yml')
  if (!existsSync(targetYml)) {
    throw new Error(`latest-mac.yml not found at: ${targetYml}`)
  }

  const content = readFileSync(targetYml, 'utf8')
  const feed = parseUpdateFeed(content)

  if (!feed.version) {
    throw new Error('latest-mac.yml is missing a valid "version" field')
  }

  if (expectedVersion && feed.version !== expectedVersion) {
    throw new Error(
      `Feed version mismatch: expected ${expectedVersion}, got ${feed.version} in latest-mac.yml`,
    )
  }

  if (!feed.files || feed.files.length === 0) {
    throw new Error('latest-mac.yml contains no file entries')
  }

  const dir = dirname(targetYml)
  const validatedFiles = []
  let hasZip = false

  for (const fileEntry of feed.files) {
    const filename = fileEntry.url
    // Validate electron-builder original zip naming convention (*-mac.zip)
    const originalZipPattern = /^GenOffice-[0-9][A-Za-z0-9.+-]*-mac\.zip$/
    const originalDmgPattern = /^GenOffice-[0-9][A-Za-z0-9.+-]*\.dmg$/
    if (
      typeof filename !== 'string' ||
      (!originalZipPattern.test(filename) && !originalDmgPattern.test(filename))
    ) {
      throw new Error(
        `Artifact name "${filename}" does not match electron-builder original ZIP naming convention (*-mac.zip). Retain original names for auto-update feed.`,
      )
    }

    hasZip ||= originalZipPattern.test(filename)
    const filePath = join(dir, filename)
    if (!existsSync(filePath)) {
      throw new Error(`Feed asset file referenced in latest-mac.yml missing on disk: ${filePath}`)
    }

    const fileStat = statSync(filePath)
    if (!fileStat.isFile()) throw new Error(`Feed asset is not a regular file: ${filename}`)
    if (
      fileEntry.size !== undefined &&
      fileEntry.size !== null &&
      fileStat.size !== fileEntry.size
    ) {
      throw new Error(
        `Size mismatch for ${filename}: feed lists ${fileEntry.size} bytes, actual is ${fileStat.size} bytes`,
      )
    }

    const actualSha512 = createHash('sha512').update(readFileSync(filePath)).digest('base64')

    if (actualSha512 !== fileEntry.sha512) {
      throw new Error(
        `SHA-512 hash mismatch for ${filename}:\n  feed:   ${fileEntry.sha512}\n  actual: ${actualSha512}`,
      )
    }

    validatedFiles.push({
      name: filename,
      size: fileStat.size,
      sha512: actualSha512,
    })
  }

  if (!hasZip) throw new Error('Mac update feed must contain an original updater ZIP')
  const primary = validatedFiles.find((file) => file.name === feed.path)
  if (!primary || !primary.name.endsWith('-mac.zip') || primary.sha512 !== feed.sha512) {
    throw new Error('Feed root path/sha512 must match an updater ZIP entry')
  }
  return {
    ok: true,
    version: feed.version,
    files: validatedFiles,
  }
}

/** Match the packaged identity/provider to this release before accepting the feed. */
export function validateAppMetadata({
  appPath,
  expectedVersion,
  expectedRepository,
  exec = defaultExec,
}) {
  const plist = join(appPath, 'Contents', 'Info.plist')
  for (const [key, expected] of [
    ['CFBundleIdentifier', 'com.genoffice.app'],
    ['CFBundleShortVersionString', expectedVersion],
  ]) {
    const result = exec('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])
    if (!result.ok || result.stdout.trim() !== expected)
      throw new Error(`Packaged ${key} does not match expected release identity/version`)
  }
  const provider = yaml.load(
    readFileSync(join(appPath, 'Contents', 'Resources', 'app-update.yml'), 'utf8'),
  )
  const [owner, repo] = expectedRepository.split('/')
  if (
    provider?.provider !== 'github' ||
    provider.owner !== owner ||
    provider.repo !== repo ||
    (provider.host && provider.host !== 'github.com') ||
    (provider.protocol && provider.protocol !== 'https')
  ) {
    throw new Error('Packaged update provider does not match the fork release repository')
  }
  return { ok: true }
}

/**
 * Full Mac release verification orchestration.
 */
export function verifyMacRelease({
  releaseDir = 'apps/shell/release',
  appPath,
  dmgPath,
  expectedTeamId = process.env.APPLE_TEAM_ID,
  expectedVersion = JSON.parse(
    readFileSync(new URL('../apps/shell/package.json', import.meta.url), 'utf8'),
  ).version,
  expectedRepository = 'HThanh-how/genoffice',
  exec = defaultExec,
} = {}) {
  const resolvedReleaseDir = resolve(releaseDir)
  if (!existsSync(resolvedReleaseDir)) {
    throw new Error(`Release directory does not exist: ${resolvedReleaseDir}`)
  }

  // 1. Locate app bundle
  let resolvedAppPath = appPath ? resolve(appPath) : null
  if (!resolvedAppPath) {
    const findApp = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name.endsWith('.app')) return full
          const nested = findApp(full)
          if (nested) return nested
        }
      }
      return null
    }
    resolvedAppPath = findApp(resolvedReleaseDir)
  }
  if (!resolvedAppPath || !existsSync(resolvedAppPath)) {
    throw new Error(`No .app bundle found under release directory: ${resolvedReleaseDir}`)
  }

  // 2. Locate DMG installer
  let resolvedDmgPath = dmgPath ? resolve(dmgPath) : null
  if (!resolvedDmgPath) {
    const dmgs = readdirSync(resolvedReleaseDir).filter((f) => f.endsWith('.dmg'))
    if (dmgs.length === 0) {
      throw new Error(`No .dmg file found in release directory: ${resolvedReleaseDir}`)
    }
    resolvedDmgPath = join(resolvedReleaseDir, dmgs[0])
  }
  if (!resolvedDmgPath || !existsSync(resolvedDmgPath)) {
    throw new Error(`DMG file does not exist: ${resolvedDmgPath}`)
  }

  validateAppMetadata({ appPath: resolvedAppPath, expectedVersion, expectedRepository, exec })

  // 3. Verify Developer ID codesign & AppleTeamID, reject ad-hoc
  console.log(`[verify-mac] Validating codesign and Team ID on: ${resolvedAppPath}`)
  const codesignResult = validateCodesign({
    appPath: resolvedAppPath,
    expectedTeamId,
    exec,
  })

  // 4. Verify Gatekeeper spctl assessment
  console.log(`[verify-mac] Validating spctl Gatekeeper on: ${resolvedAppPath}`)
  const gatekeeperResult = validateGatekeeper({
    appPath: resolvedAppPath,
    exec,
  })

  // 5. Verify notarization ticket stapled to .app
  console.log(`[verify-mac] Validating notarization staple on .app: ${resolvedAppPath}`)
  const appStapleResult = validateStaple({
    targetPath: resolvedAppPath,
    exec,
  })

  // 6. Verify notarization ticket stapled to .dmg
  console.log(`[verify-mac] Validating notarization staple on .dmg: ${resolvedDmgPath}`)
  const dmgStapleResult = validateStaple({
    targetPath: resolvedDmgPath,
    exec,
  })

  // 7. Verify feed matching original ZIP names and asset hashes
  console.log(
    `[verify-mac] Validating latest-mac.yml feed and asset hashes in: ${resolvedReleaseDir}`,
  )
  const feedResult = validateMacUpdateFeed({
    releaseDir: resolvedReleaseDir,
    expectedVersion,
  })

  console.log('[verify-mac] All Mac release verifications PASSED:')
  console.log(`  - Developer ID / Team ID: ${codesignResult.teamId}`)
  console.log(`  - Gatekeeper: ${gatekeeperResult.output.split('\n')[0]}`)
  console.log('  - .app notarization staple: Valid')
  console.log('  - .dmg notarization staple: Valid')
  console.log(`  - Update feed version: ${feedResult.version}`)
  for (const f of feedResult.files) {
    console.log(`  - Feed asset: ${f.name} (${f.size} bytes, sha512: ${f.sha512.slice(0, 16)}...)`)
  }

  return {
    ok: true,
    codesign: codesignResult,
    gatekeeper: gatekeeperResult,
    appStaple: appStapleResult,
    dmgStaple: dmgStapleResult,
    feed: feedResult,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const releaseDir =
      process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '../apps/shell/release')
    const teamId = process.env.APPLE_TEAM_ID
    if (!teamId) {
      console.error('[verify-mac] ERROR: APPLE_TEAM_ID environment variable is required')
      process.exit(1)
    }
    verifyMacRelease({ releaseDir, expectedTeamId: teamId })
  } catch (err) {
    console.error(`[verify-mac] FAILED: ${err.message}`)
    process.exit(1)
  }
}
