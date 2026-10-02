import { describe, expect, it } from 'vitest'
import {
  OCR_MAX_CALLS_PER_RUN,
  planOcrBatch,
  type AgyUsageReading,
} from '@genoffice/ai-provider/agy-ocr'
import {
  AgyOcrJob,
  evaluateOcrGate,
  quotaRulesOf,
  type OcrJobHost,
  type OcrPolicyView,
  type OcrRecognizeInput,
} from '../src/main/document-memory/agy-ocr-job'
import { OcrStateStore, type OcrStateFs } from '../src/main/document-memory/agy-ocr-state'
import type { OcrRenderRequest, OcrRenderResult } from '../src/main/document-memory/agy-ocr-render'
import type { OcrDocRow, OcrFileMeta, OcrPageText } from '../src/main/document-memory/ocr-sidecar'
import { DEFAULT_AGY_OCR_SETTINGS, type AgyOcrSettings } from '../src/shared/fork/agy-ocr'

const DAY = 86_400_000
const HOUR = 3_600_000
const T0 = Date.UTC(2026, 9, 1, 3, 0, 0) // 10:00 in Vietnam
const VIETNAM = () => -420

// ---- fakes -------------------------------------------------------------------------------------

class FakeFs implements OcrStateFs {
  files = new Map<string, string>()
  read(path: string) {
    return this.files.get(path)
  }
  write(path: string, text: string) {
    this.files.set(path, text)
  }
}

interface FakeFile {
  id: number
  total: number
  mtimeMs: number
  sizeBytes: number
  lastOpenedAt: number
  fail?: 'password' | 'corrupt' | 'render' | 'timeout'
}

class FakeHost implements OcrJobHost {
  files = new Map<string, FakeFile>()
  pages = new Map<string, Map<number, string>>()
  reindexed: string[] = []
  rendered: string[] = []
  saved: Array<{ path: string; pages: number[] }> = []
  enabled = true
  private nextId = 1

  add(path: string, total: number, extra: Partial<FakeFile> = {}): void {
    this.files.set(path, {
      id: this.nextId++,
      total,
      mtimeMs: T0 - 400 * DAY,
      sizeBytes: 100_000 * total,
      lastOpenedAt: 0,
      ...extra,
    })
  }
  isEnabled() {
    return this.enabled
  }
  candidates(max: number): OcrDocRow[] {
    const rows: OcrDocRow[] = []
    for (const [path, f] of this.files) {
      const done = this.pages.get(path)?.size ?? 0
      const known = done > 0 ? f.total : undefined
      if (known !== undefined && Math.min(known, max) - done <= 0) continue
      rows.push({
        id: f.id,
        path,
        sizeBytes: f.sizeBytes,
        mtimeMs: f.mtimeMs,
        lastOpenedAt: f.lastOpenedAt,
        pagesDone: done,
        ...(known !== undefined ? { totalPages: known } : {}),
      })
    }
    return rows
  }
  documentById(id: number) {
    for (const [path, f] of this.files) if (f.id === id) return { id, path }
    return null
  }
  pagesDone(path: string) {
    return [...(this.pages.get(path)?.keys() ?? [])].sort((a, b) => a - b)
  }
  async render(path: string, request: OcrRenderRequest): Promise<OcrRenderResult | null> {
    this.rendered.push(path)
    const f = this.files.get(path)
    if (!f) return { ok: false, code: 'missing', message: 'gone' }
    if (f.fail === 'timeout') return null
    if (f.fail) return { ok: false, code: f.fail, message: `fake ${f.fail}` }
    const wanted = planOcrBatch({
      totalPages: f.total,
      done: new Set(request.done),
      maxPagesPerFile: request.maxPages,
      pagesPerCall: request.count,
      budget: request.count,
    })
    return {
      ok: true,
      hash: `hash-${path}`,
      mtimeMs: f.mtimeMs,
      sizeBytes: f.sizeBytes,
      totalPages: f.total,
      pages: wanted.map((page) => ({
        page,
        jpeg: new Uint8Array([page]),
        width: 10,
        height: 10,
        source: 'rendered' as const,
      })),
    }
  }
  savePages(path: string, _meta: OcrFileMeta, pages: readonly OcrPageText[]) {
    const map = this.pages.get(path) ?? new Map<number, string>()
    for (const p of pages) map.set(p.page, p.text)
    this.pages.set(path, map)
    this.saved.push({ path, pages: pages.map((p) => p.page) })
  }
  reindex(path: string) {
    this.reindexed.push(path)
  }
  reindexNow?: (path: string) => Promise<void>
}

interface Rig {
  job: AgyOcrJob
  host: FakeHost
  fs: FakeFs
  state: OcrStateStore
  clock: { now: number }
  settings: AgyOcrSettings
  policy: { value: OcrPolicyView | null }
  idle: { value: number | null }
  usage: { five: number; weekly: number; unreadable: boolean; reads: number; weekStart: number }
  recognizeCalls: OcrRecognizeInput[]
  recognizeMode: { value: 'ok' | 'partial' | 'garbage' | { throws: string } }
  onRecognize: { value: (() => void) | null }
}

function rig(overrides: Partial<AgyOcrSettings> = {}, fs = new FakeFs(), pdfPageLimit = 400): Rig {
  const clock = { now: T0 }
  const settings: AgyOcrSettings = {
    ...DEFAULT_AGY_OCR_SETTINGS,
    // pinned: these scenarios were written against a strict reserve and no daily/page limits
    maxPdfsPerDay: 0,
    maxPagesPerFile: 10,
    weeklyFirstDayFloor: 90,
    weeklyMinFloor: 20,
    fiveHourFloorStart: 85,
    fiveHourFloorEnd: 70,
    enabled: true,
    onlyOnAC: false,
    onlyWhenIdle: false,
    ...overrides,
  }
  const host = new FakeHost()
  const state = new OcrStateStore('/state.json', () => clock.now, VIETNAM, fs)
  const policy: Rig['policy'] = { value: { paused: false, onBattery: false } }
  const idle: Rig['idle'] = { value: 600 }
  const usage: Rig['usage'] = {
    five: 0.95,
    weekly: 0.95,
    unreadable: false,
    reads: 0,
    weekStart: T0,
  }
  const recognizeCalls: OcrRecognizeInput[] = []
  const recognizeMode: Rig['recognizeMode'] = { value: 'ok' }
  const onRecognize: Rig['onRecognize'] = { value: null }
  const job = new AgyOcrJob({
    pdfPageLimit: () => pdfPageLimit,
    settings: () => settings,
    host,
    state,
    recognize: async (input) => {
      recognizeCalls.push(input)
      onRecognize.value?.()
      const mode = recognizeMode.value
      if (typeof mode === 'object') throw new Error(mode.throws)
      if (mode === 'garbage') return { text: 'I cannot help with that.' }
      const pages = mode === 'partial' ? input.pages.slice(0, -1) : input.pages
      return {
        text: pages.map((p) => `=== PAGE ${p} ===\nText of page ${p} Nguyễn`).join('\n\n'),
        usage: { inputTokens: 30_000, outputTokens: 300, thinkingTokens: 0 },
      }
    },
    readUsage: async (): Promise<AgyUsageReading | null> => {
      usage.reads++
      if (usage.unreadable) return null
      return {
        readAt: clock.now,
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { window: '5h', remaining: usage.five, resetAt: clock.now + 2 * HOUR },
              { window: 'weekly', remaining: usage.weekly, resetAt: usage.weekStart + 7 * DAY },
            ],
          },
        ],
      }
    },
    policy: () => policy.value,
    idleSeconds: () => idle.value,
    now: () => clock.now,
    timezoneOffset: VIETNAM,
    every: () => () => {},
  })
  return {
    job,
    host,
    fs,
    state,
    clock,
    settings,
    policy,
    idle,
    usage,
    recognizeCalls,
    recognizeMode,
    onRecognize,
  }
}

// ---- gate ----------------------------------------------------------------------------------------

describe('gating', () => {
  const settings = { onlyOnAC: true, onlyWhenIdle: true }
  it('requires a policy reading, a running indexer, AC power and idleness as configured', () => {
    const ok = { paused: false, onBattery: false }
    expect(evaluateOcrGate({ settings, policy: null, idleSeconds: 999 })).toEqual({
      ok: false,
      reason: 'no-power-info',
    })
    expect(
      evaluateOcrGate({ settings, policy: { ...ok, paused: true }, idleSeconds: 999 }),
    ).toEqual({ ok: false, reason: 'indexing-paused' })
    expect(
      evaluateOcrGate({ settings, policy: { ...ok, onBattery: true }, idleSeconds: 999 }),
    ).toEqual({ ok: false, reason: 'on-battery' })
    expect(evaluateOcrGate({ settings, policy: ok, idleSeconds: 119 })).toEqual({
      ok: false,
      reason: 'not-idle',
    })
    expect(evaluateOcrGate({ settings, policy: ok, idleSeconds: null })).toEqual({
      ok: false,
      reason: 'not-idle',
    })
    expect(evaluateOcrGate({ settings, policy: ok, idleSeconds: 120 })).toEqual({ ok: true })
  })

  it('the switches turn the individual checks off', () => {
    const onBattery = { paused: false, onBattery: true }
    expect(
      evaluateOcrGate({
        settings: { onlyOnAC: false, onlyWhenIdle: false },
        policy: onBattery,
        idleSeconds: 0,
      }),
    ).toEqual({ ok: true })
    expect(
      evaluateOcrGate({
        settings: { onlyOnAC: true, onlyWhenIdle: false },
        policy: onBattery,
        idleSeconds: 0,
      }),
    ).toEqual({ ok: false, reason: 'on-battery' })
    // an indexing pause (low memory, locked screen, thermal) always wins
    expect(
      evaluateOcrGate({
        settings: { onlyOnAC: false, onlyWhenIdle: false },
        policy: { paused: true, onBattery: false },
        idleSeconds: 0,
      }),
    ).toEqual({ ok: false, reason: 'indexing-paused' })
  })

  it('gates the job: nothing is read or sent on battery, while active, or while indexing is paused', async () => {
    const r = rig({ onlyOnAC: true, onlyWhenIdle: true })
    r.host.add('/a.pdf', 3)
    r.policy.value = { paused: false, onBattery: true }
    await r.job.tick()
    r.policy.value = { paused: false, onBattery: false }
    r.idle.value = 5
    await r.job.tick()
    r.idle.value = 600
    r.policy.value = { paused: true, onBattery: false }
    await r.job.tick()
    r.policy.value = null
    await r.job.tick()
    expect(r.recognizeCalls).toHaveLength(0)
    expect(r.usage.reads).toBe(0) // not even the free usage read happens while gated
    r.policy.value = { paused: false, onBattery: false }
    await r.job.tick()
    expect(r.recognizeCalls).toHaveLength(1)
  })

  it('stops between calls when the user becomes active', async () => {
    const r = rig({ onlyWhenIdle: true, maxPagesPerFile: 10 })
    r.host.add('/a.pdf', 10)
    r.onRecognize.value = () => {
      r.idle.value = 3 // the user came back during the first call
    }
    await r.job.tick()
    expect(r.recognizeCalls).toHaveLength(1)
    expect(r.host.pagesDone('/a.pdf')).toEqual([1, 2, 3, 4, 5])
    expect(r.host.reindexed).toEqual(['/a.pdf']) // what was read is still indexed
  })
})

// ---- quota ---------------------------------------------------------------------------------------

describe('quota pacing', () => {
  it('maps the settings to per-bucket rules', () => {
    expect(quotaRulesOf(DEFAULT_AGY_OCR_SETTINGS)).toEqual({
      weekly: { firstDayFloor: 50, dropPerDay: 10, minFloor: 10, ignore: false },
      fiveHour: { floorStart: 50, floorEnd: 30, ignore: false },
    })
    expect(quotaRulesOf({ ...DEFAULT_AGY_OCR_SETTINGS, ignoreWeekly: true }).weekly.ignore).toBe(
      true,
    )
  })

  it('does not call agy while a bucket is below its floor, and says which one', async () => {
    const r = rig()
    r.host.add('/a.pdf', 3)
    r.usage.weekly = 0.74 // day 1 floor is 90
    await r.job.tick()
    expect(r.recognizeCalls).toHaveLength(0)
    expect(r.usage.reads).toBe(1)
    const status = r.job.status()
    expect(status.activity).toMatchObject({ kind: 'quota-blocked', window: 'weekly', floor: 90 })
    expect(status.quota!.weekly).toMatchObject({ percent: 74, floor: 90 })
  })

  it('does not ask the usage again before the floor schedule can let it through', async () => {
    const r = rig()
    r.host.add('/a.pdf', 3)
    r.usage.weekly = 0.74
    await r.job.tick()
    await r.job.tick()
    expect(r.usage.reads).toBe(1) // day 3's floor (70) is the first that lets 74% in: not today
    r.clock.now = T0 + 2 * DAY + HOUR // the schedule moved on
    await r.job.tick()
    expect(r.usage.reads).toBe(3) // one before the call, one after it
    expect(r.recognizeCalls).toHaveLength(1) // 74% >= 70 + 2 margin
  })

  it('never runs when the usage cannot be read, and tries again at the next tick', async () => {
    const r = rig()
    r.host.add('/a.pdf', 3)
    r.usage.unreadable = true
    await r.job.tick()
    expect(r.recognizeCalls).toHaveLength(0)
    expect(r.job.status().activity).toEqual({ kind: 'quota-unreadable' })
    r.usage.unreadable = false
    await r.job.tick()
    expect(r.recognizeCalls).toHaveLength(1)
  })

  it('reads the usage before every call and once more at the end', async () => {
    const r = rig({ maxPagesPerFile: 10 })
    r.host.add('/a.pdf', 12) // 10 pages = 2 calls
    await r.job.tick()
    expect(r.recognizeCalls.map((c) => c.pages)).toEqual([
      [1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10],
    ])
    expect(r.usage.reads).toBe(3)
  })

  it('does not start the next call once the quota fell below the floor mid-run', async () => {
    const r = rig({ maxPagesPerFile: 10 })
    r.host.add('/a.pdf', 10)
    r.onRecognize.value = () => {
      r.usage.weekly = 0.85 // the call itself used quota: now below the day-1 floor of 90
    }
    await r.job.tick()
    expect(r.recognizeCalls).toHaveLength(1) // one call may overshoot, a second never starts
    expect(r.host.pagesDone('/a.pdf')).toEqual([1, 2, 3, 4, 5])
    expect(r.job.status().activity).toMatchObject({ kind: 'quota-blocked' })
  })

  it('an ignored bucket never blocks', async () => {
    const r = rig({ ignoreWeekly: true, ignoreFiveHour: true })
    r.host.add('/a.pdf', 2)
    r.usage.weekly = 0.01
    r.usage.five = 0.01
    await r.job.tick()
    expect(r.recognizeCalls).toHaveLength(1)
    expect(r.usage.reads).toBe(0) // both ignored: the usage is not even consulted
  })

  it('uses the same floors for a Claude or GPT model', async () => {
    const r = rig({ model: 'claude-sonnet-4-6' })
    r.host.add('/a.pdf', 2)
    await r.job.tick() // the fake reading only has the Gemini group
    expect(r.recognizeCalls).toHaveLength(0)
    expect(r.job.status().activity.kind).toBe('quota-unknown-group')
  })
})

// ---- work, batching, ordering -----------------------------------------------------------------

describe('reading files', () => {
  it('batches up to five pages per call, stops at the per-file limit and marks the rest as truncated work', async () => {
    const r = rig({ maxPagesPerFile: 7 })
    r.host.add('/long.pdf', 40)
    await r.job.tick()
    expect(r.recognizeCalls.map((c) => c.pages)).toEqual([
      [1, 2, 3, 4, 5],
      [6, 7],
    ])
    expect(r.recognizeCalls[0]!.model).toBe('gemini-3.8-flash-low')
    expect(r.recognizeCalls[0]!.images).toHaveLength(5)
    expect(r.host.pages.get('/long.pdf')!.get(2)).toContain('Nguyễn')
    expect(r.host.reindexed).toEqual(['/long.pdf'])
    const status = r.job.status()
    expect(status).toMatchObject({ pdfsToday: 1, pagesToday: 7, callsToday: 2 })
    expect(status.tokensToday.input).toBe(60_000)
    expect(status.filesWaiting).toBe(0)
  })

  it('stops at the indexer\'s page limit, "unlimited" included: later pages would never be indexed', async () => {
    const r = rig({ maxPagesPerFile: 0 }, undefined, 30)
    r.host.add('/book.pdf', 4000)
    r.host.pages.set('/book.pdf', new Map(Array.from({ length: 30 }, (_, i) => [i + 1, 'x'])))
    await r.job.tick()
    expect(r.recognizeCalls).toHaveLength(0)
    expect(r.job.status().filesWaiting).toBe(0)

    const fresh = rig({ maxPagesPerFile: 0 }, undefined, 30)
    fresh.host.add('/other.pdf', 4000)
    await fresh.job.tick()
    expect(fresh.host.pagesDone('/other.pdf')).toHaveLength(30)
  })

  it("keeps its own smaller limit, and never goes past the indexer's even with a bigger one", async () => {
    const small = rig({ maxPagesPerFile: 12 }, undefined, 30)
    small.host.add('/a.pdf', 100)
    await small.job.tick()
    expect(small.host.pagesDone('/a.pdf')).toHaveLength(12)

    const big = rig({ maxPagesPerFile: 1000 }, undefined, 400)
    big.host.add('/b.pdf', 4000)
    big.host.pages.set('/b.pdf', new Map(Array.from({ length: 400 }, (_, i) => [i + 1, 'x'])))
    await big.job.tick()
    expect(big.recognizeCalls).toHaveLength(0)
  })

  it('"read now" stops there too: pages past the limit would not be searchable', async () => {
    const r = rig({ maxPagesPerFile: 0 }, undefined, 30)
    r.host.add('/book.pdf', 4000)
    r.host.pages.set('/book.pdf', new Map(Array.from({ length: 30 }, (_, i) => [i + 1, 'x'])))
    const result = await r.job.readNow(r.host.files.get('/book.pdf')!.id)
    expect(result).toEqual({ ok: false, error: 'nothing-to-read' })
  })

  it('works the queue in priority order and reindexes each file once', async () => {
    const r = rig()
    r.host.add('/old.pdf', 2)
    r.host.add('/opened.pdf', 2, { lastOpenedAt: T0 - DAY })
    r.host.add('/recent.pdf', 2, { mtimeMs: T0 - 5 * DAY })
    await r.job.tick()
    expect(r.host.rendered.filter((p, i, a) => a.indexOf(p) === i)).toEqual([
      '/opened.pdf',
      '/recent.pdf',
      '/old.pdf',
    ])
    expect([...r.host.reindexed].sort()).toEqual(['/old.pdf', '/opened.pdf', '/recent.pdf'])
  })

  it('is idempotent: a second run finds nothing left and spends nothing', async () => {
    const r = rig()
    r.host.add('/a.pdf', 3)
    await r.job.tick()
    const calls = r.recognizeCalls.length
    r.clock.now += 2 * HOUR
    await r.job.tick()
    r.clock.now += 2 * HOUR
    await r.job.tick()
    expect(r.recognizeCalls).toHaveLength(calls)
    expect(r.host.reindexed).toEqual(['/a.pdf'])
  })

  it('yields after a bounded number of calls per run', async () => {
    const r = rig({ maxPagesPerFile: 5 })
    for (let i = 0; i < OCR_MAX_CALLS_PER_RUN + 5; i++) r.host.add(`/f${i}.pdf`, 3)
    await r.job.tick()
    expect(r.recognizeCalls).toHaveLength(OCR_MAX_CALLS_PER_RUN)
  })

  it('respects the optional PDFs-per-day cap and resumes the next local day', async () => {
    const r = rig({ maxPdfsPerDay: 2 })
    for (let i = 0; i < 5; i++) r.host.add(`/f${i}.pdf`, 2)
    await r.job.tick()
    expect(r.recognizeCalls).toHaveLength(2)
    expect(r.job.status().activity.kind).toBe('cap')
    r.clock.now += HOUR
    await r.job.tick()
    expect(r.recognizeCalls).toHaveLength(2)
    // 17:00 UTC is midnight in Vietnam (UTC+7): a new local day, a new count
    r.clock.now = Date.UTC(2026, 9, 1, 17, 5)
    await r.job.tick()
    expect(r.recognizeCalls).toHaveLength(4)
    expect(r.state.today().day).toBe('2026-10-02')
    expect(r.state.today().pdfs).toBe(2)
  })

  it('does nothing while document memory is switched off or the reader is disabled', async () => {
    const r = rig()
    r.host.add('/a.pdf', 2)
    r.host.enabled = false
    await r.job.tick()
    expect(r.recognizeCalls).toHaveLength(0)
    r.host.enabled = true
    r.settings.enabled = false
    await r.job.tick()
    expect(r.recognizeCalls).toHaveLength(0)
    expect(r.job.status().activity).toEqual({ kind: 'off' })
  })
})

// ---- failures --------------------------------------------------------------------------------------

describe('failure rules', () => {
  it('stops the whole day on a quota / auth / rate-limit error, refunds the charge, and resumes tomorrow', async () => {
    for (const message of [
      'You have exhausted your quota',
      'Not signed in. Please sign in again',
      '429 Too Many Requests: rate limit',
    ]) {
      const r = rig()
      r.host.add('/a.pdf', 3)
      r.host.add('/b.pdf', 3)
      r.recognizeMode.value = { throws: message }
      await r.job.tick()
      expect(r.recognizeCalls).toHaveLength(1)
      expect(r.state.today().pages).toBe(0) // refunded: nothing was read or billed
      expect(r.state.get().halted?.day).toBe('2026-10-01')
      expect(r.job.status().activity.kind).toBe('halted')
      r.clock.now += 2 * HOUR
      await r.job.tick()
      expect(r.recognizeCalls).toHaveLength(1) // never loops within the day
      r.recognizeMode.value = 'ok'
      r.clock.now = Date.UTC(2026, 9, 1, 17, 30) // after local midnight
      await r.job.tick()
      expect(r.host.pages.get('/a.pdf')?.size).toBe(3)
    }
  })

  it('backs off exponentially on other failures and marks a file non-retryable after three', async () => {
    const r = rig()
    r.host.add('/bad.pdf', 3)
    r.recognizeMode.value = { throws: 'Antigravity CLI exited with code 1 without a result' }
    await r.job.tick()
    expect(r.state.get().backoff.failures).toBe(1)
    expect(r.state.get().backoff.until).toBe(T0 + 10 * 60_000)
    r.clock.now += 5 * 60_000
    await r.job.tick() // still backing off
    expect(r.recognizeCalls).toHaveLength(1)
    r.clock.now += 6 * 60_000
    await r.job.tick()
    expect(r.state.get().backoff.until - r.clock.now).toBe(20 * 60_000)
    r.clock.now += 21 * 60_000
    await r.job.tick()
    expect(r.recognizeCalls).toHaveLength(3)
    const file = r.state.get().files['/bad.pdf']!
    expect(file.nonRetryable).toBe(true)
    expect(file.reason).toMatch(/Failed 3 times/)
    r.clock.now += 100 * HOUR
    await r.job.tick()
    expect(r.recognizeCalls).toHaveLength(3) // never again
    expect(r.job.status().filesWaiting).toBe(0)
  })

  it('a success resets the failure streak', async () => {
    const r = rig()
    r.host.add('/a.pdf', 2)
    r.recognizeMode.value = { throws: 'timed out' }
    await r.job.tick()
    expect(r.state.get().backoff.failures).toBe(1)
    r.recognizeMode.value = 'ok'
    r.clock.now += 11 * 60_000
    await r.job.tick()
    expect(r.state.get().backoff).toEqual({ failures: 0, until: 0 })
    expect(r.state.get().files['/a.pdf']!.attempts).toBe(0)
  })

  it('keeps the pages it got when an answer misses some, counts an attempt only without progress', async () => {
    const r = rig()
    r.host.add('/a.pdf', 4)
    r.recognizeMode.value = 'partial'
    await r.job.tick()
    expect(r.host.pagesDone('/a.pdf')).toEqual([1, 2, 3])
    expect(r.state.get().files['/a.pdf']!.attempts).toBe(0) // progress was made
    expect(r.state.get().lastError!.message).toMatch(/missing page 4/)
    expect(r.state.get().backoff.failures).toBe(1)
  })

  it('a garbage answer saves nothing and counts against the file', async () => {
    const r = rig()
    r.host.add('/a.pdf', 4)
    r.recognizeMode.value = 'garbage'
    await r.job.tick()
    expect(r.host.pagesDone('/a.pdf')).toEqual([])
    expect(r.state.get().files['/a.pdf']!.attempts).toBe(1)
    expect(r.host.reindexed).toEqual([])
  })

  it('marks password-protected and damaged files non-retryable at once and moves on', async () => {
    const r = rig()
    r.host.add('/locked.pdf', 3, { fail: 'password' })
    r.host.add('/broken.pdf', 3, { fail: 'corrupt' })
    r.host.add('/fine.pdf', 2)
    await r.job.tick()
    const files = r.state.get().files
    expect(files['/locked.pdf']).toMatchObject({
      nonRetryable: true,
      reason: 'The PDF is password-protected',
    })
    expect(files['/broken.pdf']).toMatchObject({ nonRetryable: true, reason: 'The PDF is damaged' })
    expect(r.host.pagesDone('/fine.pdf')).toEqual([1, 2])
    expect(r.state.get().backoff.failures).toBe(0)
  })

  it('a render failure that may be transient counts an attempt and a timeout stops the run', async () => {
    const r = rig()
    r.host.add('/slow.pdf', 3, { fail: 'timeout' })
    await r.job.tick()
    expect(r.state.get().files['/slow.pdf']!.attempts).toBe(1)
    expect(r.recognizeCalls).toHaveLength(0)
  })
})

// ---- manual ----------------------------------------------------------------------------------------

describe('manual "read with Antigravity now"', () => {
  it('ignores quota, gate, halt and backoff, reads up to the per-file limit and reindexes', async () => {
    const r = rig({ onlyOnAC: true, onlyWhenIdle: true, maxPagesPerFile: 8 })
    r.host.add('/a.pdf', 30)
    r.policy.value = { paused: false, onBattery: true }
    r.idle.value = 0
    r.usage.weekly = 0.01
    r.state.update((d) => {
      d.halted = { day: '2026-10-01', kind: 'quota', message: 'x', at: T0 }
      d.backoff = { failures: 3, until: T0 + DAY }
      d.files['/a.pdf'] = { attempts: 3, nonRetryable: true, reason: 'earlier', updatedAt: 0 }
    })
    const id = r.host.files.get('/a.pdf')!.id
    const result = await r.job.readNow(id)
    expect(result).toEqual({ ok: true, pages: 8 })
    expect(r.usage.reads).toBe(0)
    expect(r.host.pagesDone('/a.pdf')).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(r.host.reindexed).toEqual(['/a.pdf'])
    expect(r.state.get().files['/a.pdf']!.nonRetryable).toBeUndefined()
    expect(r.state.today().pages).toBe(8) // still counted in today's totals
  })

  it('makes what it read searchable before it answers, not through the line', async () => {
    const r = rig({ maxPagesPerFile: 3 })
    r.host.add('/a.pdf', 3)
    const order: string[] = []
    r.host.reindexNow = async (path) => {
      order.push(`now:${path}`)
    }
    const result = await r.job.readNow(r.host.files.get('/a.pdf')!.id)
    order.push('answered')

    expect(result.ok).toBe(true)
    expect(order).toEqual(['now:/a.pdf', 'answered'])
    expect(r.host.reindexed).toEqual([]) // not queued behind the other files as well
  })

  it('queues the file the ordinary way when reading it at once fails', async () => {
    const r = rig({ maxPagesPerFile: 3 })
    r.host.add('/a.pdf', 3)
    r.host.reindexNow = async () => {
      throw new Error('worker busy')
    }
    const result = await r.job.readNow(r.host.files.get('/a.pdf')!.id)

    expect(result.ok).toBe(true)
    expect(r.host.reindexed).toEqual(['/a.pdf'])
  })

  it('refuses non-PDFs, unknown ids, finished files and overlapping reads', async () => {
    const r = rig()
    r.host.add('/a.pdf', 2)
    r.host.add('/b.docx', 2)
    expect(await r.job.readNow(999)).toEqual({ ok: false, error: 'not-pdf' })
    expect(await r.job.readNow(r.host.files.get('/b.docx')!.id)).toEqual({
      ok: false,
      error: 'not-pdf',
    })
    let inner: Promise<unknown> | undefined
    r.onRecognize.value = () => {
      inner = r.job.readNow(r.host.files.get('/a.pdf')!.id)
    }
    const first = await r.job.readNow(r.host.files.get('/a.pdf')!.id)
    expect(first.ok).toBe(true)
    expect(await inner).toEqual({ ok: false, error: 'busy' })
    expect(await r.job.readNow(r.host.files.get('/a.pdf')!.id)).toEqual({
      ok: false,
      error: 'nothing-to-read',
    })
  })

  it('reports why a manual read failed', async () => {
    const r = rig()
    r.host.add('/a.pdf', 2)
    r.recognizeMode.value = { throws: 'Not signed in. Please sign in again' }
    const result = await r.job.readNow(r.host.files.get('/a.pdf')!.id)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/signed in/)
  })
})

// ---- persistence ----------------------------------------------------------------------------------

describe('restart safety', () => {
  it('survives a restart: counters, halt, backoff and per-file verdicts come back from the state file', async () => {
    const fs = new FakeFs()
    const first = rig({}, fs)
    first.host.add('/a.pdf', 3)
    first.host.add('/locked.pdf', 3, { fail: 'password' })
    first.recognizeMode.value = { throws: 'timed out' }
    await first.job.tick()
    first.clock.now += 11 * 60_000
    first.recognizeMode.value = 'ok'
    await first.job.tick()
    const before = first.state.get()
    expect(before.day.pages).toBeGreaterThan(0)

    const second = rig({}, fs) // a new process reading the same state file
    second.host.pages = first.host.pages
    second.host.files = first.host.files
    second.clock.now = first.clock.now
    expect(second.state.get().day.pages).toBe(before.day.pages)
    expect(second.state.get().files['/locked.pdf']!.nonRetryable).toBe(true)
    const calls = first.recognizeCalls.length
    await second.job.tick()
    expect(second.recognizeCalls).toHaveLength(0) // everything readable was already read
    expect(first.recognizeCalls).toHaveLength(calls)
  })

  it('a corrupt or missing state file starts fresh instead of breaking the job', () => {
    const fs = new FakeFs()
    fs.write('/state.json', '{not json')
    const state = new OcrStateStore('/state.json', () => T0, VIETNAM, fs)
    expect(state.get().files).toEqual({})
    expect(state.today().day).toBe('2026-10-01')
    const empty = new OcrStateStore('/none.json', () => T0, VIETNAM, new FakeFs())
    expect(empty.get().armed).toEqual({ fiveHour: false, weekly: false })
  })

  it('an unwritable state file never throws', () => {
    const fs: OcrStateFs = {
      read: () => undefined,
      write: () => {
        throw new Error('EACCES')
      },
    }
    const state = new OcrStateStore('/state.json', () => T0, VIETNAM, fs)
    expect(() => state.update((d) => void (d.day.pages += 1))).not.toThrow()
    expect(state.get().day.pages).toBe(1)
  })

  it('re-enabling clears a day halt and the backoff, and forgets the armed state', async () => {
    const r = rig()
    r.host.add('/a.pdf', 2)
    r.state.update((d) => {
      d.halted = { day: '2026-10-01', kind: 'quota', message: 'x', at: T0 }
      d.backoff = { failures: 2, until: T0 + DAY }
      d.armed = { fiveHour: true, weekly: true }
    })
    const previous = { ...r.settings, enabled: false }
    r.job.settingsChanged(previous)
    expect(r.state.get().halted).toBeUndefined()
    expect(r.state.get().backoff).toEqual({ failures: 0, until: 0 })
    expect(r.state.get().armed).toEqual({ fiveHour: false, weekly: false })
    await r.job.tick()
    expect(r.recognizeCalls).toHaveLength(1)
  })
})

describe('local day accounting across midnight and time zones', () => {
  it('rolls the day counters at the LOCAL midnight of the injected zone', () => {
    const clock = { now: Date.UTC(2026, 9, 1, 16, 59) } // 23:59 in Vietnam
    const fs = new FakeFs()
    const state = new OcrStateStore('/s.json', () => clock.now, VIETNAM, fs)
    state.update((d) => void (d.day.pages = 9))
    expect(state.today()).toMatchObject({ day: '2026-10-01', pages: 9 })
    clock.now += 2 * 60_000
    expect(state.today()).toMatchObject({ day: '2026-10-02', pages: 0 })
    // the same instant is still the previous day in Los Angeles
    const la = new OcrStateStore(
      '/s.json',
      () => clock.now,
      () => 420,
      new FakeFs(),
    )
    expect(la.today().day).toBe('2026-10-01')
  })
})
