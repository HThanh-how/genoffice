import { describe, expect, it } from 'vitest'
import { volumeRootOf } from '../src/main/document-memory/volume-root'

describe('volumeRootOf', () => {
  it('uses the drive or share root on Windows', () => {
    expect(volumeRootOf('G:\\Mr Quốc\\2025\\a.pdf', 'win32')).toBe('G:\\')
    expect(volumeRootOf('\\\\nas\\share\\docs\\a.pdf', 'win32')).toBe('\\\\nas\\share\\')
  })

  it('uses the mounted volume on macOS so an unplugged disk is not treated as deleted files', () => {
    expect(volumeRootOf('/Volumes/Mr Quốc/2025/a.pdf', 'darwin')).toBe('/Volumes/Mr Quốc')
    expect(volumeRootOf('/Users/ban/Tài liệu/a.pdf', 'darwin')).toBe('/')
  })

  it('handles common Linux mount points', () => {
    expect(volumeRootOf('/media/ban/DISK/a.pdf', 'linux')).toBe('/media/ban/DISK')
    expect(volumeRootOf('/run/media/ban/DISK/x/a.pdf', 'linux')).toBe('/run/media/ban/DISK')
    expect(volumeRootOf('/mnt/data/a.pdf', 'linux')).toBe('/mnt/data')
    expect(volumeRootOf('/home/ban/a.pdf', 'linux')).toBe('/')
  })

  it('falls back to "/" for a path that is only a mount parent', () => {
    expect(volumeRootOf('/Volumes', 'darwin')).toBe('/')
  })
})
