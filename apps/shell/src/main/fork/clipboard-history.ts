import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { ClipboardHistoryEntry } from '../../shared/clipboard-history-api'
import { looksSecret, type ClipboardSource } from '../clipboard-suggest'

export const CLIPBOARD_HISTORY_ENABLED_KEY = 'clipboardHistoryEnabled'
export const CLIPBOARD_HISTORY_MAX_ENTRIES = 20
export const CLIPBOARD_HISTORY_MAX_ENTRY_BYTES = 20_000
export const CLIPBOARD_HISTORY_MAX_TOTAL_BYTES = 100_000
export const CLIPBOARD_HISTORY_MAX_IMAGE_BYTES = 4_000_000
export const CLIPBOARD_HISTORY_MAX_IMAGES_TOTAL_BYTES = 12_000_000
export const CLIPBOARD_HISTORY_POLL_MS = 2_000
/** A single unbroken token this long is treated like a secret even if it matches no known key shape. */
const UNUSUAL_TOKEN_CHARS = 32

/** On unless the user switched it off. */
export function clipboardHistoryEnabledFrom(settings: Record<string, unknown>): boolean {
  return settings[CLIPBOARD_HISTORY_ENABLED_KEY] !== false
}

/**
 * Passwords, keys, card numbers, one-time codes and unusually long unbroken strings. They are
 * kept (so pasting still works) but shown masked and never written to disk.
 */
export function looksSensitive(text: string): boolean {
  if (looksSecret(text)) return true
  const t = text.trim()
  if (t.length < UNUSUAL_TOKEN_CHARS || /\s/.test(t)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false // URL
  if (/^(?:[A-Za-z]:[\\/]|\\\\|~?\/)/.test(t)) return false // file path
  return /\d/.test(t) && /[A-Za-z]/.test(t)
}

/** Internal entry: images also carry their PNG (base64) here; it never leaves the main process. */
export interface StoredClipboardEntry extends ClipboardHistoryEntry {
  data?: string
}

export function normalizeClipboardHistory(value: unknown): StoredClipboardEntry[] {
  if (!Array.isArray(value)) return []
  const entries: StoredClipboardEntry[] = []
  let textTotal = 0
  let imageTotal = 0
  const ids = new Set<string>()
  for (const candidate of value) {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      typeof candidate.id !== 'string' ||
      !candidate.id ||
      ids.has(candidate.id) ||
      typeof candidate.text !== 'string' ||
      typeof candidate.copiedAt !== 'number' ||
      !Number.isFinite(candidate.copiedAt)
    )
      continue
    if (candidate.kind === 'image') {
      const bytes = typeof candidate.data === 'string' ? candidate.data.length : 0
      if (
        !bytes ||
        typeof candidate.preview !== 'string' ||
        !candidate.preview.startsWith('data:image/') ||
        bytes > CLIPBOARD_HISTORY_MAX_IMAGE_BYTES * 1.4 ||
        imageTotal + bytes > CLIPBOARD_HISTORY_MAX_IMAGES_TOTAL_BYTES * 1.4
      )
        continue
      imageTotal += bytes
      ids.add(candidate.id)
      entries.push({
        id: candidate.id,
        kind: 'image',
        text: '',
        copiedAt: candidate.copiedAt,
        preview: candidate.preview,
        ...(typeof candidate.width === 'number' ? { width: candidate.width } : {}),
        ...(typeof candidate.height === 'number' ? { height: candidate.height } : {}),
        data: candidate.data,
      })
    } else {
      if (!candidate.text.trim()) continue
      const bytes = Buffer.byteLength(candidate.text, 'utf8')
      if (
        bytes > CLIPBOARD_HISTORY_MAX_ENTRY_BYTES ||
        textTotal + bytes > CLIPBOARD_HISTORY_MAX_TOTAL_BYTES
      )
        continue
      textTotal += bytes
      ids.add(candidate.id)
      entries.push({
        id: candidate.id,
        kind: 'text',
        text: candidate.text,
        copiedAt: candidate.copiedAt,
        ...(looksSensitive(candidate.text) ? { sensitive: true } : {}),
      })
    }
    if (entries.length === CLIPBOARD_HISTORY_MAX_ENTRIES) break
  }
  return entries
}

function imageKey(png: Buffer): string {
  return `image:${createHash('sha1').update(png).digest('hex')}`
}

interface Snapshot {
  key: string
  text?: string
  image?: { png: Buffer; preview: string; width: number; height: number }
}

/** Keeps a size-capped list of recent clipboard text and images. The source is read only while focused. */
export class ClipboardHistory {
  private focused = false
  private poll: ReturnType<typeof setInterval> | null = null
  private lastKey: string | null = null
  private entries: StoredClipboardEntry[]

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
    // Do not add clipboard content that was already present when GenOffice gained focus.
    this.lastKey = this.readSnapshot()?.key ?? null
    this.check()
    this.startPoll()
  }

  settingsChanged(): void {
    if (!this.enabled()) {
      this.stopPoll()
      this.lastKey = null
      this.entries = []
      this.persist([])
      this.onChange([])
      return
    }
    if (this.focused) {
      this.lastKey = this.readSnapshot()?.key ?? null
      this.startPoll()
    }
  }

  /** What the renderer may see: no image bytes. */
  list(): ClipboardHistoryEntry[] {
    if (!this.enabled()) return []
    return this.entries.map(({ data: _data, ...entry }) => ({ ...entry }))
  }

  /** PNG bytes of an image entry, to put back on the system clipboard. */
  imagePng(id: string): Buffer | null {
    if (!this.enabled()) return null
    const entry = this.entries.find((item) => item.id === id && item.kind === 'image')
    return entry?.data ? Buffer.from(entry.data, 'base64') : null
  }

  clear(): void {
    this.entries = []
    this.persist([])
    this.onChange([])
  }

  dispose(): void {
    this.stopPoll()
    this.focused = false
    this.lastKey = null
  }

  check(): void {
    if (!this.enabled() || !this.focused) return
    const snapshot = this.readSnapshot()
    if (snapshot === null || snapshot.key === this.lastKey) return
    this.lastKey = snapshot.key
    let entry: StoredClipboardEntry
    if (snapshot.image) {
      const { png, preview, width, height } = snapshot.image
      if (png.length > CLIPBOARD_HISTORY_MAX_IMAGE_BYTES) return
      entry = {
        id: randomUUID(),
        kind: 'image',
        text: '',
        copiedAt: Date.now(),
        preview,
        width,
        height,
        data: png.toString('base64'),
      }
    } else {
      const text = snapshot.text ?? ''
      const bytes = Buffer.byteLength(text, 'utf8')
      if (!text.trim() || bytes > CLIPBOARD_HISTORY_MAX_ENTRY_BYTES) return
      entry = {
        id: randomUUID(),
        kind: 'text',
        text,
        copiedAt: Date.now(),
        ...(looksSensitive(text) ? { sensitive: true } : {}),
      }
    }
    const same = (item: StoredClipboardEntry): boolean =>
      entry.kind === 'image'
        ? item.kind === 'image' && item.data === entry.data
        : item.kind !== 'image' && item.text === entry.text
    this.entries = normalizeClipboardHistory([entry, ...this.entries.filter((item) => !same(item))])
    this.persist(this.entries)
    this.onChange(this.list())
  }

  private readSnapshot(): Snapshot | null {
    try {
      if (this.source.isExcluded()) return null
      const text = this.source.readText()
      if (text.trim()) return { key: `text:${text}`, text }
      const image = this.source.readImage?.() ?? null
      if (image) return { key: imageKey(image.png), image }
      return { key: 'empty' }
    } catch {
      return null
    }
  }

  private readStored(): StoredClipboardEntry[] {
    try {
      // sensitive text is never persisted; drop any that slipped in
      return normalizeClipboardHistory(JSON.parse(readFileSync(this.historyPath(), 'utf8'))).filter(
        (entry) => !entry.sensitive,
      )
    } catch {
      return []
    }
  }

  private persist(entries: StoredClipboardEntry[]): void {
    try {
      const keep = entries.filter((entry) => !entry.sensitive)
      if (!keep.length) {
        rmSync(this.historyPath(), { force: true })
        return
      }
      writeFileSync(this.historyPath(), JSON.stringify(keep), { encoding: 'utf8', mode: 0o600 })
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
