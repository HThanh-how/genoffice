import { describe, expect, it } from 'vitest'
import { compareVersions, selectInstaller, validateUpdateSource } from '../src/shared/update-source'

const digest = 'sha256:' + 'a'.repeat(64)
const asset = (name: string) => ({
  name,
  digest,
  browser_download_url: `https://github.com/HThanh-how/genoffice/releases/download/v1.2.3/${name}`,
})
describe('fork update source', () => {
  it('normalizes repo links and rejects unsafe URLs or malformed repos', () => {
    expect(
      validateUpdateSource({ kind: 'github', value: ' https://github.com/HThanh-how/genoffice/ ' }),
    ).toEqual({ kind: 'github', value: 'HThanh-how/genoffice' })
    for (const value of ['owner/repo/extra', '../repo', 'owner/repo;echo'])
      expect(() => validateUpdateSource({ kind: 'github', value })).toThrow()
    for (const value of [
      'http://example.com/update.json',
      'https://user:secret@example.com/update.json',
      'file:///tmp/a',
      'https://example.com/update.json#fragment',
    ])
      expect(() => validateUpdateSource({ kind: 'manifest', value })).toThrow()
  })
  it('chooses this platform and arch, ignores drafts and beta on stable', () => {
    const data = [
      {
        tag_name: 'v2.0.0-beta.1',
        prerelease: true,
        assets: [asset('GenOffice-macos-arm64-build.dmg')],
      },
      {
        tag_name: 'v1.2.3',
        assets: [
          asset('GenOffice-windows-x64-build.exe'),
          asset('GenOffice-macos-x64-build.dmg'),
          asset('GenOffice-macos-arm64-build.dmg'),
        ],
      },
      { tag_name: 'v3.0.0', draft: true, assets: [asset('GenOffice-macos-arm64-build.dmg')] },
    ]
    expect(selectInstaller(data, 'github', 'darwin', 'arm64', 'stable')?.version).toBe('1.2.3')
    expect(selectInstaller(data, 'github', 'darwin', 'arm64', 'beta')?.version).toBe('2.0.0-beta.1')
    expect(selectInstaller(data, 'github', 'win32', 'arm64', 'stable')).toBeNull()
  })
  it('requires checksum and a matching installer extension in custom metadata', () => {
    const valid = {
      version: '1.2.3',
      assets: [
        {
          platform: 'darwin',
          arch: 'arm64',
          url: 'https://example.com/app.dmg',
          sha256: 'a'.repeat(64),
        },
      ],
    }
    expect(selectInstaller(valid, 'manifest', 'darwin', 'arm64', 'stable')?.version).toBe('1.2.3')
    expect(
      selectInstaller(
        { ...valid, assets: [{ ...valid.assets[0], sha256: '' }] },
        'manifest',
        'darwin',
        'arm64',
        'stable',
      ),
    ).toBeNull()
    expect(
      selectInstaller(
        { ...valid, assets: [{ ...valid.assets[0], url: 'https://example.com/app.zip' }] },
        'manifest',
        'darwin',
        'arm64',
        'stable',
      ),
    ).toBeNull()
  })
  it('orders numeric prereleases and prevents beta to stable downgrades', () => {
    expect(compareVersions('1.2.3-beta.10', '1.2.3-beta.2')).toBe(1)
    expect(compareVersions('1.2.3', '1.2.3-beta.10')).toBe(1)
    expect(compareVersions('1.2.2', '1.2.3-beta.1')).toBe(-1)
    expect(compareVersions('1.2.3+build', '1.2.3')).toBe(0)
  })
})
