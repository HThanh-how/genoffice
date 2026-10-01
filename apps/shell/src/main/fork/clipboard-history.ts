import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { ClipboardHistoryEntry } from '../../shared/clipboard-history-api'
import { looksSecret, type ClipboardSource } from '../clipboard-suggest'

export const CLIPBOARD_HISTORY_ENABLED_KEY = 'clipboardHistoryEnabled'
export const CLIPBOARD_HISTORY_MAX_ENTRIES = 20
export const CLIPBOARD_HISTORY_MAX_ENTRY_BYTES = 20_000
export const CLIPBOARD_HISTORY_MAX_TOTAL_BYTES = 100_000
export const CLIPBOARD_HISTORY_POLL_MS = 2_000

export function clipboardHistoryEnabledFrom(settings: Record<string, unknown>): boolean {
  return settings[CLIPBOARD_HISTORY_ENABLED_KEY] === true
}

export function normalizeClipboardHistory(value: unknown): ClipboardHistoryEntry[] {
  if (!Array.isArray(value)) return []
  const entries: ClipboardHistoryEntry[] = []
  let total = 0
  const ids = new Set<string>()
  for (const candidate of value) {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      typeof candidate.id !== 'string' ||
      !candidate.id ||
      ids.has(candidate.id) ||
      typeof candidate.text !== 'string' ||
      !candidate.text.trim() ||
      looksSecret(candidate.text) ||
      typeof candidate.copiedAt !== 'number' ||
      !Number.isFinite(candidate.copiedAt)
    )
      continue
    const bytes = Buffer.byteLength(candidate.text, 'utf8')
    if (
      bytes > CLIPBOARD_HISTORY_MAX_ENTRY_BYTES ||
      total + bytes > CLIPBOARD_HISTORY_MAX_TOTAL_BYTES
    )
      continue
    ids.add(candidate.id)
    total += bytes
    entries.push({ id: candidate.id, text: candidate.text, copiedAt: candidate.copiedAt })
    if (entries.length === CLIPBOARD_HISTORY_MAX_ENTRIES) break
  }
  return entries
}

/** Keeps an opt-in, size-capped list of clipboard text. The source is read only while focused. */
export class ClipboardHistory {
  private focused = false
  private poll: ReturnType<typeof setInterval> | null = null
  private lastText: string | null = null
  private entries: ClipboardHistoryEntry[]

  constructor(
    private readonly source: ClipboardSource,
    private readonly enabled: () => boolean,
    private readonly historyPath: () => string,
    private readonly onChange: (entries: ClipboardHistoryEntry[]) => void = () => {},
  ) {
    this.entries = this.enabled() ? this.readStored() : []
    if (!this.enabled()) this.persist([])
  }

  setFocused(focused: boolean): void {
    this.focused = focused
    if (!focused) {
      this.stopPoll()
      return
    }
    if (!this.enabled()) return
    // Do not add clipboard text that was already present when GenOffice gained focus.
    this.lastText = this.readSafeText()
    this.check()
    this.startPoll()
  }

  settingsChanged(): void {
    if (!this.enabled()) {
      this.stopPoll()
      this.lastText = null
      this.entries = []
      this.persist([])
      this.onChange([])
      return
    }
    if (this.focused) {
      this.lastText = this.readSafeText()
      this.startPoll()
    }
  }

  list(): ClipboardHistoryEntry[] {
    return this.enabled() ? this.entries.map((entry) => ({ ...entry })) : []
  }

  clear(): void {
    this.entries = []
    this.persist([])
    this.onChange([])
  }

  dispose(): void {
    this.stopPoll()
    this.focused = false
    this.lastText = null
  }

  check(): void {
    if (!this.enabled() || !this.focused) return
    const text = this.readSafeText()
    if (text === null || text === this.lastText) return
    this.lastText = text
    const bytes = Buffer.byteLength(text, 'utf8')
    if (!text.trim() || bytes > CLIPBOARD_HISTORY_MAX_ENTRY_BYTES || looksSecret(text)) return
    const entry: ClipboardHistoryEntry = { id: randomUUID(), text, copiedAt: Date.now() }
    const items = [entry, ...this.entries.filter((item) => item.text !== text)]
    this.entries = normalizeClipboardHistory(items)
    this.persist(this.entries)
    this.onChange(this.list())
  }

  private readSafeText(): string | null {
    try {
      if (this.source.isExcluded()) return null
      return this.source.readText()
    } catch {
      return null
    }
  }

  private readStored(): ClipboardHistoryEntry[] {
    try {
      return normalizeClipboardHistory(JSON.parse(readFileSync(this.historyPath(), 'utf8')))
    } catch {
      return []
    }
  }

  private persist(entries: ClipboardHistoryEntry[]): void {
    try {
      if (!entries.length) {
        rmSync(this.historyPath(), { force: true })
        return
      }
      writeFileSync(this.historyPath(), JSON.stringify(entries), { encoding: 'utf8', mode: 0o600 })
    } catch {
      // A history write failure must never interfere with copying or pasting.
    }
  }

  private startPoll(): void {
    if (this.poll || !this.focused || !this.enabled()) return
    this.poll = setInterval(() => this.check(), CLIPBOARD_HISTORY_POLL_MS)
  }

  private stopPoll(): void {
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }
}
