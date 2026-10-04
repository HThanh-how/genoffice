/** Durable accounting in percentage points, measured around automatic OCR calls only. */
export interface OcrAutoBudgetAccount {
  day: string
  weeklySpent: number
  fiveHourSpent: number
  fiveHourResetAt: number
  weeklyResetAt?: number
  pending?: {
    day: string
    fiveHourResetAt: number
    fiveHour: number
    weekly: number
    fiveHourObserved?: boolean
    weeklyObserved?: boolean
  }
}

export interface OcrQuotaSnapshot {
  group: string
  fiveHour: number
  fiveHourResetAt: number
  weekly: number
  weeklyResetAt?: number
}

/** Provider relative timestamps can jitter. A live window never grants a fresh allowance. */
export function stabilizeOcrQuotaSnapshot(
  previous: OcrAutoBudgetAccount | undefined,
  snapshot: OcrQuotaSnapshot,
  now: number,
): OcrQuotaSnapshot {
  return {
    ...snapshot,
    fiveHourResetAt:
      previous && previous.fiveHourResetAt > now
        ? previous.fiveHourResetAt
        : snapshot.fiveHourResetAt,
    ...(previous?.weeklyResetAt && previous.weeklyResetAt > now
      ? { weeklyResetAt: previous.weeklyResetAt }
      : {}),
  }
}

/** Provider windows are absolute instants; no calendar-week or timezone guesses. */
export function ocrWindowReserves(snapshot: OcrQuotaSnapshot, now: number, weeklyDailyBudget = 12) {
  if (!snapshot.weeklyResetAt || snapshot.weeklyResetAt <= now || snapshot.fiveHourResetAt <= now)
    return null
  const hour = 3_600_000
  const day = 86_400_000
  const fiveStart = snapshot.fiveHourResetAt - 5 * hour
  const weeklyStart = snapshot.weeklyResetAt - 7 * day
  const hourIndex = Math.max(0, Math.min(4, Math.floor((now - fiveStart) / hour)))
  const dayIndex = Math.max(0, Math.min(6, Math.floor((now - weeklyStart) / day)))
  const dayStart = weeklyStart + dayIndex * day
  let fiveHourClearsAt = snapshot.fiveHourResetAt
  for (let next = hourIndex + 1; next < 5; next++) {
    if (snapshot.fiveHour >= Math.max(20, 80 - next * 20) + 2) {
      fiveHourClearsAt = fiveStart + next * hour
      break
    }
  }
  let weeklyClearsAt = snapshot.weeklyResetAt
  for (let next = dayIndex + 1; next < 7; next++) {
    if (snapshot.weekly >= Math.max(16, 100 - (next + 1) * weeklyDailyBudget) + 2) {
      weeklyClearsAt = weeklyStart + next * day
      break
    }
  }
  return {
    fiveHourReserve: Math.max(20, 80 - hourIndex * 20),
    weeklyReserve: Math.max(16, 100 - (dayIndex + 1) * weeklyDailyBudget),
    dayKey: new Date(dayStart).toISOString(),
    dayResetAt: dayStart + day,
    fiveHourClearsAt,
    weeklyClearsAt,
    nextFiveHourStepAt: Math.min(snapshot.fiveHourResetAt, fiveStart + (hourIndex + 1) * hour),
  }
}

export function reconcileOcrBudget(
  previous: OcrAutoBudgetAccount | undefined,
  snapshot: OcrQuotaSnapshot,
  day: string,
  now: number,
): OcrAutoBudgetAccount {
  const account: OcrAutoBudgetAccount = previous
    ? { ...previous }
    : {
        day,
        weeklySpent: 0,
        fiveHourSpent: 0,
        fiveHourResetAt: snapshot.fiveHourResetAt,
      }
  if (account.day !== day) {
    account.day = day
    account.weeklySpent = 0
  }
  if (!account.weeklyResetAt || account.weeklyResetAt <= now)
    account.weeklyResetAt = snapshot.weeklyResetAt
  // Do not reset a live budget merely because a provider moved its future reset timestamp.
  if (account.fiveHourResetAt <= now && snapshot.fiveHourResetAt !== account.fiveHourResetAt) {
    account.fiveHourResetAt = snapshot.fiveHourResetAt
    account.fiveHourSpent = 0
  }
  if (account.pending) {
    const pending = account.pending
    const weeklyDrop = pending.day === day ? Math.max(0, pending.weekly - snapshot.weekly) : 0
    const fiveDrop =
      pending.fiveHourResetAt === account.fiveHourResetAt
        ? Math.max(0, pending.fiveHour - snapshot.fiveHour)
        : 0
    if (pending.day === day) account.weeklySpent += weeklyDrop
    if (pending.fiveHourResetAt === account.fiveHourResetAt) account.fiveHourSpent += fiveDrop
    const weeklyObserved = pending.weeklyObserved || weeklyDrop > 0 || pending.day !== day
    const fiveHourObserved =
      pending.fiveHourObserved ||
      fiveDrop > 0 ||
      pending.fiveHourResetAt !== account.fiveHourResetAt
    if (weeklyObserved && fiveHourObserved) delete account.pending
    else
      account.pending = {
        ...pending,
        weekly: weeklyDrop > 0 ? snapshot.weekly : pending.weekly,
        fiveHour: fiveDrop > 0 ? snapshot.fiveHour : pending.fiveHour,
        ...(weeklyObserved ? { weeklyObserved: true } : {}),
        ...(fiveHourObserved ? { fiveHourObserved: true } : {}),
      }
  }
  return account
}

export function reserveOcrBudget(
  account: OcrAutoBudgetAccount,
  snapshot: OcrQuotaSnapshot,
): OcrAutoBudgetAccount {
  return {
    ...account,
    pending: {
      day: account.day,
      fiveHourResetAt: account.fiveHourResetAt,
      fiveHour: snapshot.fiveHour,
      weekly: snapshot.weekly,
    },
  }
}
