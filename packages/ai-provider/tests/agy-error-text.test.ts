import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LANGS } from '@genoffice/i18n'
import { agyErrorText, formatAgyResetTime } from '../src/agy-error-text'
import { en } from '../src/i18n/agy-errors/en'
import { zh } from '../src/i18n/agy-errors/zh'

const SHARD_DIR = join(__dirname, '..', 'src', 'i18n', 'agy-errors')

async function loadShards(): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {}
  for (const file of readdirSync(SHARD_DIR)) {
    const mod = (await import(`../src/i18n/agy-errors/${file}`)) as Record<
      string,
      Record<string, string>
    >
    out[file.replace(/\.ts$/, '')] = Object.values(mod)[0]!
  }
  return out
}

describe('localized Antigravity failure messages', () => {
  it('has one shard per UI language, each with exactly the zh key set', async () => {
    const shards = await loadShards()
    expect(Object.keys(shards).sort()).toEqual([...LANGS].sort())
    const keys = Object.keys(zh).sort()
    for (const dict of Object.values(shards)) {
      expect(Object.keys(dict).sort()).toEqual(keys)
      for (const value of Object.values(dict)) expect(value.trim().length).toBeGreaterThan(10)
      // the placeholder survives translation in the "with time" variant only
      expect(dict.agyErrQuotaAt).toContain('{time}')
      expect(dict.agyErrQuota).not.toContain('{time}')
      expect(dict.agyErrAuth).not.toContain('{time}')
    }
  })

  it('every language names Antigravity and gives a different text for each situation', () => {
    for (const lang of LANGS) {
      const quota = agyErrorText(lang, 'quota')
      const auth = agyErrorText(lang, 'auth')
      expect(quota).toContain('Antigravity')
      expect(auth).toContain('Antigravity')
      expect(quota).not.toBe(auth)
      expect(quota).not.toContain('{time}')
    }
  })

  it('fills in the reset time in the UI language and falls back to English for unknown ones', () => {
    const resetAt = Date.parse('2026-10-09T15:30:00')
    const now = Date.parse('2026-10-09T09:00:00')
    const text = agyErrorText('en', 'quota', { resetAt, now })
    expect(text).toBe(en.agyErrQuotaAt.replace('{time}', formatAgyResetTime(resetAt, 'en', now)))
    expect(text).toMatch(/resets at 3:30\s?PM/)
    expect(agyErrorText('vi', 'quota', { resetAt, now })).toMatch(/Thời điểm đặt lại: 15:30/)
    expect(agyErrorText('xx', 'auth')).toBe(en.agyErrAuth)
  })

  it('shows the date when the quota comes back on another day', () => {
    const now = Date.parse('2026-10-09T09:00:00')
    const next = Date.parse('2026-10-11T00:15:00')
    expect(formatAgyResetTime(next, 'en', now)).toMatch(/Oct 11/)
    expect(formatAgyResetTime(Date.parse('2026-10-09T23:00:00'), 'en', now)).not.toMatch(/Oct/)
  })

  it('without a reset time the plain quota message is used', () => {
    expect(agyErrorText('en', 'quota')).toBe(en.agyErrQuota)
    expect(agyErrorText('en', 'quota', { resetAt: undefined })).toBe(en.agyErrQuota)
  })
})
