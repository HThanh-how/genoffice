import { describe, expect, it } from 'vitest'
import {
  AGY_OCR_SETTINGS_KEY,
  DEFAULT_AGY_OCR_SETTINGS,
  agyOcrSettingsFrom,
  mergeAgyOcrSettings,
} from '../src/shared/fork/agy-ocr'
import {
  activityLine,
  agyOcrString,
  bucketLiveLine,
  formatDuration,
  popupLine,
  quotaDescription,
} from '../src/renderer/src/fork/agy-ocr-strings'
import type { AgyOcrActivity, AgyOcrStatus } from '../src/shared/fork/agy-ocr'

describe('settings defaults', () => {
  it('is OFF by default, with the weekly reserve 90/10/20 and the 5-hour glide 85 -> 70, both on', () => {
    expect(DEFAULT_AGY_OCR_SETTINGS).toEqual({
      enabled: false,
      model: 'gemini-3.8-flash-low',
      maxPdfsPerDay: 0,
      maxPagesPerFile: 10,
      pagesPerCall: 5,
      weeklyFirstDayFloor: 90,
      weeklyDropPerDay: 10,
      weeklyMinFloor: 20,
      ignoreWeekly: false,
      fiveHourFloorStart: 85,
      fiveHourFloorEnd: 70,
      ignoreFiveHour: false,
      onlyOnAC: true,
      onlyWhenIdle: true,
    })
  })

  it('a missing, empty or corrupt stored value reads as the defaults (OFF)', () => {
    expect(agyOcrSettingsFrom({}).enabled).toBe(false)
    expect(agyOcrSettingsFrom({ [AGY_OCR_SETTINGS_KEY]: 'garbage' })).toEqual(
      DEFAULT_AGY_OCR_SETTINGS,
    )
    expect(agyOcrSettingsFrom({ [AGY_OCR_SETTINGS_KEY]: null })).toEqual(DEFAULT_AGY_OCR_SETTINGS)
    expect(agyOcrSettingsFrom({ [AGY_OCR_SETTINGS_KEY]: { enabled: 'yes' } }).enabled).toBe(false)
  })
})

describe('settings validation', () => {
  const base = DEFAULT_AGY_OCR_SETTINGS

  it('accepts a valid partial update and keeps everything else', () => {
    const next = mergeAgyOcrSettings(base, { enabled: true, maxPagesPerFile: 12, onlyOnAC: false })
    expect(next).toMatchObject({
      enabled: true,
      maxPagesPerFile: 12,
      onlyOnAC: false,
      onlyWhenIdle: true,
    })
    expect(next.weeklyFirstDayFloor).toBe(90)
  })

  it('weekly numbers are valid only together (0 <= min <= first <= 100, drop 0..100)', () => {
    const ok = mergeAgyOcrSettings(base, {
      weeklyFirstDayFloor: 80,
      weeklyDropPerDay: 5,
      weeklyMinFloor: 50,
    })
    expect([ok.weeklyFirstDayFloor, ok.weeklyDropPerDay, ok.weeklyMinFloor]).toEqual([80, 5, 50])
    // minimum above the first-day floor: the whole triple is refused
    const bad = mergeAgyOcrSettings(base, { weeklyFirstDayFloor: 40, weeklyMinFloor: 60 })
    expect([bad.weeklyFirstDayFloor, bad.weeklyDropPerDay, bad.weeklyMinFloor]).toEqual([
      90, 10, 20,
    ])
  })

  it('5-hour floors must be 0..100 (rounded, clamped by the integer reader)', () => {
    expect(
      mergeAgyOcrSettings(base, { fiveHourFloorStart: 60, fiveHourFloorEnd: 40 }),
    ).toMatchObject({
      fiveHourFloorStart: 60,
      fiveHourFloorEnd: 40,
    })
    expect(mergeAgyOcrSettings(base, { fiveHourFloorStart: 500 }).fiveHourFloorStart).toBe(100)
    expect(mergeAgyOcrSettings(base, { fiveHourFloorStart: 'x' }).fiveHourFloorStart).toBe(85)
  })

  it('has a toggle to ignore each bucket', () => {
    const next = mergeAgyOcrSettings(base, { ignoreWeekly: true, ignoreFiveHour: true })
    expect([next.ignoreWeekly, next.ignoreFiveHour]).toEqual([true, true])
    expect(mergeAgyOcrSettings(base, { ignoreWeekly: 'yes' }).ignoreWeekly).toBe(false)
  })

  it('caps the optional numbers and rejects unsafe model ids', () => {
    expect(mergeAgyOcrSettings(base, { pagesPerCall: 99 }).pagesPerCall).toBe(5)
    expect(mergeAgyOcrSettings(base, { pagesPerCall: 0 }).pagesPerCall).toBe(1)
    expect(mergeAgyOcrSettings(base, { maxPdfsPerDay: -4 }).maxPdfsPerDay).toBe(0)
    expect(mergeAgyOcrSettings(base, { maxPagesPerFile: 9999 }).maxPagesPerFile).toBe(50)
    expect(mergeAgyOcrSettings(base, { model: 'claude-sonnet-4-6' }).model).toBe(
      'claude-sonnet-4-6',
    )
    expect(mergeAgyOcrSettings(base, { model: 'x; rm -rf /' }).model).toBe(base.model)
    expect(mergeAgyOcrSettings(base, { model: 42 }).model).toBe(base.model)
  })

  it('ignores unknown keys and non-object patches', () => {
    expect(mergeAgyOcrSettings(base, { evil: true } as never)).toEqual(base)
    expect(mergeAgyOcrSettings(base, 'nope')).toEqual(base)
    expect(mergeAgyOcrSettings(base, null)).toEqual(base)
  })
})

describe('consent wording and strings', () => {
  it('states in en, vi and zh that page images go to Google through the Antigravity account and that it is off by default', () => {
    expect(agyOcrString('en', 'consent')).toBe(
      'Page images of scanned PDFs are sent to Google through your Antigravity account and use its quota. Off by default.',
    )
    expect(agyOcrString('vi', 'consent')).toMatch(/Google/)
    expect(agyOcrString('vi', 'consent')).toMatch(/Antigravity/)
    expect(agyOcrString('vi', 'consent')).toMatch(/Mặc định tắt/)
    expect(agyOcrString('zh', 'consent')).toMatch(/Google/)
    expect(agyOcrString('zh', 'consent')).toMatch(/默认关闭/)
  })

  it('other languages fall back to English', () => {
    expect(agyOcrString('fr', 'consent')).toBe(agyOcrString('en', 'consent'))
  })

  it('the manual action asks for confirmation naming Google and the page count', () => {
    for (const lang of ['en', 'vi', 'zh'] as const) {
      const text = agyOcrString(lang, 'readNowConfirm', { n: 10 })
      expect(text).toMatch(/10/)
      expect(text).toMatch(/Google/)
    }
  })

  it('describes the reserve with the margin', () => {
    expect(quotaDescription('en')).toMatch(/2 points/)
  })
})

const NOW = Date.UTC(2026, 9, 1, 12, 0)
const baseStatus: AgyOcrStatus = {
  settings: { ...DEFAULT_AGY_OCR_SETTINGS, enabled: true },
  day: '2026-10-01',
  pdfsToday: 1,
  pagesToday: 7,
  tokensToday: { input: 100, output: 10, thinking: 0 },
  callsToday: 2,
  filesWaiting: 1426,
  running: false,
  activity: { kind: 'working' },
}

describe('live lines', () => {
  const live = (percent: number, floor: number) => ({
    percent,
    floor,
    startAt: floor + 2,
    ignored: false,
  })

  it('shows remaining, floor and what happens next', () => {
    expect(bucketLiveLine('en', 'weekly', live(95, 90), { kind: 'working' }, NOW)).toBe(
      'weekly quota: 95% left, floor 90% now → running',
    )
    const blocked: AgyOcrActivity = {
      kind: 'quota-blocked',
      window: 'weekly',
      percent: 74,
      floor: 80,
      startAt: 82,
      belowFloor: true,
      clearsAt: NOW + 3 * 3_600_000,
    }
    expect(bucketLiveLine('en', 'weekly', live(74, 80), blocked, NOW)).toMatch(
      /^weekly quota: 74% left, floor 80% now → runs again /,
    )
    const refill: AgyOcrActivity = { ...blocked, clearsAt: undefined } as AgyOcrActivity
    expect(bucketLiveLine('en', 'weekly', live(15, 20), refill, NOW)).toMatch(
      /when the quota refills/,
    )
    expect(bucketLiveLine('en', 'weekly', undefined, blocked, NOW)).toBe(
      'weekly quota: not read yet',
    )
    expect(bucketLiveLine('en', '5h', { ...live(50, 80), ignored: true }, blocked, NOW)).toMatch(
      /ignored/,
    )
  })

  it('names the blocking bucket in the paused sentence and says when it clears', () => {
    const blocked: AgyOcrActivity = {
      kind: 'quota-blocked',
      window: 'weekly',
      percent: 48,
      floor: 50,
      startAt: 52,
      belowFloor: true,
      clearsAt: NOW + 2 * 86_400_000 + 4 * 3_600_000,
      resetAt: NOW + 3 * 86_400_000,
    }
    const line = activityLine('en', blocked, NOW)
    expect(line).toContain('weekly quota')
    expect(line).toContain('48%')
    expect(line).toContain('below today’s 50% floor')
    expect(line).toMatch(/resumes /)
    expect(activityLine('en', { ...blocked, clearsAt: undefined } as AgyOcrActivity, NOW)).toMatch(
      /resumes when the quota refills/,
    )
    expect(activityLine('en', { ...blocked, belowFloor: false } as AgyOcrActivity, NOW)).toMatch(
      /just above the 50% floor; needs 52% to start/,
    )
  })

  it('formats durations in days, hours and minutes', () => {
    expect(formatDuration('en', 2 * 86_400_000 + 4 * 3_600_000)).toBe('2 d 4 h')
    expect(formatDuration('en', 2 * 3_600_000 + 5 * 60_000)).toBe('2 h 5 min')
    expect(formatDuration('en', 9 * 3_600_000 + 5 * 60_000)).toBe('9 h')
    expect(formatDuration('en', 35 * 60_000)).toBe('35 min')
  })
})

describe('popup line', () => {
  const quota = {
    group: 'Gemini Models',
    readAt: NOW,
    weekly: { percent: 97, floor: 90, startAt: 92, ignored: false },
    fiveHour: { percent: 84, floor: 80, startAt: 82, ignored: false },
  }

  it('says running with the quota left and the files waiting', () => {
    const line = popupLine('en', { ...baseStatus, quota }, NOW)!
    expect(line).toBe(
      'Reading scanned PDFs: running · Gemini 5h 84% left, weekly 97% left · 1,426 files waiting',
    )
  })

  it('names the blocking bucket and the time it clears', () => {
    const line = popupLine(
      'en',
      {
        ...baseStatus,
        activity: {
          kind: 'quota-blocked',
          window: '5h',
          percent: 69,
          floor: 70,
          startAt: 72,
          belowFloor: true,
          clearsAt: NOW + 2 * 3_600_000,
        },
      },
      NOW,
    )!
    expect(line).toContain('5-hour quota at 69%')
    expect(line).toContain('floor 70%')
    expect(line).toContain('resumes in ~2 h')
    expect(line).toContain('1,426 files waiting')
  })

  it('says it cannot read the usage, and shows nothing when off or idle', () => {
    expect(popupLine('en', { ...baseStatus, activity: { kind: 'quota-unreadable' } }, NOW)).toMatch(
      /can’t read Antigravity usage/,
    )
    expect(popupLine('en', { ...baseStatus, activity: { kind: 'off' } }, NOW)).toBeNull()
    expect(popupLine('en', { ...baseStatus, activity: { kind: 'nothing' } }, NOW)).toBeNull()
  })

  it('is translated in vi and zh', () => {
    expect(popupLine('vi', { ...baseStatus, quota }, NOW)).toMatch(/Đọc PDF quét: đang chạy/)
    expect(popupLine('zh', { ...baseStatus, quota }, NOW)).toMatch(/读取扫描版 PDF：运行中/)
  })
})
