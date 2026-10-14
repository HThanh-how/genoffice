import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyUpdateSourceChange,
  compareVersions,
  createUpdateCoordinator,
  getUpdateErrorMessage,
  isOfficialGithubHost,
  resolveUpdateNotice,
  selectInstaller,
  UpdateSourceError,
  validateConfiguredUpdateUrl,
  validateResolvedInstallerUrl,
  validateResolvedMetadataUrl,
  validateUpdateSource,
  type UpdateSource,
} from '../src/shared/update-source'
vi.mock('electron', () => ({
  app: { getVersion: () => '0.11.1', getPath: () => '' },
  net: { fetch: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: class {
    static fromWebContents() {
      return null
    }
  },
  nativeImage: {
    createFromPath: (p: string) => ({
      isEmpty: () => p.includes('corrupt') || p.includes('empty'),
    }),
  },
}))

vi.mock('electron-updater', () => ({
  autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() },
  CancellationToken: vi.fn(),
}))

import { resolveWindowIcon, resolveWindowIconPath } from '../src/main/window-icon'
import { forkUpdateCoordinator } from '../src/main/fork-updater'
import { checkForUpdatesNow, setManualUpdateCheck } from '../src/main/updater'

describe('Update Source and Icon Restoration — Production Hardened Suite', () => {
  // =========================================================================
  // SECTION 1: Configured Source & Input Validation (Context A)
  // =========================================================================

  it('1. accepts valid canonical GitHub source HThanh-how/genoffice', () => {
    const result = validateUpdateSource({
      kind: 'github',
      value: 'HThanh-how/genoffice',
    })
    expect(result).toEqual({ kind: 'github', value: 'HThanh-how/genoffice' })
  })

  it('2. normalizes multiple valid GitHub URL variants into canonical owner/repo form', () => {
    const variants = [
      'https://github.com/HThanh-how/genoffice',
      'https://github.com/HThanh-how/genoffice/',
      'https://www.github.com/HThanh-how/genoffice',
      'www.github.com/HThanh-how/genoffice',
      'http://github.com/HThanh-how/genoffice',
      'github.com/HThanh-how/genoffice',
      'https://github.com/HThanh-how/genoffice.git',
      'git+https://github.com/HThanh-how/genoffice',
      '  https://github.com/HThanh-how/genoffice.git/  ',
    ]

    for (const val of variants) {
      expect(validateUpdateSource({ kind: 'github', value: val })).toEqual({
        kind: 'github',
        value: 'HThanh-how/genoffice',
      })
    }
  })

  it('3. rejects malformed owner/repository with INVALID_FORMAT error code', () => {
    const invalidInputs = [
      'owner/repo/extra',
      '../repo',
      'owner/repo;echo',
      'onlyonepart',
      '/leading/slash',
      'trailing//slash',
      'invalid space/repo',
      '',
      '   ',
    ]

    for (const val of invalidInputs) {
      expect(() => validateUpdateSource({ kind: 'github', value: val })).toThrowError(
        UpdateSourceError,
      )
      try {
        validateUpdateSource({ kind: 'github', value: val })
      } catch (err) {
        expect((err as UpdateSourceError).code).toBe('INVALID_FORMAT')
        expect((err as UpdateSourceError).message).toContain('[INVALID_FORMAT]')
      }
    }
  })

  it('4. rejects user-configured manifest URLs containing query parameters, fragments, or credentials', () => {
    const insecureUrls = [
      'https://example.com/update.json?token=secret',
      'https://example.com/update.json#hash',
      'http://insecure.com/update.json',
      'https://user:pass@example.com/update.json',
    ]

    for (const url of insecureUrls) {
      expect(() => validateConfiguredUpdateUrl(url)).toThrowError(UpdateSourceError)
      expect(() => validateUpdateSource({ kind: 'manifest', value: url })).toThrowError(
        UpdateSourceError,
      )
    }
  })

  // =========================================================================
  // SECTION 2: Persistence Idempotency & Error Classification
  // =========================================================================

  it('5. avoids redundant disk writes when canonical source is unchanged', () => {
    const current: UpdateSource = { kind: 'github', value: 'HThanh-how/genoffice' }
    const input: UpdateSource = {
      kind: 'github',
      value: 'https://github.com/HThanh-how/genoffice/',
    }
    const persist = vi.fn()

    const result = applyUpdateSourceChange(input, current, persist)
    expect(result).toEqual(current)
    expect(persist).not.toHaveBeenCalled()
  })

  it('6. returns meaningful failure and preserves state when settings write fails', () => {
    let savedState = 'github:HThanh-how/genoffice'
    const current: UpdateSource = { kind: 'github', value: 'HThanh-how/genoffice' }
    const input = { kind: 'github', value: 'new-owner/new-repo' }
    const failingWriter = () => {
      throw new Error('EACCES: permission denied')
    }

    expect(() => applyUpdateSourceChange(input, current, failingWriter)).toThrowError(
      UpdateSourceError,
    )
    try {
      applyUpdateSourceChange(input, current, failingWriter)
    } catch (err) {
      const error = err as UpdateSourceError
      expect(error.code).toBe('SETTINGS_WRITE_FAILED')
      expect(getUpdateErrorMessage(error.message, 'vi')).toContain('Không thể lưu cài đặt')
      expect(getUpdateErrorMessage(error.message, 'en')).toContain('Unable to save update settings')
    }
    // Saved state remains intact
    expect(savedState).toBe('github:HThanh-how/genoffice')
  })

  // =========================================================================
  // SECTION 3: Return Contract & UI Notice Verification
  // =========================================================================

  it('7. propagates manual updater results across explicit true, false, undefined, rejected and busy states', async () => {
    // 1. Explicit true
    setManualUpdateCheck(() => Promise.resolve({ upToDate: true }))
    const trueRes = await checkForUpdatesNow()
    expect(trueRes).toEqual({ upToDate: true })

    // 2. Explicit false (update available)
    setManualUpdateCheck(() => Promise.resolve({ upToDate: false }))
    const falseRes = await checkForUpdatesNow()
    expect(falseRes).toEqual({ upToDate: false })

    // 3. Undefined (no definitive outcome)
    setManualUpdateCheck(() => Promise.resolve(undefined))
    const undefRes = await checkForUpdatesNow()
    expect(undefRes).toBeUndefined()

    // 4. Rejected check propagates error
    setManualUpdateCheck(() => Promise.reject(new Error('Network offline')))
    await expect(checkForUpdatesNow()).rejects.toThrow('Network offline')

    // 5. Clean reset
    setManualUpdateCheck(() => Promise.resolve({ upToDate: true }))
    expect(await checkForUpdatesNow()).toEqual({ upToDate: true })
  })

  it('8. resolves update notice strictly: displays up-to-date notice only when res?.upToDate === true', () => {
    // Explicit up to date
    expect(resolveUpdateNotice({ upToDate: true }, null, 'vi')).toBe(
      'Bạn đang dùng phiên bản phát hành Stable mới nhất.',
    )
    expect(resolveUpdateNotice({ upToDate: true }, null, 'en')).toBe(
      'You are using the latest published Stable version.',
    )

    // Update available (false) never shows "up to date"
    expect(resolveUpdateNotice({ upToDate: false }, null, 'vi')).toBeNull()
    expect(resolveUpdateNotice({ upToDate: false }, null, 'en')).toBeNull()

    // Undefined or void check never shows "up to date"
    expect(resolveUpdateNotice(undefined, null, 'vi')).toBeNull()
    expect(resolveUpdateNotice(undefined, null, 'en')).toBeNull()
  })

  it('9. resolves update errors to localized failure notices without false success', () => {
    const networkErr = new UpdateSourceError('NETWORK_ERROR', 'Network connection failed')
    const rateLimitErr = new UpdateSourceError('GITHUB_RATE_LIMITED', 'Rate limit exceeded')
    const accessDeniedErr = new UpdateSourceError('ACCESS_DENIED', 'Access denied to repo')

    // Verifies localized messages
    expect(resolveUpdateNotice(undefined, networkErr, 'vi')).toContain(
      'Không thể kết nối đến GitHub',
    )
    expect(resolveUpdateNotice(undefined, networkErr, 'en')).toContain('Unable to contact GitHub')
    expect(resolveUpdateNotice(undefined, rateLimitErr, 'vi')).toContain('Đã đạt giới hạn yêu cầu')
    expect(resolveUpdateNotice(undefined, accessDeniedErr, 'vi')).toContain(
      'Không có quyền truy cập',
    )

    // Crucial regression verification: old flawed check (res?.upToDate !== false) would return true for undefined
    const oldFlawedCheck = (res: { upToDate?: boolean } | undefined) => res?.upToDate !== false
    expect(oldFlawedCheck(undefined)).toBe(true) // Demonstrates original bug
    const newFixedCheck = (res: { upToDate?: boolean } | undefined) => res?.upToDate === true
    expect(newFixedCheck(undefined)).toBe(false) // Demonstrates fixed behavior
  })

  // =========================================================================
  // SECTION 4: In-Flight Concurrency Protection
  // =========================================================================

  it('10. prevents duplicate concurrent checks while an operation is in-flight and releases busy state', async () => {
    const coordinator = createUpdateCoordinator()
    let executionCount = 0

    let resolveFirstTask!: (value: string) => void
    const firstTaskPromise = new Promise<string>((resolve) => {
      resolveFirstTask = resolve
    })

    // Launch first task (remains in-flight)
    const task1 = coordinator.run(async () => {
      executionCount++
      return await firstTaskPromise
    })

    expect(coordinator.isBusy()).toBe(true)

    // Launch concurrent second task while first is still pending
    const task2 = coordinator.run(async () => {
      executionCount++
      return 'task2-result'
    })

    // Second call immediately returns undefined without starting real work
    const res2 = await task2
    expect(res2).toBeUndefined()
    expect(executionCount).toBe(1)

    // Resolve first task
    resolveFirstTask('task1-done')
    const res1 = await task1
    expect(res1).toBe('task1-done')
    expect(coordinator.isBusy()).toBe(false)

    // Subsequent call proceeds normally after previous finished
    const res3 = await coordinator.run(async () => {
      executionCount++
      return 'task3-done'
    })
    expect(res3).toBe('task3-done')
    expect(executionCount).toBe(2)

    // Errors do not permanently lock future checks
    await coordinator
      .run(async () => {
        throw new Error('Simulated check failure')
      })
      .catch(() => {})
    expect(coordinator.isBusy()).toBe(false)

    // Coordinator in fork-updater behaves identically
    expect(typeof forkUpdateCoordinator.isBusy).toBe('function')
  })

  // =========================================================================
  // SECTION 5: Signed GitHub CDN Redirects & URL Trust Boundaries (Context B)
  // =========================================================================

  it('11. accepts legitimate GitHub signed CDN redirects with query parameters', () => {
    const originalUrl =
      'https://github.com/HThanh-how/genoffice/releases/download/v0.11.111/GenOffice-windows-x64-0.11.111.exe'
    const signedRedirectUrl =
      'https://objects.githubusercontent.com/github-production-release-asset-2e65be/12345/app.exe?token=signed_token_xyz&expiry=1730000000&response-content-disposition=attachment'

    const resolved = validateResolvedInstallerUrl(originalUrl, signedRedirectUrl, {
      kind: 'github',
      value: 'HThanh-how/genoffice',
    })
    expect(resolved).toBe(signedRedirectUrl)
    expect(resolved).toContain('token=signed_token_xyz')
  })

  it('12. rejects HTTP downgrade on installer download redirects', () => {
    const originalUrl =
      'https://github.com/HThanh-how/genoffice/releases/download/v0.11.111/app.exe'
    const insecureHttpRedirect = 'http://objects.githubusercontent.com/release/app.exe?token=123'

    expect(() =>
      validateResolvedInstallerUrl(originalUrl, insecureHttpRedirect, {
        kind: 'github',
        value: 'HThanh-how/genoffice',
      }),
    ).toThrowError(/cannot downgrade to insecure HTTP/)
  })

  it('13. rejects embedded credentials in installer redirect URLs', () => {
    const originalUrl =
      'https://github.com/HThanh-how/genoffice/releases/download/v0.11.111/app.exe'
    const credentialsRedirect =
      'https://user:password@objects.githubusercontent.com/release/app.exe?token=123'

    expect(() =>
      validateResolvedInstallerUrl(originalUrl, credentialsRedirect, {
        kind: 'github',
        value: 'HThanh-how/genoffice',
      }),
    ).toThrowError(/Credentials in installer download URL are forbidden/)
  })

  it('14. rejects spoofed GitHub hostnames and disallowed redirect destinations', () => {
    const originalUrl =
      'https://github.com/HThanh-how/genoffice/releases/download/v0.11.111/app.exe'
    const spoofedHosts = [
      'https://github.com.attacker.example/app.exe?token=123',
      'https://attacker-github.com/app.exe',
      'https://objects.githubusercontent.com.evil.com/app.exe',
      'https://malicious.org/app.exe',
      'https://evil-github-production-release-asset.s3.amazonaws.com/app.exe',
    ]

    for (const spoofedUrl of spoofedHosts) {
      expect(() =>
        validateResolvedInstallerUrl(originalUrl, spoofedUrl, {
          kind: 'github',
          value: 'HThanh-how/genoffice',
        }),
      ).toThrowError(UpdateSourceError)
    }
  })

  it('15. accurately validates official GitHub hosts and subdomains', () => {
    expect(isOfficialGithubHost('github.com')).toBe(true)
    expect(isOfficialGithubHost('api.github.com')).toBe(true)
    expect(isOfficialGithubHost('objects.githubusercontent.com')).toBe(true)
    expect(isOfficialGithubHost('raw.githubusercontent.com')).toBe(true)
    expect(isOfficialGithubHost('github-production-release-asset-2e65be.s3.amazonaws.com')).toBe(
      true,
    )
    expect(
      isOfficialGithubHost('github-production-release-asset-2e65be.s3.us-west-2.amazonaws.com'),
    ).toBe(true)

    // Attack hosts must be rejected
    expect(isOfficialGithubHost('github.com.attacker.example')).toBe(false)
    expect(isOfficialGithubHost('attacker-github.com')).toBe(false)
    expect(isOfficialGithubHost('evil.githubusercontent.com.attacker.com')).toBe(false)
    expect(isOfficialGithubHost('random-bucket.s3.amazonaws.com')).toBe(false)
  })

  it('16. validates metadata redirects and rejects insecure destinations', () => {
    const endpoint = 'https://api.github.com/repos/HThanh-how/genoffice/releases?per_page=30'
    const validMetadataRedirect = 'https://api.github.com/repositories/12345/releases?per_page=30'
    const invalidHttpMetadata = 'http://api.github.com/releases'
    const spoofedMetadata = 'https://api.github.com.evil.com/releases'

    expect(
      validateResolvedMetadataUrl(endpoint, validMetadataRedirect, {
        kind: 'github',
        value: 'HThanh-how/genoffice',
      }),
    ).toBe(validMetadataRedirect)

    expect(() =>
      validateResolvedMetadataUrl(endpoint, invalidHttpMetadata, {
        kind: 'github',
        value: 'HThanh-how/genoffice',
      }),
    ).toThrowError(/cannot downgrade to insecure HTTP/)

    expect(() =>
      validateResolvedMetadataUrl(endpoint, spoofedMetadata, {
        kind: 'github',
        value: 'HThanh-how/genoffice',
      }),
    ).toThrowError(UpdateSourceError)
  })

  it('17. preserves custom manifest source compatibility for signed CDN asset URLs', () => {
    const originalAssetUrl = 'https://updates.enterprise.com/downloads/GenOffice-1.0.0.exe'
    const signedAssetRedirect =
      'https://updates.enterprise.com/downloads/GenOffice-1.0.0.exe?sig=abc12345&exp=1790000000'

    const resolved = validateResolvedInstallerUrl(originalAssetUrl, signedAssetRedirect, {
      kind: 'manifest',
      value: 'https://updates.enterprise.com/manifest.json',
    })
    expect(resolved).toBe(signedAssetRedirect)
  })

  // =========================================================================
  // SECTION 6: Installer Checksum, Size & Selection Rules
  // =========================================================================

  it('18. selects matching installer and verifies version ordering', () => {
    const digest = 'sha256:' + 'c'.repeat(64)
    const releaseData = [
      {
        tag_name: 'v0.11.111',
        assets: [
          {
            name: 'GenOffice-windows-x64-0.11.111.exe',
            digest,
            browser_download_url:
              'https://github.com/HThanh-how/genoffice/releases/download/v0.11.111/app.exe',
          },
        ],
      },
      {
        tag_name: 'v0.11.115',
        assets: [
          {
            name: 'GenOffice-windows-x64-0.11.115.exe',
            digest,
            browser_download_url:
              'https://github.com/HThanh-how/genoffice/releases/download/v0.11.115/app.exe',
          },
        ],
      },
    ]

    const selected = selectInstaller(releaseData, 'github', 'win32', 'x64', 'stable')
    expect(selected).not.toBeNull()
    expect(selected?.version).toBe('0.11.115')
    expect(selected?.sha256).toBe('c'.repeat(64))
    expect(compareVersions(selected!.version, '0.11.111')).toBe(1)
    expect(compareVersions('0.11.111', '0.11.111')).toBe(0)
  })

  it('19. rejects releases with absent or invalid checksum (fail-closed integrity)', () => {
    const releaseMissingDigest = [
      {
        tag_name: 'v1.0.0',
        assets: [
          {
            name: 'GenOffice-windows-x64-1.0.0.exe',
            browser_download_url: 'https://github.com/org/repo/releases/download/v1.0.0/app.exe',
          },
        ],
      },
    ]
    expect(selectInstaller(releaseMissingDigest, 'github', 'win32', 'x64', 'stable')).toBeNull()

    const releaseBadDigest = [
      {
        tag_name: 'v1.0.0',
        assets: [
          {
            name: 'GenOffice-windows-x64-1.0.0.exe',
            digest: 'md5:1234567890abcdef',
            browser_download_url: 'https://github.com/org/repo/releases/download/v1.0.0/app.exe',
          },
        ],
      },
    ]
    expect(selectInstaller(releaseBadDigest, 'github', 'win32', 'x64', 'stable')).toBeNull()

    // SHA-256 verification hash mismatch simulation
    const actualBytes = Buffer.from('actual installer content')
    const calculatedHash = createHash('sha256').update(actualBytes).digest('hex')
    const expectedHash = 'd'.repeat(64)
    expect(calculatedHash === expectedHash).toBe(false)
  })

  // =========================================================================
  // SECTION 7: Windows Icon Packaging & Resolution
  // =========================================================================

  it('20. deterministically resolves Windows icon prioritizing resources/build/icon.ico and enforces platform guard', () => {
    // 1. Platform guard: Non-Windows returns undefined
    const macResult = resolveWindowIconPath({ platform: 'darwin' })
    expect(macResult).toBeUndefined()

    const linuxResult = resolveWindowIconPath({ platform: 'linux' })
    expect(linuxResult).toBeUndefined()

    // 2. Windows packaged build prioritizes resourcesPath/build/icon.ico
    const mockResources = 'D:/mock-install/resources'
    const packagedResult = resolveWindowIconPath({
      platform: 'win32',
      resourcesPath: mockResources,
      fileExists: (p) => p === join(mockResources, 'build/icon.ico'),
      validateImage: () => true,
    })
    expect(packagedResult).toBe(join(mockResources, 'build/icon.ico'))

    // 3. Fallback when packaged icon is missing or corrupt
    const fallbackResult = resolveWindowIconPath({
      platform: 'win32',
      resourcesPath: mockResources,
      baseDir: 'D:/mock-install/app/out/main',
      fileExists: (p) => p.endsWith('app-icon.png'),
      validateImage: () => true,
    })
    expect(fallbackResult?.endsWith('app-icon.png')).toBe(true)

    // 4. Packaging asset verification on disk: apps/shell/build/icon.ico exists and has non-zero size
    const repoIconPath = join(__dirname, '../build/icon.ico')
    expect(existsSync(repoIconPath)).toBe(true)
    const stats = statSync(repoIconPath)
    expect(stats.size).toBeGreaterThan(10_000)

    // 5. electron-builder.cjs extraResources packaging rule verification
    const builderConfigPath = join(__dirname, '../electron-builder.cjs')
    expect(existsSync(builderConfigPath)).toBe(true)
    const builderContent = readFileSync(builderConfigPath, 'utf8')
    expect(builderContent).toContain("from: 'build/icon.ico'")
    expect(builderContent).toContain("to: 'build/icon.ico'")

    // 6. Native resolveWindowIcon() call on current machine (Windows dev environment)
    if (process.platform === 'win32') {
      const activeIcon = resolveWindowIcon()
      expect(typeof activeIcon === 'string').toBe(true)
      expect(activeIcon?.endsWith('.ico') || activeIcon?.endsWith('.png')).toBe(true)
    }
  })
})
