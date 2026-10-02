import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLIPBOARD_HARD_LIMIT_CHARS,
  CLIPBOARD_SUGGEST_ENABLED_KEY,
  CURRENT_TTL_MS,
  ClipboardWatcher,
  SUGGEST_MIN_INTERVAL_MS,
  SuggestGate,
  actionsFor,
  classifyClipboardText,
  clipboardSuggestEnabledFrom,
  electronClipboardSource,
  hashClipboardText,
  looksSecret,
  luhnValid,
  makePreview,
} from '../src/main/clipboard-suggest'
import {
  CLIPBOARD_MAX_CHARS,
  CLIPBOARD_PREVIEW_MAX,
  CLIPBOARD_VISIBLE_MS,
  buildClipboardPrefill,
} from '../src/shared/clipboard-suggest-api'
import type { ClipboardSuggestion } from '../src/shared/clipboard-suggest-api'
import { isClipboardSuggestion } from '../src/shared/clipboard-suggest-guard'

describe('setting', () => {
  it('is ON unless explicitly switched off', () => {
    expect(clipboardSuggestEnabledFrom({})).toBe(true)
    expect(clipboardSuggestEnabledFrom({ [CLIPBOARD_SUGGEST_ENABLED_KEY]: 'false' })).toBe(true)
    expect(clipboardSuggestEnabledFrom({ [CLIPBOARD_SUGGEST_ENABLED_KEY]: true })).toBe(true)
    expect(clipboardSuggestEnabledFrom({ [CLIPBOARD_SUGGEST_ENABLED_KEY]: false })).toBe(false)
  })
})

describe('looksSecret', () => {
  it.each([
    ['openai key', 'sk-proj-abcdEFGH1234ijklMNOP5678qrstUVWX'],
    ['anthropic key', 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv'],
    ['github pat', 'ghp_16C7e42F292c6912E7710c838347Ae178B4a'],
    ['aws access key', 'AKIAIOSFODNN7EXAMPLE'],
    ['slack token', 'xoxb-123456789012-abcdefghijkl'],
    [
      'jwt',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...'],
    ['key embedded in prose', 'my key is AKIAIOSFODNN7EXAMPLE please keep it'],
    ['env assignment', 'DB_PASSWORD=hunter2hunter2\nHOST=localhost'],
    ['password colon', 'password: correct-horse-battery'],
    ['bearer header', 'Authorization: Bearer abcdef0123456789abcdef0123456789'],
    ['visa test number', '4111 1111 1111 1111'],
    ['card with dashes in a sentence', 'Pay with 4539-1488-0343-6467 today'],
    ['otp', '482913'],
    ['otp split', '482 913'],
    ['high entropy token', 'Zk3dQ9vL1pX7sR2mT8wY4nB6'],
    ['hex digest', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['signed url', 'https://files.example.com/a.pdf?X=1&signature=AbCd1234EfGh5678'],
  ])('flags %s', (_name, text) => {
    expect(looksSecret(text)).toBe(true)
  })

  it.each([
    ['plain prose', 'Please summarize the quarterly report before Friday afternoon.'],
    ['mentions password without a value', 'The password policy requires 12 characters.'],
    ['long identifier without digits', 'internationalizationConfigurationManager'],
    ['plain url', 'https://example.com/docs/getting-started'],
    ['windows path', 'C:\\Users\\Admin\\Documents\\Quarterly Report 2026.docx'],
    ['phone number (10 digits)', 'Call me on 0912345678 tomorrow'],
    ['order number failing luhn', 'Order 1234567890123456 shipped'],
    ['version string', 'genoffice-1.2.3-beta.4'],
    ['vietnamese sentence', 'Hãy tóm tắt báo cáo quý này giúp tôi nhé'],
    ['file name with dots', 'quarterly.report.final.docx'],
  ])('does not flag %s', (_name, text) => {
    expect(looksSecret(text)).toBe(false)
  })

  it('validates Luhn numbers', () => {
    expect(luhnValid('4111111111111111')).toBe(true)
    expect(luhnValid('4111111111111112')).toBe(false)
    expect(luhnValid('123')).toBe(false)
  })
})

describe('classifyClipboardText', () => {
  const longText = 'This is a paragraph about the quarterly plan. '.repeat(10)

  it.each([
    ['https://example.com/a/very/long/article', 'url'],
    ['C:\\Users\\Admin\\Documents\\report.docx', 'paths'],
    ['"C:\\Users\\Admin\\a.docx"\n"C:\\Users\\Admin\\b.xlsx"', 'paths'],
    ['/home/user/projects/notes.md', 'paths'],
    ['/Users/ban/Tài liệu/Hợp đồng 2026.docx', 'paths'],
    ['name\tqty\tprice\nwidget\t4\t9.50\ngadget\t2\t3.20', 'table'],
    ['id,name,city\n1,An,Hanoi\n2,Binh,Hue\n3,Chi,Hue', 'table'],
    ['function add(a, b) {\n  return a + b;\n}\nconst x = add(1, 2);', 'code'],
    ['def greet(name):\n    return f"hi {name}"\nclass Foo: pass', 'code'],
    ['Nguyen Van A\n12 Le Loi, Hanoi\nan.nguyen@example.com\n+84 912 345 678', 'contact'],
    ['How do I convert this document to PDF?', 'question'],
    ['Quarterly numbers look off for the north region', 'shortText'],
    [longText, 'longText'],
  ])('classifies %j as %s', (text, kind) => {
    expect(classifyClipboardText(text)).toBe(kind)
  })

  it('skips tiny content', () => {
    expect(classifyClipboardText('hello')).toBeNull()
    expect(classifyClipboardText('           a           ')).toBeNull()
  })

  it('does not call prose with commas a table or a sentence with "let" code', () => {
    const prose = 'First, we plan.\nSecond, we build.\nThird, we ship.'
    expect(classifyClipboardText(prose)).not.toBe('table')
    expect(classifyClipboardText('Let me know if you want to const-rain the budget.')).not.toBe(
      'code',
    )
  })

  it('maps every kind to 1-3 actions', () => {
    for (const kind of [
      'url',
      'longText',
      'shortText',
      'question',
      'paths',
      'table',
      'contact',
      'code',
    ] as const) {
      const n = actionsFor(kind).length
      expect(n).toBeGreaterThanOrEqual(1)
      expect(n).toBeLessThanOrEqual(3)
    }
  })

  it('previews are collapsed and capped', () => {
    const p = makePreview('a\n\n  b   c ' + 'x'.repeat(500))
    expect(p.length).toBeLessThanOrEqual(CLIPBOARD_PREVIEW_MAX)
    expect(p.startsWith('a b c ')).toBe(true)
    expect(p.endsWith('…')).toBe(true)
  })
})

describe('SuggestGate', () => {
  it('rate-limits to one per interval and dedups content', () => {
    const gate = new SuggestGate()
    expect(gate.evaluate('a', 0)).toBe('ok')
    gate.record('a', 0)
    expect(gate.evaluate('b', 1_000)).toBe('rate-limited')
    expect(gate.evaluate('a', SUGGEST_MIN_INTERVAL_MS + 1)).toBe('duplicate')
    expect(gate.evaluate('b', SUGGEST_MIN_INTERVAL_MS)).toBe('ok')
  })

  it('remembers dismissed content', () => {
    const gate = new SuggestGate()
    gate.markSeen('x')
    expect(gate.evaluate('x', 10_000_000)).toBe('duplicate')
  })

  it('forgets the oldest hashes beyond its cap', () => {
    const gate = new SuggestGate(0, 2)
    gate.record('a', 0)
    gate.record('b', 1)
    gate.record('c', 2)
    expect(gate.evaluate('a', 3)).toBe('ok')
    expect(gate.evaluate('c', 3)).toBe('duplicate')
  })
})

describe('electronClipboardSource exclusion', () => {
  const make = (formats: Record<string, Buffer>) =>
    electronClipboardSource({
      has: (f) => f in formats,
      readBuffer: (f) => formats[f],
      readText: () => 'text',
    })

  it('honors presence-only and zero-DWORD formats', () => {
    expect(make({}).isExcluded()).toBe(false)
    expect(
      make({ ExcludeClipboardContentFromMonitorProcessing: Buffer.alloc(4) }).isExcluded(),
    ).toBe(true)
    expect(make({ CanIncludeInClipboardHistory: Buffer.alloc(4) }).isExcluded()).toBe(true)
    const one = Buffer.alloc(4)
    one.writeUInt32LE(1)
    expect(make({ CanIncludeInClipboardHistory: one }).isExcluded()).toBe(false)
  })

  it('fails open when the platform throws', () => {
    const src = electronClipboardSource({
      has: () => {
        throw new Error('nope')
      },
      readBuffer: () => Buffer.alloc(0),
      readText: () => '',
    })
    expect(src.isExcluded()).toBe(false)
  })
})

describe('ClipboardWatcher', () => {
  let text = ''
  let excluded = false
  let enabled = true
  let reads = 0
  let events: Array<ClipboardSuggestion | null> = []
  let watcher: ClipboardWatcher

  const make = () =>
    new ClipboardWatcher({
      source: {
        isExcluded: () => excluded,
        readText: () => {
          reads++
          return text
        },
      },
      isEnabled: () => enabled,
      onChange: (s) => events.push(s),
    })

  const offered = () => events.filter((e): e is ClipboardSuggestion => e !== null)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    text = ''
    excluded = false
    enabled = true
    reads = 0
    events = []
    watcher = make()
  })

  afterEach(() => {
    watcher.dispose()
    vi.useRealTimers()
  })

  it('never reads the clipboard while unfocused or disabled', () => {
    text = 'Quarterly numbers look off for the north region'
    watcher.check()
    expect(reads).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(reads).toBe(0)
    enabled = false
    watcher.setFocused(true)
    vi.advanceTimersByTime(60_000)
    expect(reads).toBe(0)
    expect(events).toEqual([])
  })

  it('stops polling on blur', () => {
    watcher.setFocused(true)
    const before = reads
    watcher.setFocused(false)
    vi.advanceTimersByTime(60_000)
    expect(reads).toBe(before)
  })

  it('suggests on focus gain and only once per content', () => {
    text = 'Quarterly numbers look off for the north region'
    watcher.setFocused(true)
    expect(offered()).toHaveLength(1)
    const first = offered()[0]
    expect(first.kind).toBe('shortText')
    vi.advanceTimersByTime(10_000)
    expect(offered()).toHaveLength(1) // unchanged clipboard is not re-processed
    expect(JSON.stringify(first)).not.toContain('"fullText"')
  })

  it('baselines on enable so pre-existing clipboard content is not suggested', () => {
    text = 'Quarterly numbers look off for the north region'
    watcher.setFocused(true) // enabled -> offers
    watcher.dispose()
    events = []
    enabled = false
    watcher = make()
    text = 'Something copied long before the user opted in'
    enabled = true
    watcher.settingsChanged()
    watcher.setFocused(true)
    expect(offered()).toHaveLength(0)
    text = 'A brand new thing that was copied just now'
    vi.advanceTimersByTime(2_000)
    expect(offered()).toHaveLength(1)
  })

  it('rate-limits changes within 20 s and dedups repeats', () => {
    watcher.setFocused(true)
    text = 'The first interesting sentence copied here'
    vi.advanceTimersByTime(2_000)
    expect(offered()).toHaveLength(1)
    text = 'The second interesting sentence copied here'
    vi.advanceTimersByTime(2_000)
    expect(offered()).toHaveLength(1) // rate limited
    vi.advanceTimersByTime(SUGGEST_MIN_INTERVAL_MS)
    text = 'The third interesting sentence copied here'
    vi.advanceTimersByTime(2_000)
    expect(offered()).toHaveLength(2)
    vi.advanceTimersByTime(SUGGEST_MIN_INTERVAL_MS)
    text = 'The first interesting sentence copied here'
    vi.advanceTimersByTime(2_000)
    expect(offered()).toHaveLength(2) // same content hash as before
  })

  it('skips secrets and clears a stale chip when the clipboard moves to one', () => {
    watcher.setFocused(true)
    text = 'Quarterly numbers look off for the north region'
    vi.advanceTimersByTime(2_000)
    expect(offered()).toHaveLength(1)
    text = 'AKIAIOSFODNN7EXAMPLE'
    vi.advanceTimersByTime(2_000)
    expect(offered()).toHaveLength(1)
    expect(events[events.length - 1]).toBeNull()
    expect(watcher.getCurrent()).toBeNull()
  })

  it('does not even read the text when the owner excluded it', () => {
    watcher.setFocused(true)
    reads = 0
    excluded = true
    text = 'Quarterly numbers look off for the north region'
    vi.advanceTimersByTime(10_000)
    expect(reads).toBe(0)
    expect(offered()).toHaveLength(0)
  })

  it('truncates huge content, flags it, and ignores absurd sizes', () => {
    watcher.setFocused(true)
    text = 'word '.repeat(10_000)
    vi.advanceTimersByTime(2_000)
    const s = offered()[0]
    expect(s.truncated).toBe(true)
    expect(watcher.getFullText(s.id)!.length).toBeLessThanOrEqual(CLIPBOARD_MAX_CHARS)
    vi.advanceTimersByTime(SUGGEST_MIN_INTERVAL_MS)
    text = 'x '.repeat(CLIPBOARD_HARD_LIMIT_CHARS)
    vi.advanceTimersByTime(2_000)
    expect(offered()).toHaveLength(1)
  })

  it('hands the full text out only for the current id, and drops it on dismiss', () => {
    watcher.setFocused(true)
    text = 'Quarterly numbers look off for the north region'
    vi.advanceTimersByTime(2_000)
    const s = offered()[0]
    expect(watcher.getFullText('other')).toBeNull()
    expect(watcher.getFullText(s.id)).toBe(text)
    watcher.dismiss(s.id)
    expect(watcher.getFullText(s.id)).toBeNull()
    expect(watcher.getCurrent()).toBeNull()
  })

  it('stops reporting a chip after its visible window and frees the text after the TTL', () => {
    watcher.setFocused(true)
    text = 'Quarterly numbers look off for the north region'
    vi.advanceTimersByTime(2_000)
    const s = offered()[0]
    expect(watcher.getCurrent()).not.toBeNull()
    vi.advanceTimersByTime(CLIPBOARD_VISIBLE_MS)
    expect(watcher.getCurrent()).toBeNull()
    vi.advanceTimersByTime(CURRENT_TTL_MS)
    expect(watcher.getFullText(s.id)).toBeNull()
  })

  it('turning the setting off clears everything', () => {
    watcher.setFocused(true)
    text = 'Quarterly numbers look off for the north region'
    vi.advanceTimersByTime(2_000)
    const s = offered()[0]
    enabled = false
    watcher.settingsChanged()
    expect(watcher.getFullText(s.id)).toBeNull()
    const before = reads
    vi.advanceTimersByTime(60_000)
    expect(reads).toBe(before)
  })

  it('hashes deterministically', () => {
    expect(hashClipboardText('a')).toBe(hashClipboardText('a'))
    expect(hashClipboardText('a')).not.toBe(hashClipboardText('b'))
  })
})

describe('shared helpers', () => {
  it('builds prefills', () => {
    expect(buildClipboardPrefill('ask', 'Ask AI', 'why?')).toBe('why?')
    expect(buildClipboardPrefill('summarize', 'Summarize', 'text')).toBe('Summarize:\n\ntext')
  })

  it('validates IPC payloads', () => {
    const ok = { id: 'x', kind: 'url', preview: 'p', actions: ['summarize'], truncated: false }
    expect(isClipboardSuggestion(ok)).toBe(true)
    expect(isClipboardSuggestion({ ...ok, kind: 'nope' })).toBe(false)
    expect(isClipboardSuggestion({ ...ok, actions: [] })).toBe(false)
    expect(isClipboardSuggestion({ ...ok, actions: ['rm -rf'] })).toBe(false)
    expect(isClipboardSuggestion({ ...ok, preview: 'x'.repeat(500) })).toBe(false)
    expect(isClipboardSuggestion(null)).toBe(false)
  })
})
