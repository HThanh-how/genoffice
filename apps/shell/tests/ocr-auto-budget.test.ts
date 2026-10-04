import { describe, expect, it } from 'vitest'
import {
  reconcileOcrBudget,
  reserveOcrBudget,
  ocrWindowReserves,
  stabilizeOcrQuotaSnapshot,
} from '../src/main/document-memory/ocr-auto-budget'
import { parseOcrState, emptyOcrState } from '../src/main/document-memory/agy-ocr-state'

const now = Date.UTC(2026, 9, 4, 3)
const base = { group: 'Gemini Models', fiveHour: 90, weekly: 95, fiveHourResetAt: now + 7_200_000 }

describe('automatic OCR percentage-point accounting', () => {
  it('does not claim a reserve will clear at the very next step when more steps are needed', () => {
    const snapshot = {
      ...base,
      fiveHour: 25,
      weekly: 50,
      fiveHourResetAt: now + 18_000_000,
      weeklyResetAt: now + 7 * 86_400_000,
    }
    const reserves = ocrWindowReserves(snapshot, now)!
    expect(reserves.fiveHourClearsAt).toBe(now + 3 * 3_600_000)
    expect(reserves.weeklyClearsAt).toBe(now + 4 * 86_400_000)
  })

  it('does not reset daily spending when a live provider weekly timestamp jitters', () => {
    const snapshot = { ...base, weeklyResetAt: now + 7 * 86_400_000 }
    const reserves = ocrWindowReserves(snapshot, now)!
    const initial = {
      ...reconcileOcrBudget(undefined, snapshot, reserves.dayKey, now),
      weeklySpent: 12,
    }
    for (const jitter of [-30_000, 30_000]) {
      const stable = stabilizeOcrQuotaSnapshot(
        initial,
        { ...snapshot, weeklyResetAt: snapshot.weeklyResetAt + jitter },
        now,
      )
      const sameDay = ocrWindowReserves(stable, now)!
      expect(sameDay.dayKey).toBe(reserves.dayKey)
      expect(reconcileOcrBudget(initial, stable, sameDay.dayKey, now).weeklySpent).toBe(12)
    }
  })

  it('does not discard a delayed weekly charge when the five-hour bucket updates first', () => {
    const pending = reserveOcrBudget(reconcileOcrBudget(undefined, base, '2026-10-04', now), base)
    const fiveUpdated = reconcileOcrBudget(pending, { ...base, fiveHour: 87 }, '2026-10-04', now)
    expect(fiveUpdated.fiveHourSpent).toBe(3)
    expect(fiveUpdated.weeklySpent).toBe(0)
    expect(fiveUpdated.pending).toMatchObject({ fiveHourObserved: true })
    const weeklyUpdated = reconcileOcrBudget(
      fiveUpdated,
      { ...base, fiveHour: 87, weekly: 93 },
      '2026-10-04',
      now,
    )
    expect(weeklyUpdated.weeklySpent).toBe(2)
    expect(weeklyUpdated.fiveHourSpent).toBe(3)
    expect(weeklyUpdated.pending).toBeUndefined()
  })

  it('keeps an unchanged/late quota baseline durable and reconciles its later drop', () => {
    const initial = reconcileOcrBudget(undefined, base, '2026-10-04', now)
    const pending = reserveOcrBudget(initial, base)
    const unchanged = reconcileOcrBudget(pending, base, '2026-10-04', now)
    expect(unchanged.pending).toEqual(pending.pending)
    const stored = { ...emptyOcrState('2026-10-04'), autoBudgets: { 'Gemini Models': unchanged } }
    const restored = parseOcrState(JSON.stringify(stored), '2026-10-04').autoBudgets![
      'Gemini Models'
    ]
    const charged = reconcileOcrBudget(
      restored,
      { ...base, fiveHour: 87, weekly: 93 },
      '2026-10-04',
      now,
    )
    expect(charged.weeklySpent).toBe(2)
    expect(charged.fiveHourSpent).toBe(3)
    expect(charged.pending).toBeUndefined()
  })

  it('uses provider-cycle staircases and does not guess missing reset times', () => {
    const snapshot = {
      ...base,
      fiveHourResetAt: now + 18_000_000,
      weeklyResetAt: now + 7 * 86_400_000,
    }
    expect(
      Array.from(
        { length: 5 },
        (_, hour) => ocrWindowReserves(snapshot, now + hour * 3_600_000)?.fiveHourReserve,
      ),
    ).toEqual([80, 60, 40, 20, 20])
    expect(
      Array.from(
        { length: 7 },
        (_, day) =>
          ocrWindowReserves(
            { ...snapshot, fiveHourResetAt: now + day * 86_400_000 + 18_000_000 },
            now + day * 86_400_000,
          )?.weeklyReserve,
      ),
    ).toEqual([88, 76, 64, 52, 40, 28, 16])
    expect(ocrWindowReserves({ ...snapshot, weeklyResetAt: undefined }, now)).toBeNull()
    expect(ocrWindowReserves({ ...snapshot, weeklyResetAt: now }, now)).toBeNull()
    expect(ocrWindowReserves(snapshot, now)?.dayResetAt).toBe(now + 86_400_000)
  })

  it('charges only positive drops around automatic calls and persists an unfinished call', () => {
    const initial = reconcileOcrBudget(undefined, base, '2026-10-04', now)
    const pending = reserveOcrBudget(initial, base)
    const saved = { ...emptyOcrState('2026-10-04'), autoBudgets: { 'Gemini Models': pending } }
    const parsed = parseOcrState(JSON.stringify(saved), '2026-10-04')
    const next = reconcileOcrBudget(
      parsed.autoBudgets!['Gemini Models'],
      { ...base, fiveHour: 75, weekly: 87 },
      '2026-10-04',
      now,
    )
    expect(next.fiveHourSpent).toBe(15)
    expect(next.weeklySpent).toBe(8)
    expect(next.pending).toBeUndefined()
    const refilled = reconcileOcrBudget(
      reserveOcrBudget(next, { ...base, fiveHour: 75, weekly: 87 }),
      base,
      '2026-10-04',
      now,
    )
    expect(refilled.fiveHourSpent).toBe(15)
    expect(refilled.weeklySpent).toBe(8)
  })
  it('resets a five-hour budget only after its previous window expires, not a moving timestamp', () => {
    const initial = { ...reconcileOcrBudget(undefined, base, '2026-10-04', now), fiveHourSpent: 20 }
    expect(
      reconcileOcrBudget(
        initial,
        { ...base, fiveHourResetAt: base.fiveHourResetAt + 1000 },
        '2026-10-04',
        now,
      ).fiveHourSpent,
    ).toBe(20)
    expect(
      reconcileOcrBudget(
        initial,
        { ...base, fiveHourResetAt: base.fiveHourResetAt + 18_000_000 },
        '2026-10-04',
        base.fiveHourResetAt + 1,
      ).fiveHourSpent,
    ).toBe(0)
  })
  it('resets daily allowance at its supplied provider cycle boundary, preserving five-hour spending', () => {
    const initial = {
      ...reconcileOcrBudget(undefined, base, '2026-10-04', now),
      fiveHourSpent: 15,
      weeklySpent: 10,
    }
    const next = reconcileOcrBudget(initial, base, '2026-10-05', now)
    expect(next.weeklySpent).toBe(0)
    expect(next.fiveHourSpent).toBe(15)
  })
})
