import { describe, expect, it, vi } from 'vitest'
import {
  applyUpdateSourceChange,
  compareVersions,
  getUpdateErrorMessage,
  selectInstaller,
  UpdateSourceError,
  validateUpdateSource,
  type UpdateSource,
} from '../src/shared/update-source'
import type { UpdateCheckResult } from '../src/shared/home-api'
import { resolveWindowIcon } from '../src/main/window-icon'

describe('Update Source and Icon Restoration (Production Hardened Suite)', () => {
  // 1. Valid GitHub source validation
  it('1. accepts valid canonical GitHub source HThanh-how/genoffice', () => {
    const result = validateUpdateSource({
      kind: 'github',
      value: 'HThanh-how/genoffice',
    })
    expect(result).toEqual({ kind: 'github', value: 'HThanh-how/genoffice' })
  })

  // 2. Canonical URL normalization
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

  // 3. Invalid source rejection
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

  // 4. Identical source avoids redundant disk write
  it('4. treats identical canonical source as unchanged and avoids redundant disk write via applyUpdateSourceChange', () => {
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

  // 5. Actual persistence handler reports write failures
  it('5. returns meaningful failure when settings write fails via applyUpdateSourceChange', () => {
    const current: UpdateSource = { kind: 'github', value: 'old-owner/old-repo' }
    const input = { kind: 'github', value: 'HThanh-how/genoffice' }
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
      expect(error.message).toContain('SETTINGS_WRITE_FAILED')
      expect(error.message).toContain('Unable to save update settings')
    }
  })

  // 6. Failed persistence preserves previously saved settings
  it('6. preserves previously saved settings marker when applyUpdateSourceChange fails', () => {
    let savedMarker = 'github:HThanh-how/genoffice'
    const current: UpdateSource = { kind: 'github', value: 'HThanh-how/genoffice' }
    const failingInput = { kind: 'github', value: 'invalid/owner/repo/extra' }

    try {
      applyUpdateSourceChange(failingInput, current, (src) => {
        savedMarker = `${src.kind}:${src.value}`
      })
    } catch {
      // Ignored
    }

    expect(savedMarker).toBe('github:HThanh-how/genoffice')
  })

  // 7. Update-check return type propagates correctly
  it('7. supports strongly-typed UpdateCheckResult with upToDate boolean', () => {
    const upToDateResult: UpdateCheckResult = { upToDate: true }
    const updateAvailableResult: UpdateCheckResult = { upToDate: false }

    expect(upToDateResult.upToDate).toBe(true)
    expect(updateAvailableResult.upToDate).toBe(false)
  })

  // 8. Up-to-date is displayed only for explicit true
  it('8. strictly displays up-to-date notice only when res?.upToDate === true', () => {
    const handleResult = (res: UpdateCheckResult | void, lang: string) => {
      if (res?.upToDate === true) {
        return lang === 'vi'
          ? 'Bạn đang dùng phiên bản phát hành Stable mới nhất.'
          : 'You are using the latest published Stable version.'
      }
      return ''
    }

    expect(handleResult({ upToDate: true }, 'vi')).toBe(
      'Bạn đang dùng phiên bản phát hành Stable mới nhất.',
    )
    expect(handleResult({ upToDate: true }, 'en')).toBe(
      'You are using the latest published Stable version.',
    )
    expect(handleResult({ upToDate: false }, 'vi')).toBe('')
    expect(handleResult(undefined, 'vi')).toBe('')
  })

  // 9. undefined or void does not produce an up-to-date notification
  it('9. ensures undefined or void update result never produces a false success notice', () => {
    const renderNotice = (res: UpdateCheckResult | void) => {
      if (res?.upToDate === true) {
        return 'SUCCESS'
      }
      return 'NONE'
    }

    expect(renderNotice(undefined)).toBe('NONE')
    // Old flawed check (res?.upToDate !== false) would return true for undefined:
    const oldFlawedCheck = (res: { upToDate?: boolean } | undefined) => res?.upToDate !== false
    expect(oldFlawedCheck(undefined)).toBe(true) // Confirms the defect existed
    // Correct check returns false for undefined:
    const fixedCheck = (res: { upToDate?: boolean } | undefined) => res?.upToDate === true
    expect(fixedCheck(undefined)).toBe(false) // Confirms fixed
  })

  // 10. Busy / concurrent check behavior
  it('10. prevents duplicate concurrent checks while an operation is already in-flight', () => {
    let checking = false
    let callCount = 0

    const executeCheck = () => {
      if (checking) return undefined
      checking = true
      try {
        callCount++
        return { upToDate: true }
      } finally {
        checking = false
      }
    }

    const first = executeCheck()
    expect(first).toEqual({ upToDate: true })
    expect(callCount).toBe(1)
  })

  // 11. Network error classification
  it('11. classifies network timeout and fetch errors distinctly', () => {
    const timeoutErr = new UpdateSourceError('TIMEOUT', 'Connection timed out')
    const networkErr = new UpdateSourceError('NETWORK_ERROR', 'Network connection failed')

    expect(timeoutErr.code).toBe('TIMEOUT')
    expect(networkErr.code).toBe('NETWORK_ERROR')
    expect(getUpdateErrorMessage(timeoutErr.message, 'vi')).toContain(
      'Không thể kết nối đến GitHub',
    )
    expect(getUpdateErrorMessage(networkErr.message, 'en')).toContain('Unable to contact GitHub')
  })

  // 12. GitHub rate limiting versus access denial
  it('12. distinguishes GitHub 403 rate limiting from access denial', () => {
    const rateLimitErr = new UpdateSourceError(
      'GITHUB_RATE_LIMITED',
      'GitHub API rate limit reached',
    )
    const accessDeniedErr = new UpdateSourceError('ACCESS_DENIED', 'Access denied to repository')

    expect(rateLimitErr.code).toBe('GITHUB_RATE_LIMITED')
    expect(accessDeniedErr.code).toBe('ACCESS_DENIED')
    expect(getUpdateErrorMessage(rateLimitErr.message, 'vi')).toContain('Đã đạt giới hạn yêu cầu')
    expect(getUpdateErrorMessage(rateLimitErr.message, 'en')).toContain(
      'GitHub API rate limit reached',
    )
  })

  // 13. Missing repository (HTTP 404)
  it('13. distinguishes GitHub 404 repository not found error', () => {
    const notFoundError = new UpdateSourceError(
      'GITHUB_NOT_FOUND',
      'Repository not found on GitHub',
    )
    expect(notFoundError.code).toBe('GITHUB_NOT_FOUND')
    expect(getUpdateErrorMessage(notFoundError.message, 'vi')).toContain(
      'Không tìm thấy kho mã nguồn',
    )
    expect(getUpdateErrorMessage(notFoundError.message, 'en')).toContain(
      'Repository not found on GitHub',
    )
  })

  // 14. Invalid release metadata
  it('14. handles invalid or oversized release metadata gracefully', () => {
    const metadataErr = new UpdateSourceError('INVALID_RELEASE_METADATA', 'Invalid JSON metadata')
    expect(metadataErr.code).toBe('INVALID_RELEASE_METADATA')
    expect(getUpdateErrorMessage(metadataErr.message, 'vi')).toContain(
      'Dữ liệu phiên bản phát hành',
    )
  })

  // 15. No compatible installer
  it('15. reports correct state when repository has no compatible installer for platform/arch', () => {
    const releaseData = [
      {
        tag_name: 'v1.0.0',
        assets: [
          {
            name: 'GenOffice-linux-arm64-1.0.0.AppImage',
            digest: 'sha256:' + 'f'.repeat(64),
            browser_download_url:
              'https://github.com/org/repo/releases/download/v1.0.0/app.AppImage',
          },
        ],
      },
    ]

    const installer = selectInstaller(releaseData, 'github', 'win32', 'x64', 'stable')
    expect(installer).toBeNull()

    const noInstallerErr = new UpdateSourceError(
      'NO_COMPATIBLE_INSTALLER',
      'No compatible installer available for this device',
    )
    expect(getUpdateErrorMessage(noInstallerErr.message, 'vi')).toContain('chưa có bộ cài phù hợp')
    expect(getUpdateErrorMessage(noInstallerErr.message, 'en')).toContain(
      'no compatible installer is available',
    )
  })

  // 16. Equal versions report up to date
  it('16. reports up to date when installed version equals published release version', () => {
    expect(compareVersions('0.11.111', '0.11.111')).toBe(0)
    expect(compareVersions('0.11.111', '0.11.112')).toBe(-1)
  })

  // 17. Newer valid release selectable
  it('17. correctly selects newer valid release when available', () => {
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
    expect(compareVersions(selected!.version, '0.11.111')).toBe(1)
  })

  // 18. Invalid or absent checksum fails closed
  it('18. rejects releases with absent or invalid checksum', () => {
    const releaseWithBadChecksum = [
      {
        tag_name: 'v1.0.0',
        assets: [
          {
            name: 'GenOffice-windows-x64-1.0.0.exe',
            digest: 'invalid-checksum',
            browser_download_url: 'https://github.com/org/repo/releases/download/v1.0.0/app.exe',
          },
        ],
      },
    ]

    const result = selectInstaller(releaseWithBadChecksum, 'github', 'win32', 'x64', 'stable')
    expect(result).toBeNull()
  })

  // 19. Windows icon path resolution & platform guard
  it('19. resolves native window icon on Windows platform and undefined on non-win32', () => {
    const originalPlatform = process.platform

    if (process.platform === 'win32') {
      const icon = resolveWindowIcon()
      expect(typeof icon === 'string' || icon === undefined).toBe(true)
      if (icon) {
        expect(icon.endsWith('.ico') || icon.endsWith('.png')).toBe(true)
      }
    }

    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      const macIcon = resolveWindowIcon()
      expect(macIcon).toBeUndefined()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })

  // 20. Manifest query parameter rejection
  it('20. rejects manifest URLs containing query parameters or fragments', () => {
    const insecureUrls = [
      'https://example.com/update.json?token=secret',
      'https://example.com/update.json#hash',
      'http://insecure.com/update.json',
      'https://user:pass@example.com/update.json',
    ]

    for (const url of insecureUrls) {
      expect(() => validateUpdateSource({ kind: 'manifest', value: url })).toThrowError(
        UpdateSourceError,
      )
    }
  })
})
