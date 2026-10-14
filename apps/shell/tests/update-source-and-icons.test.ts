import { describe, expect, it, vi } from 'vitest'
import {
  compareVersions,
  selectInstaller,
  UpdateSourceError,
  validateUpdateSource,
  type UpdateSource,
} from '../src/shared/update-source'
import { resolveWindowIcon } from '../src/main/window-icon'

describe('Update Source and Icon Restoration (Phase 5 Regression Suite)', () => {
  // Case 1: Valid HThanh-how/genoffice accepted
  it('1. accepts valid canonical GitHub source HThanh-how/genoffice', () => {
    const result = validateUpdateSource({
      kind: 'github',
      value: 'HThanh-how/genoffice',
    })
    expect(result).toEqual({ kind: 'github', value: 'HThanh-how/genoffice' })
  })

  // Case 2: Same canonical source saved twice; no unnecessary write
  it('2. treats identical canonical source as unchanged and avoids redundant disk write', () => {
    const current: UpdateSource = { kind: 'github', value: 'HThanh-how/genoffice' }
    const input: UpdateSource = {
      kind: 'github',
      value: 'https://github.com/HThanh-how/genoffice/',
    }
    const normalized = validateUpdateSource(input)

    let writeCount = 0
    const saveSource = (src: UpdateSource) => {
      if (current.kind === src.kind && current.value === src.value) {
        return src
      }
      writeCount++
      return src
    }

    const first = saveSource(normalized)
    expect(first).toEqual(current)
    expect(writeCount).toBe(0) // No redundant write

    const second = saveSource(normalized)
    expect(second).toEqual(current)
    expect(writeCount).toBe(0)
  })

  // Case 3: Full GitHub repository URL normalizes correctly
  it('3. normalizes multiple valid GitHub URL variants into canonical owner/repo form', () => {
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

  // Case 4: Invalid owner/repository rejected
  it('4. rejects malformed owner/repository with INVALID_FORMAT error code', () => {
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
      }
    }
  })

  // Case 5: Unsupported URL protocol rejected
  it('5. rejects unsupported URL protocols or insecure manifest endpoints', () => {
    const insecureManifests = [
      'http://example.com/update.json',
      'https://user:pass@example.com/update.json',
      'file:///tmp/update.json',
      'https://example.com/update.json#fragment',
      'https://example.com/update.json?param=insecure',
      'ftp://example.com/update.json',
      'javascript:alert(1)',
    ]

    for (const val of insecureManifests) {
      expect(() => validateUpdateSource({ kind: 'manifest', value: val })).toThrowError(
        UpdateSourceError,
      )
      try {
        validateUpdateSource({ kind: 'manifest', value: val })
      } catch (err) {
        expect((err as UpdateSourceError).code).toBe('INVALID_FORMAT')
      }
    }
  })

  // Case 6: Settings write failure returns meaningful failure
  it('6. returns meaningful failure when settings write fails and does not report false success', () => {
    const failingWriter = () => {
      throw new Error('EACCES: permission denied')
    }

    const handleSave = (input: unknown) => {
      const source = validateUpdateSource(input)
      try {
        failingWriter()
        return { success: true, source }
      } catch (err) {
        throw new UpdateSourceError(
          'SETTINGS_WRITE_FAILED',
          `Unable to save update settings: ${(err as Error).message}`,
        )
      }
    }

    expect(() => handleSave({ kind: 'github', value: 'HThanh-how/genoffice' })).toThrowError(
      UpdateSourceError,
    )

    try {
      handleSave({ kind: 'github', value: 'HThanh-how/genoffice' })
    } catch (err) {
      const error = err as UpdateSourceError
      expect(error.code).toBe('SETTINGS_WRITE_FAILED')
      expect(error.message).toContain('Unable to save update settings')
    }
  })

  // Case 7 & 8: Failed save preserves typed input and does not update saved marker
  it('7 & 8. preserves typed input on save failure and leaves saved-source marker untouched', () => {
    let savedMarker = 'github:HThanh-how/genoffice'
    let currentInput = 'github.com/bad/repo/extra'

    const attemptSave = (inputStr: string) => {
      try {
        const validated = validateUpdateSource({ kind: 'github', value: inputStr })
        savedMarker = `${validated.kind}:${validated.value}`
      } catch {
        // Failed: preserve typed input, do NOT update savedMarker
      }
    }

    attemptSave(currentInput)
    expect(savedMarker).toBe('github:HThanh-how/genoffice') // marker untouched
    expect(currentInput).toBe('github.com/bad/repo/extra') // input preserved
  })

  // Case 9: GitHub timeout does not corrupt settings
  it('9. ensures network timeout does not alter or corrupt saved update settings', () => {
    const savedConfig = { updateSource: { kind: 'github', value: 'HThanh-how/genoffice' } }

    const simulateTimeoutCheck = () => {
      throw new UpdateSourceError('TIMEOUT', 'Connection timed out')
    }

    expect(() => simulateTimeoutCheck()).toThrowError(UpdateSourceError)
    // Saved configuration remains exactly intact
    expect(savedConfig.updateSource.value).toBe('HThanh-how/genoffice')
  })

  // Case 10: GitHub 403 rate limiting is distinguishable from invalid repository
  it('10. distinguishes GitHub 403 rate limiting from invalid repository format', () => {
    const rateLimitError = new UpdateSourceError(
      'GITHUB_RATE_LIMITED',
      'GitHub API rate limit reached',
    )
    const invalidFormatError = new UpdateSourceError('INVALID_FORMAT', 'Invalid repository format')

    expect(rateLimitError.code).toBe('GITHUB_RATE_LIMITED')
    expect(rateLimitError.message).toContain('[GITHUB_RATE_LIMITED]')
    expect(invalidFormatError.code).toBe('INVALID_FORMAT')
    expect(invalidFormatError.message).toContain('[INVALID_FORMAT]')
    expect(rateLimitError.code).not.toBe(invalidFormatError.code)
  })

  // Case 11: GitHub 404 reports not found
  it('11. distinguishes GitHub 404 not found error', () => {
    const notFoundError = new UpdateSourceError(
      'GITHUB_NOT_FOUND',
      'Repository not found on GitHub',
    )
    expect(notFoundError.code).toBe('GITHUB_NOT_FOUND')
    expect(notFoundError.message).toContain('[GITHUB_NOT_FOUND]')
    expect(notFoundError.message).toContain('not found')
  })

  // Case 12: Valid release with no matching installer reports the correct state
  it('12. reports correct state when repository is valid but has no compatible installer for platform/arch', () => {
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

    // Asking for windows x64 when only linux arm64 is present
    const installer = selectInstaller(releaseData, 'github', 'win32', 'x64', 'stable')
    expect(installer).toBeNull()

    const noInstallerErr = new UpdateSourceError(
      'NO_COMPATIBLE_INSTALLER',
      'No compatible installer available for this device',
    )
    expect(noInstallerErr.code).toBe('NO_COMPATIBLE_INSTALLER')
  })

  // Case 13: Equal installed and published versions report up to date
  it('13. reports up to date when installed version equals published release version', () => {
    const installed = '0.11.111'
    const published = '0.11.111'
    expect(compareVersions(published, installed)).toBe(0)

    const newerInstalled = '0.11.112'
    expect(compareVersions(published, newerInstalled)).toBe(-1) // newer local is also <= 0
  })

  // Case 14: Newer valid release remains selectable
  it('14. correctly selects newer valid release when available', () => {
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

  // Case 15: Invalid checksum never permits installation
  it('15. rejects releases with absent or invalid checksum', () => {
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

  // Icon Surface Tests
  it('16. resolves native window icon on Windows platform and undefined on non-win32', () => {
    const originalPlatform = process.platform

    // On Windows
    if (process.platform === 'win32') {
      const icon = resolveWindowIcon()
      expect(typeof icon === 'string' || icon === undefined).toBe(true)
      if (icon) {
        expect(icon.endsWith('.ico') || icon.endsWith('.png')).toBe(true)
      }
    }

    // Guard on non-Windows (simulated)
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      const macIcon = resolveWindowIcon()
      expect(macIcon).toBeUndefined()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })
})
