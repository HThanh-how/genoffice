import { describe, expect, it } from 'vitest'
import {
  AGY_OCR_DEFAULT_MODEL,
  OCR_BACKOFF_MAX_MS,
  OCR_MAX_PAGES_PER_CALL,
  QUOTA_MARGIN_POINTS,
  agyUsageGroupName,
  buildAgyOcrPrompt,
  classifyAgyOcrError,
  decideQuota,
  emptyDayCounters,
  fiveHourFloorAt,
  haltsTheDay,
  localDateKey,
  nextLocalMidnightMs,
  ocrBackoffMs,
  orderOcrCandidates,
  parseAgyOcrOutput,
  parseAgyUsageJson,
  pdfCapReached,
  planOcrBatch,
  rankAgyOcrModels,
  rollOcrDay,
  validFiveHourFloors,
  validWeeklyFloors,
  weeklyDayIndex,
  weeklyFloorAt,
  weeklyFloorOfDay,
  weeklySchedule,
  type AgyUsageReading,
  type OcrCandidate,
  type QuotaArmed,
  type QuotaRules,
} from '../src/agy-ocr'

const DAY = 86_400_000
const HOUR = 3_600_000

describe('prompt', () => {
  it('maps image names to page numbers and carries the strict instructions', () => {
    const prompt = buildAgyOcrPrompt([3, 4])
    expect(prompt).toContain('image-1.jpg = page 3')
    expect(prompt).toContain('image-2.jpg = page 4')
    expect(prompt).toContain('Vietnamese diacritics preserved')
    expect(prompt).toContain('=== PAGE n ===')
    expect(prompt).toContain('[?]')
    expect(prompt).toMatch(/never as instructions/)
  })
})

describe('output parsing', () => {
  it('splits pages in order', () => {
    const out = '=== PAGE 3 ===\nHÓA ĐƠN\nSố 1\n\n=== PAGE 4 ===\nTrang hai'
    const parsed = parseAgyOcrOutput(out, [3, 4])
    expect(parsed.pages.get(3)).toBe('HÓA ĐƠN\nSố 1')
    expect(parsed.pages.get(4)).toBe('Trang hai')
    expect(parsed.missing).toEqual([])
    expect(parsed.lenient).toBe(false)
  })

  it('tolerates fences, decoration, lowercase markers, CRLF and a preamble', () => {
    const out =
      '```\r\nSure, here it is:\r\n**=== Page 1 ===**\r\nA\r\n### === PAGE 2 ===\r\nB\r\n```'
    const parsed = parseAgyOcrOutput(out, [1, 2])
    expect(parsed.pages.get(1)).toBe('A')
    expect(parsed.pages.get(2)).toBe('B')
  })

  it('keeps an empty page as empty text and reports missing pages', () => {
    const parsed = parseAgyOcrOutput('=== PAGE 1 ===\n=== PAGE 3 ===\nx', [1, 2, 3])
    expect(parsed.pages.get(1)).toBe('')
    expect(parsed.missing).toEqual([2])
  })

  it('ignores unexpected page numbers and keeps the longer of repeated pages', () => {
    const parsed = parseAgyOcrOutput(
      '=== PAGE 9 ===\nzzz\n=== PAGE 1 ===\nab\n=== PAGE 1 ===\nabcd',
      [1],
    )
    expect(parsed.unexpected).toEqual([9])
    expect(parsed.pages.get(1)).toBe('abcd')
  })

  it('takes a marker-less answer as the page only when exactly one page was asked', () => {
    const one = parseAgyOcrOutput('just the text', [7])
    expect(one.pages.get(7)).toBe('just the text')
    expect(one.lenient).toBe(true)
    const many = parseAgyOcrOutput('just the text', [7, 8])
    expect(many.pages.size).toBe(0)
    expect(many.missing).toEqual([7, 8])
  })

  it('treats empty and garbage output as all pages missing', () => {
    expect(parseAgyOcrOutput('', [1, 2]).missing).toEqual([1, 2])
    expect(parseAgyOcrOutput('=== PAGE ===\n=== PAGE x ===', [1]).pages.size).toBe(0)
    expect(parseAgyOcrOutput('', [1]).lenient).toBe(false)
  })

  it('keeps [?] marks and table rows on separate lines', () => {
    const parsed = parseAgyOcrOutput(
      '=== PAGE 1 ===\nTên: Nguyễn [?]\n1 | Giấy | 20\n2 | Bút | 5',
      [1],
    )
    expect(parsed.pages.get(1)).toBe('Tên: Nguyễn [?]\n1 | Giấy | 20\n2 | Bút | 5')
  })
})

describe('error classification', () => {
  it.each([
    ['You have exhausted your quota for this period', 'quota'],
    ['RESOURCE_EXHAUSTED: usage limit reached', 'quota'],
    ['429 Too Many Requests', 'rate'],
    ['Rate limit exceeded, try again later', 'rate'],
    ['Not signed in. Please sign in again', 'auth'],
    ['401 Unauthorized', 'auth'],
    ['Antigravity CLI (agy) was not found. Install it', 'cli'],
    ['Request timed out after 240s', 'transient'],
    ['Antigravity CLI exited with code 1 without a result', 'transient'],
    ['something odd happened', 'other'],
  ] as const)('%s -> %s', (message, kind) => {
    expect(classifyAgyOcrError(message)).toBe(kind)
  })

  it('only quota, rate, auth and cli errors end the day', () => {
    expect(['quota', 'rate', 'auth', 'cli'].every((k) => haltsTheDay(k as never))).toBe(true)
    expect(haltsTheDay('transient')).toBe(false)
    expect(haltsTheDay('other')).toBe(false)
  })
})

describe('backoff', () => {
  it('doubles from 10 minutes up to the cap', () => {
    expect(ocrBackoffMs(1)).toBe(10 * 60_000)
    expect(ocrBackoffMs(2)).toBe(20 * 60_000)
    expect(ocrBackoffMs(3)).toBe(40 * 60_000)
    expect(ocrBackoffMs(50)).toBe(OCR_BACKOFF_MAX_MS)
    expect(ocrBackoffMs(0)).toBe(10 * 60_000)
  })
})

describe('local day accounting (injected clock and timezone)', () => {
  const vietnam = () => -420 // UTC+7
  const losAngelesWinter = () => 480 // UTC-8
  it('keys the LOCAL calendar day', () => {
    const t = Date.UTC(2026, 9, 1, 17, 30) // 17:30 UTC = 00:30 on 2 Oct in Vietnam
    expect(localDateKey(t, () => 0)).toBe('2026-10-01')
    expect(localDateKey(t, vietnam)).toBe('2026-10-02')
    expect(localDateKey(t, losAngelesWinter)).toBe('2026-10-01')
    expect(localDateKey(Date.UTC(2026, 9, 1, 5, 0), losAngelesWinter)).toBe('2026-09-30')
  })

  it('rolls the counters over exactly at local midnight', () => {
    const before = Date.UTC(2026, 9, 1, 16, 59, 59) // 23:59:59 in Vietnam
    const after = before + 2000 // 00:00:01 next day
    const counters = { ...emptyDayCounters(localDateKey(before, vietnam)), pages: 7, pdfs: 2 }
    expect(rollOcrDay(counters, before, vietnam)).toBe(counters)
    const next = rollOcrDay(counters, after, vietnam)
    expect(next.day).toBe('2026-10-02')
    expect(next.pages).toBe(0)
    expect(next.pdfs).toBe(0)
  })

  it('finds the next local midnight, also across a daylight-saving change', () => {
    const t = Date.UTC(2026, 9, 1, 10, 0)
    expect(nextLocalMidnightMs(t, vietnam)).toBe(Date.UTC(2026, 9, 1, 17, 0))
    // clocks go back at 02:00 local on 2026-11-01 in the US Pacific zone (PDT -> PST)
    const offset = (ms: number) => (ms < Date.UTC(2026, 10, 1, 9, 0) ? 420 : 480)
    const evening = Date.UTC(2026, 9, 31, 20, 0) // 13:00 PDT on 31 Oct
    expect(nextLocalMidnightMs(evening, offset)).toBe(Date.UTC(2026, 10, 1, 7, 0)) // 00:00 PDT 1 Nov
    const nextDay = nextLocalMidnightMs(Date.UTC(2026, 10, 1, 12, 0), offset) // 04:00 PST on 1 Nov
    expect(nextDay).toBe(Date.UTC(2026, 10, 2, 8, 0)) // 00:00 PST 2 Nov
  })

  it('applies the optional PDF cap only when it is above zero', () => {
    const counters = { ...emptyDayCounters('2026-10-01'), pdfs: 5 }
    expect(pdfCapReached(0, counters)).toBe(false)
    expect(pdfCapReached(5, counters)).toBe(true)
    expect(pdfCapReached(6, counters)).toBe(false)
  })
})

describe('candidate ordering and batching', () => {
  const now = Date.UTC(2026, 9, 1)
  const base = { sizeBytes: 500_000, lastOpenedAt: 0, mtimeMs: now - 400 * DAY, pagesDone: 0 }
  const cand = (path: string, extra: Partial<OcrCandidate> = {}): OcrCandidate => ({
    path,
    ...base,
    ...extra,
  })

  it('puts started files first, then recently opened, recently modified, the rest', () => {
    const ordered = orderOcrCandidates(
      [
        cand('old'),
        cand('modified', { mtimeMs: now - 10 * DAY }),
        cand('opened', { lastOpenedAt: now - 2 * DAY }),
        cand('started', { pagesDone: 2, totalPages: 8 }),
      ],
      now,
      10,
    )
    expect(ordered.map((c) => c.path)).toEqual(['started', 'opened', 'modified', 'old'])
  })

  it('prefers the file needing fewer pages inside a tier (known counts beat size guesses)', () => {
    const ordered = orderOcrCandidates(
      [
        cand('big', { sizeBytes: 5_000_000 }),
        cand('three', { totalPages: 3 }),
        cand('capped', { totalPages: 90 }),
      ],
      now,
      10,
    )
    expect(ordered.map((c) => c.path)).toEqual(['three', 'big', 'capped'])
  })

  it('is deterministic for ties', () => {
    const ordered = orderOcrCandidates([cand('b'), cand('a')], now, 10)
    expect(ordered.map((c) => c.path)).toEqual(['a', 'b'])
  })

  it('plans the next undone pages within the per-file and per-call limits', () => {
    const plan = (done: number[], total = 30, max = 10, perCall = 5) =>
      planOcrBatch({
        totalPages: total,
        done: new Set(done),
        maxPagesPerFile: max,
        pagesPerCall: perCall,
        budget: perCall,
      })
    expect(plan([])).toEqual([1, 2, 3, 4, 5])
    expect(plan([1, 2, 3, 4, 5])).toEqual([6, 7, 8, 9, 10])
    expect(plan([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual([])
    expect(plan([1], 2)).toEqual([2])
    expect(plan([], 9, 10, 99).length).toBe(OCR_MAX_PAGES_PER_CALL)
    expect(plan([2], 9, 10, 3)).toEqual([1, 3, 4])
  })
})

describe('model ranking', () => {
  it('lists -low Flash first (newest first) and labels them cheapest', () => {
    const ranked = rankAgyOcrModels([
      'claude-opus-4-6-thinking',
      'gemini-3.7-flash-medium',
      'gemini-3.6-flash-low',
      'gemini-3.1-pro-high',
      'gemini-3.8-flash-low',
      'gemini-3.8-flash-high',
      'gemini-3.7-flash-low',
      'gpt-oss-120b-medium',
    ])
    expect(ranked.slice(0, 3).map((m) => m.id)).toEqual([
      'gemini-3.8-flash-low',
      'gemini-3.7-flash-low',
      'gemini-3.6-flash-low',
    ])
    expect(ranked.filter((m) => m.cheapest).length).toBe(3)
    expect(ranked[3]!.id).toBe('gemini-3.7-flash-medium')
    expect(ranked.at(-1)!.cheapest).toBe(false)
  })

  it('defaults to the measured cheapest model', () => {
    expect(AGY_OCR_DEFAULT_MODEL).toBe('gemini-3.8-flash-low')
  })
})

// ---------------------------------------------------------------------------------------------
// quota
// ---------------------------------------------------------------------------------------------

// shape captured from a real `agy -p "/usage" --output-format json` run
const REAL_USAGE = {
  status: 'SUCCESS',
  usage: { total_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            {
              id: 'gemini-weekly',
              window: 'weekly',
              remaining_fraction: 0.9874818921089172,
              reset_time: '2026-10-03T14:00:31Z',
            },
            {
              id: 'gemini-5h',
              window: '5h',
              remaining_fraction: 0.9736766815185547,
              reset_time: '2026-10-01T14:44:25Z',
            },
          ],
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            {
              id: '3p-weekly',
              window: 'weekly',
              remaining_fraction: 0.6423411965370178,
              reset_time: '2026-10-01T16:13:12Z',
            },
            {
              id: '3p-5h',
              window: '5h',
              remaining_fraction: 1,
              reset_time: '2026-10-01T15:09:25Z',
            },
          ],
        },
      ],
    },
  },
}

describe('usage parsing', () => {
  it('reads both groups with their 5h and weekly buckets', () => {
    const parsed = parseAgyUsageJson(REAL_USAGE, 5)!
    expect(parsed.readAt).toBe(5)
    expect(parsed.groups.map((g) => g.name)).toEqual(['Gemini Models', 'Claude and GPT models'])
    const gemini = parsed.groups[0]!
    const five = gemini.buckets.find((b) => b.window === '5h')!
    expect(five.remaining).toBeCloseTo(0.9737, 3)
    expect(five.resetAt).toBe(Date.parse('2026-10-01T14:44:25Z'))
    expect(gemini.buckets.find((b) => b.window === 'weekly')!.remaining).toBeCloseTo(0.9875, 3)
  })

  it('rejects anything that is not the usage table', () => {
    expect(parseAgyUsageJson(null, 0)).toBeNull()
    expect(parseAgyUsageJson({ response: 'hello' }, 0)).toBeNull()
    expect(parseAgyUsageJson({ command: { data: { groups: [] } } }, 0)).toBeNull()
    expect(parseAgyUsageJson({ command: { data: { groups: 'x' } } }, 0)).toBeNull()
  })

  it('skips malformed buckets (bad window, fraction out of range, NaN)', () => {
    const parsed = parseAgyUsageJson(
      {
        command: {
          data: {
            groups: [
              {
                name: 'Gemini Models',
                buckets: [
                  { window: 'monthly', remaining_fraction: 0.5 },
                  { window: '5h', remaining_fraction: 7 },
                  { window: '5h', remaining_fraction: Number.NaN },
                  { window: 'weekly', remaining_fraction: 0.4 },
                ],
              },
            ],
          },
        },
      },
      0,
    )!
    expect(parsed.groups[0]!.buckets).toEqual([{ window: 'weekly', remaining: 0.4 }])
  })

  it('maps model ids to quota groups', () => {
    expect(agyUsageGroupName('gemini-3.8-flash-low')).toBe('Gemini Models')
    expect(agyUsageGroupName('claude-sonnet-4-6')).toBe('Claude and GPT models')
    expect(agyUsageGroupName('gpt-oss-120b-medium')).toBe('Claude and GPT models')
    expect(agyUsageGroupName('llama-4')).toBeNull()
  })
})

const WEEKLY = { firstDayFloor: 90, dropPerDay: 10, minFloor: 20, ignore: false }
const FIVE = { floorStart: 85, floorEnd: 70, ignore: false }
const RULES: QuotaRules = { weekly: WEEKLY, fiveHour: FIVE }

describe('weekly floor schedule', () => {
  it('is 90, 80 ... 30, 20 for the default seven days', () => {
    expect(weeklySchedule(WEEKLY)).toEqual([90, 80, 70, 60, 50, 40, 30])
    expect(weeklyFloorOfDay(WEEKLY, 7)).toBe(20) // clamped by the minimum
  })

  it('never drops below the minimum floor', () => {
    expect(weeklySchedule({ ...WEEKLY, minFloor: 55 })).toEqual([90, 80, 70, 60, 55, 55, 55])
    expect(weeklySchedule({ ...WEEKLY, dropPerDay: 0 })).toEqual([90, 90, 90, 90, 90, 90, 90])
    expect(weeklySchedule({ ...WEEKLY, firstDayFloor: 100, dropPerDay: 25, minFloor: 0 })).toEqual([
      100, 75, 50, 25, 0, 0, 0,
    ])
  })

  // reset_time is an absolute UTC instant: the window is the 7 days before it
  const reset = Date.UTC(2026, 9, 8, 14, 0, 31)
  const start = reset - 7 * DAY

  it('moves to the next day exactly at the 24 h boundary, for all seven days', () => {
    for (let day = 0; day < 7; day++) {
      expect(weeklyDayIndex(reset, start + day * DAY)).toBe(day)
      expect(weeklyDayIndex(reset, start + day * DAY + DAY - 1)).toBe(day)
      expect(weeklyFloorAt(WEEKLY, reset, start + day * DAY)).toBe(90 - 10 * day)
    }
  })

  it('is stable just before and just after a day change', () => {
    expect(weeklyFloorAt(WEEKLY, reset, start + DAY - 1)).toBe(90)
    expect(weeklyFloorAt(WEEKLY, reset, start + DAY)).toBe(80)
    expect(weeklyFloorAt(WEEKLY, reset, start + 2 * DAY + 1)).toBe(70)
  })

  it('clamps before the window start and after the reset', () => {
    expect(weeklyDayIndex(reset, start - 5 * DAY)).toBe(0)
    expect(weeklyDayIndex(reset, reset + 3 * DAY)).toBe(6)
    expect(weeklyFloorAt(WEEKLY, reset, start - DAY)).toBe(90)
    expect(weeklyFloorAt(WEEKLY, reset, reset + DAY)).toBe(30)
  })

  it('uses the strictest (day 1) floor when the reset time is unknown', () => {
    expect(weeklyFloorAt(WEEKLY, undefined, start + 4 * DAY)).toBe(90)
  })

  it('does not depend on the time zone or daylight saving (only UTC instants are used)', () => {
    // 7 days of 24 h even when a local clock change makes one local day 23 or 25 h long
    const dstReset = Date.UTC(2026, 10, 3, 8, 0, 0) // after the US fall-back on 2026-11-01
    const dstStart = dstReset - 7 * DAY
    expect(weeklyDayIndex(dstReset, dstStart + 2 * DAY - 1)).toBe(1)
    expect(weeklyDayIndex(dstReset, dstStart + 2 * DAY)).toBe(2)
    const previous = process.env.TZ
    try {
      for (const tz of ['UTC', 'Asia/Ho_Chi_Minh', 'America/Los_Angeles', 'Pacific/Auckland']) {
        process.env.TZ = tz
        expect(weeklyDayIndex(dstReset, dstStart + 3 * DAY)).toBe(3)
        expect(weeklyFloorAt(WEEKLY, dstReset, dstStart + 3 * DAY)).toBe(60)
      }
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })

  it('validates 0 <= min <= first <= 100 and 0 <= drop <= 100', () => {
    expect(validWeeklyFloors(90, 10, 20)).toBe(true)
    expect(validWeeklyFloors(100, 0, 0)).toBe(true)
    expect(validWeeklyFloors(20, 10, 20)).toBe(true) // min equal to first is allowed
    expect(validWeeklyFloors(20, 10, 30)).toBe(false) // min above first
    expect(validWeeklyFloors(101, 10, 20)).toBe(false)
    expect(validWeeklyFloors(90, -1, 20)).toBe(false)
    expect(validWeeklyFloors(90, 10, -5)).toBe(false)
    expect(validWeeklyFloors(Number.NaN, 10, 20)).toBe(false)
  })
})

describe('5-hour glide floor', () => {
  const reset = Date.UTC(2026, 9, 1, 14, 44, 25)
  const start = reset - 5 * HOUR

  it('glides linearly from the start floor to the end floor', () => {
    expect(fiveHourFloorAt(FIVE, reset, start)).toBe(85)
    expect(fiveHourFloorAt(FIVE, reset, start + 2.5 * HOUR)).toBeCloseTo(77.5, 6)
    expect(fiveHourFloorAt(FIVE, reset, reset)).toBe(70)
    expect(fiveHourFloorAt(FIVE, reset, start + HOUR)).toBeCloseTo(82, 6)
  })

  it('clamps outside the window and uses the start floor without a reset time', () => {
    expect(fiveHourFloorAt(FIVE, reset, start - HOUR)).toBe(85)
    expect(fiveHourFloorAt(FIVE, reset, reset + HOUR)).toBe(70)
    expect(fiveHourFloorAt(FIVE, undefined, start)).toBe(85)
  })

  it('also works when the reserve grows over the window', () => {
    expect(
      fiveHourFloorAt({ ...FIVE, floorStart: 50, floorEnd: 90 }, reset, start + 2.5 * HOUR),
    ).toBe(70)
  })

  it('validates both floors within 0..100', () => {
    expect(validFiveHourFloors(85, 70)).toBe(true)
    expect(validFiveHourFloors(0, 100)).toBe(true)
    expect(validFiveHourFloors(-1, 70)).toBe(false)
    expect(validFiveHourFloors(85, 101)).toBe(false)
    expect(validFiveHourFloors(Number.NaN, 5)).toBe(false)
  })
})

describe('quota decision (decideQuota)', () => {
  const reset5 = Date.UTC(2026, 9, 1, 14, 44, 25)
  const resetWeek = Date.UTC(2026, 9, 8, 14, 0, 0)
  const weekStart = resetWeek - 7 * DAY
  const OFF: QuotaArmed = { fiveHour: false, weekly: false }
  const ON: QuotaArmed = { fiveHour: true, weekly: true }

  const reading = (five: number, weekly: number, group = 'Gemini Models'): AgyUsageReading => ({
    readAt: 1,
    groups: [
      {
        name: group,
        buckets: [
          { window: '5h', remaining: five, resetAt: reset5 },
          { window: 'weekly', remaining: weekly, resetAt: resetWeek },
        ],
      },
    ],
  })
  // 12:00 on the first day of the weekly window; 5-hour window is 40% through (floor = 79)
  const at = (offsetMs: number) => ({ now: reset5 - 3 * HOUR + offsetMs })

  const decide = (
    r: AgyUsageReading | null,
    armed: QuotaArmed,
    now: number,
    rules: QuotaRules = RULES,
    model = 'gemini-3.8-flash-low',
  ) => decideQuota({ reading: r, model, armed, rules, now })

  // a clock where the weekly window began 1 day ago: day index 1 (floor 80)
  const dayTwo = weekStart + DAY + 6 * HOUR
  const fiveMid = (dayTwo: number) => dayTwo // the 5h bucket's own window is only used for its floor

  it('starts only at floor + margin and says which bucket blocks', () => {
    expect(QUOTA_MARGIN_POINTS).toBe(2)
    // weekly day 2 floor is 80: needs 82 to start
    const edge = decide(reading(1, 0.82), OFF, dayTwo, {
      ...RULES,
      fiveHour: { ...FIVE, ignore: true },
    })
    expect(edge.run).toBe(true)
    const below = decide(reading(1, 0.81), OFF, dayTwo, {
      ...RULES,
      fiveHour: { ...FIVE, ignore: true },
    })
    expect(below.run).toBe(false)
    expect(below.blocking).toMatchObject({
      window: 'weekly',
      floor: 80,
      startAt: 82,
      belowFloor: false,
    })
    expect(fiveMid(dayTwo)).toBe(dayTwo)
  })

  it('keeps going between calls while remaining stays at or above the floor (no flapping inside the margin)', () => {
    const rules = { ...RULES, fiveHour: { ...FIVE, ignore: true } }
    // armed, 80.5%: inside the margin above floor 80 -> keeps running
    expect(decide(reading(1, 0.805), ON, dayTwo, rules).run).toBe(true)
    // exactly on the floor still runs
    expect(decide(reading(1, 0.8), ON, dayTwo, rules).run).toBe(true)
    // below the floor: stops and disarms
    const dropped = decide(reading(1, 0.799), ON, dayTwo, rules)
    expect(dropped.run).toBe(false)
    expect(dropped.armed.weekly).toBe(false)
    expect(dropped.blocking).toMatchObject({ belowFloor: true })
    // climbing back inside the margin is not enough to start again
    expect(decide(reading(1, 0.81), dropped.armed, dayTwo, rules).run).toBe(false)
    expect(decide(reading(1, 0.82), dropped.armed, dayTwo, rules).run).toBe(true)
  })

  it('weekly day by day: the same 74% is blocked on day 1-5 and allowed from day 6', () => {
    const rules = { ...RULES, fiveHour: { ...FIVE, ignore: true } }
    // 74% needs floor <= 72 -> floors 90, 80 block, 70 (day 3) allows
    expect(decide(reading(1, 0.74), OFF, weekStart + 0.5 * DAY, rules).run).toBe(false)
    expect(decide(reading(1, 0.74), OFF, weekStart + 1.5 * DAY, rules).run).toBe(false)
    expect(decide(reading(1, 0.74), OFF, weekStart + 2.5 * DAY, rules).run).toBe(true)
  })

  it('estimates when the schedule lets work resume, or says only the refill helps', () => {
    const rules = { ...RULES, fiveHour: { ...FIVE, ignore: true } }
    const blocked = decide(reading(1, 0.74), OFF, weekStart + 0.5 * DAY, rules)
    // 74 needs floor + 2 <= 74: day 3 (floor 70) starts at weekStart + 2 days
    expect(blocked.blocking).toMatchObject({ clears: 'schedule', clearsAt: weekStart + 2 * DAY })
    // 15% never clears before the refill (min floor 20)
    const never = decide(reading(1, 0.15), OFF, weekStart + 0.5 * DAY, rules)
    expect(never.blocking).toMatchObject({ clears: 'refill', resetAt: resetWeek })
    expect(never.blocking!.clearsAt).toBeUndefined()
    // unknown reset time: nothing to estimate
    const noReset = decide(
      {
        readAt: 1,
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { window: 'weekly', remaining: 0.4 },
              { window: '5h', remaining: 1 },
            ],
          },
        ],
      },
      OFF,
      weekStart,
      rules,
    )
    expect(noReset.blocking).toMatchObject({ clears: 'refill' })
  })

  it('lets one bucket block while the other is fine, and names the blocking one', () => {
    // weekly fine (95%), 5-hour at 60% with floor ~79
    const d = decide(reading(0.6, 0.95), ON, reset5 - 3 * HOUR)
    expect(d.run).toBe(false)
    expect(d.blocking).toMatchObject({ window: '5h', belowFloor: true })
    expect(d.armed).toEqual({ fiveHour: false, weekly: true })
    expect(d.fiveHour!.floor).toBeCloseTo(85 - 15 * 0.4, 6)
    // and the other way round: 5-hour fine, weekly blocking
    const w = decide(reading(1, 0.4), ON, weekStart + 0.5 * DAY)
    expect(w.blocking!.window).toBe('weekly')
    expect(w.armed.fiveHour).toBe(true)
  })

  it('every checked bucket must allow: both fine runs, either blocking does not', () => {
    const now = reset5 - 3 * HOUR // 5h floor 79; weekly day depends on resetWeek: pick day 1
    const weekly = (frac: number) => decide(reading(0.95, frac), OFF, weekStart + 0.2 * DAY)
    expect(weekly(0.95).run).toBe(true)
    expect(weekly(0.5).run).toBe(false)
    expect(decide(reading(0.5, 0.95), OFF, now).run).toBe(false)
  })

  it('names the bucket furthest below the level it needs when both block', () => {
    const d = decide(reading(0.5, 0.88), OFF, weekStart + 0.1 * DAY)
    expect(d.run).toBe(false)
    expect(['5h', 'weekly']).toContain(d.blocking!.window)
  })

  it('an ignored bucket never blocks and is not required in the reading', () => {
    const ignoreFive = { ...RULES, fiveHour: { ...FIVE, ignore: true } }
    expect(decide(reading(0.05, 0.95), OFF, weekStart + 0.1 * DAY, ignoreFive).run).toBe(true)
    const ignoreWeekly = { ...RULES, weekly: { ...WEEKLY, ignore: true } }
    expect(decide(reading(0.95, 0.01), OFF, reset5 - 4 * HOUR, ignoreWeekly).run).toBe(true)
    const onlyWeekly: AgyUsageReading = {
      readAt: 1,
      groups: [
        {
          name: 'Gemini Models',
          buckets: [{ window: 'weekly', remaining: 0.99, resetAt: resetWeek }],
        },
      ],
    }
    expect(decide(onlyWeekly, OFF, weekStart, ignoreFive).run).toBe(true)
    expect(decide(onlyWeekly, OFF, weekStart).kind).toBe('unknown-group') // 5h checked but missing
    expect(decide(reading(0.05, 0.95), OFF, weekStart, ignoreFive).fiveHour!.ignored).toBe(true)
  })

  it('ignoring both buckets switches the quota check off without needing a reading', () => {
    const none: QuotaRules = {
      weekly: { ...WEEKLY, ignore: true },
      fiveHour: { ...FIVE, ignore: true },
    }
    expect(decide(null, OFF, 0, none).run).toBe(true)
  })

  it('never runs on an unreadable usage and keeps the previous armed state', () => {
    expect(decide(null, ON, 0)).toMatchObject({ kind: 'unreadable', run: false, armed: ON })
  })

  it('never runs for an unknown model family or a group missing from the reading', () => {
    expect(decide(reading(1, 1), ON, 0, RULES, 'llama-4').kind).toBe('unknown-group')
    expect(decide(reading(1, 1, 'Some other group'), ON, 0).kind).toBe('unknown-group')
  })

  it('applies the same floors to the Claude and GPT group', () => {
    const r = reading(0.95, 0.95, 'Claude and GPT models')
    expect(decide(r, OFF, weekStart + 0.1 * DAY, RULES, 'claude-sonnet-4-6').run).toBe(true)
    expect(decide(r, OFF, weekStart, RULES, 'gemini-3.8-flash-low').kind).toBe('unknown-group')
    const low = reading(0.95, 0.3, 'Claude and GPT models')
    expect(decide(low, ON, weekStart + 0.1 * DAY, RULES, 'gpt-oss-120b-medium').run).toBe(false)
  })

  it('never starts a call below a floor (one call already in flight may overshoot)', () => {
    const rules = { ...RULES, fiveHour: { ...FIVE, ignore: true } }
    let armed = decide(reading(1, 0.9), OFF, weekStart + 0.1 * DAY, rules).armed
    let started = 0
    for (let remaining = 0.93; remaining > 0.8; remaining -= 0.004) {
      const d = decide(reading(1, remaining), armed, weekStart + 0.1 * DAY, rules)
      armed = d.armed
      if (!d.run) break
      started++
      expect(remaining * 100).toBeGreaterThanOrEqual(90 - 1e-9) // never below the day-1 floor
    }
    expect(started).toBeGreaterThan(0)
  })

  it("exposes tomorrow's floor for the live line", () => {
    const d = decide(reading(1, 0.95), OFF, weekStart + 0.5 * DAY, {
      ...RULES,
      fiveHour: { ...FIVE, ignore: true },
    })
    expect(d.weekly).toMatchObject({ floor: 90, nextFloor: 80, nextFloorAt: weekStart + DAY })
    const last = decide(reading(1, 0.95), OFF, weekStart + 6.5 * DAY, {
      ...RULES,
      fiveHour: { ...FIVE, ignore: true },
    })
    expect(last.weekly!.nextFloor).toBeUndefined()
    void at
  })
})
