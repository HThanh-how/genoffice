import type {
  DocumentMemoryBridge,
  DocumentMemoryHit,
  DocumentMemoryReadResult,
  DocumentMemorySearchResult,
} from '@genoffice/agent-core'
import type { HomeChatSource } from '../../../shared/fork/home-chat-types'

/**
 * File citations for the Home assistant.
 *
 * Every file the model can talk about (a remembered-document hit, a file found by name) gets a
 * short id in a per-conversation table. The model is asked to write `[[file:ID]]` after each file
 * it mentions; the renderer maps the id back to the real source (document id, path, flags) and
 * draws a clickable file chip there. Nothing the model writes is ever used as a path: only files
 * that are in the table can become links. Everything in this module is pure.
 */

/** Scheme of the in-text link the answer is rewritten to before it reaches the Markdown renderer. */
export const FILE_LINK_SCHEME = 'genoffice-file:'
/** Most files offered under one answer. */
export const MAX_CITED_FILES = 8

const norm = (text: string): string => text.normalize('NFC').replace(/\s+/g, ' ').trim()
const fold = (text: string): string => norm(text).toLocaleLowerCase()

/** One key per file: its path when known (slashes and case ignored), else its document id. */
function pathKey(path: string | undefined): string {
  return path ? `p:${path.replace(/\\/g, '/').normalize('NFC').toLowerCase()}` : ''
}

const clean = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * The files of one conversation (or one agy turn), numbered from 1 in the order they were first
 * seen. A file keeps its id however many passages or searches return it.
 */
export class FileRefTable {
  private readonly byRef = new Map<number, HomeChatSource>()
  private readonly byKey = new Map<string, number>()
  private next = 1

  /** The id the next new file will get. */
  peekNext(): number {
    return this.next
  }

  get size(): number {
    return this.byRef.size
  }

  get(ref: number): HomeChatSource | undefined {
    return this.byRef.get(ref)
  }

  has(ref: number): boolean {
    return this.byRef.has(ref)
  }

  /** All files in id order. The returned objects are copies, safe to keep in React state. */
  list(): HomeChatSource[] {
    return [...this.byRef.values()].map((source) => ({ ...source }))
  }

  /** The id of a file already in the table, by path. */
  refForPath(path: string | undefined): number | undefined {
    const key = pathKey(path)
    return key ? this.byKey.get(key) : undefined
  }

  /** The file already in the table for this document id / path. */
  lookup(documentId: number, path: string | undefined): HomeChatSource | undefined {
    const byPath = this.byKey.get(pathKey(path))
    const byId = documentId > 0 ? this.byKey.get(`d:${documentId}`) : undefined
    const ref = byPath ?? byId
    return ref === undefined ? undefined : this.byRef.get(ref)
  }

  private index(source: HomeChatSource): void {
    const ref = source.ref!
    if (source.path) this.byKey.set(pathKey(source.path), ref)
    if (source.documentId > 0) this.byKey.set(`d:${source.documentId}`, ref)
  }

  /** Adds a remembered-document hit (or merges another passage of a document already there). */
  addHit(hit: DocumentMemoryHit): HomeChatSource {
    const flags = hit as DocumentMemoryHit & { unverified?: boolean; skeletonIndex?: boolean }
    const existing = this.lookup(hit.documentId, hit.path)
    const source: HomeChatSource = existing ?? {
      documentId: hit.documentId,
      ref: this.next++,
      name: clean(hit.name),
      location: clean(hit.location),
      ...(hit.path ? { path: hit.path } : {}),
      ...(typeof hit.indexedAt === 'number' ? { modifiedAt: hit.indexedAt } : {}),
    }
    if (existing) {
      // a file first seen by name only gains its document id once a search returns it
      if (existing.documentId === 0 && hit.documentId > 0) existing.documentId = hit.documentId
      if (!existing.path && hit.path) existing.path = hit.path
      const location = clean(hit.location)
      const known = existing.location.split(' · ')
      if (location && !known.includes(location) && known.length < 3)
        existing.location = `${existing.location} · ${location}`.replace(/^ · /, '')
    }
    if (flags.stale === true) source.stale = true
    if (flags.missing === true) source.missing = true
    if (flags.unverified === true) source.unverified = true
    if (flags.skeletonIndex === true) source.skeletonIndex = true
    this.byRef.set(source.ref!, source)
    this.index(source)
    return source
  }

  /** Adds a file found by name only (no document id). */
  addFile(file: { path: string; name: string; mtimeMs?: number }): HomeChatSource {
    const existing = this.lookup(0, file.path)
    if (existing) {
      if (existing.modifiedAt === undefined && typeof file.mtimeMs === 'number')
        existing.modifiedAt = file.mtimeMs
      return existing
    }
    const source: HomeChatSource = {
      documentId: 0,
      ref: this.next++,
      path: file.path,
      name: clean(file.name),
      location: '',
      ...(typeof file.mtimeMs === 'number' ? { modifiedAt: file.mtimeMs } : {}),
    }
    this.byRef.set(source.ref!, source)
    this.index(source)
    return source
  }
}

// ---- model-facing wording -----------------------------------------------------------------

const RULES_COMMON =
  'File citations: every file you can talk about has an id. Whenever your answer mentions a file, write its file name followed by its marker [[file:ID]] (for example: Report.docx [[file:3]]); the application turns the marker into a link that opens the file. ' +
  'Use only ids that were given to you and never invent one. Mention each relevant file once, with a one-line reason, and only files your answer actually relies on. ' +
  'Never print internal details as part of the answer: no chunk numbers or page locations such as "Chunk 5", no status words such as OK, STALE, MISSING, PARTIAL, UNREAD or OUTLINE, no "(Trạng thái: OK)", and no bare bracketed ids. ' +
  'If a file is changed or missing say so in plain words instead. These rules replace any earlier instruction to cite a source path or chunk location in the prose.'

/** Citation rules for the retrieval-first prompt (agy): the id is the number in brackets. */
export const FILE_CITATION_RULES_CONTEXT = `${RULES_COMMON} The id of a file is the number in square brackets at the start of its entry in the results.`

/** Citation rules for providers that call the document tools: the id is the hit's \`ref\` field. */
export const FILE_CITATION_RULES_TOOLS = `${RULES_COMMON} The id of a file is the \`ref\` number on each search hit; a file keeps the same ref in every search of this conversation.`

/**
 * Sources saved before ids existed have none: give them ones above any id a model can write
 * (markers hold up to three digits), so their names can still be linked in the text.
 */
export function withRefs(
  sources: readonly HomeChatSource[] | undefined,
): HomeChatSource[] | undefined {
  if (!sources || sources.every((source) => source.ref !== undefined))
    return sources as HomeChatSource[] | undefined
  return sources.map((source, index) =>
    source.ref === undefined ? { ...source, ref: 1000 + index } : source,
  )
}

// ---- reading the answer -------------------------------------------------------------------

const NUMS = String.raw`(\d{1,3}(?:\s*[,;&]\s*(?:file\s*[:#]?\s*)?\d{1,3})*)`
/** `[[file:3]]`, `[file:3]`, `[[3]]`, `[[file:3, 5]]`; never a markdown link `[x](url)`. */
const MARKER_RE = new RegExp(
  String.raw`\[\[\s*(?:(?:file|files|tệp|tep|id)\s*[:#]?\s*)?${NUMS}\s*\]\]|\[\s*(?:file|files|tệp|tep|id)\s*[:#]?\s*${NUMS}\s*\](?!\()`,
  'giu',
)
/** A bare `[3]` is read as a citation only when 3 is a known id (and never before `(`). */
const BARE_RE = /\[(\d{1,3})\](?!\()/g
/** The end of a streamed text that may still turn into a marker. */
const PARTIAL_MARKER_RE = /\[{1,2}[A-Za-zÀ-ỹ]{0,5}\s?[:#]?\s?[\d,;& ]{0,12}\]?$/u

/** The text without a half-written marker at its end, so `[[fi` never flashes while streaming. */
export function hidePartialMarker(text: string): string {
  const match = PARTIAL_MARKER_RE.exec(text)
  if (!match) return text
  return text.slice(0, match.index).replace(/ $/, '')
}

const idsOf = (body: string): number[] =>
  [...body.matchAll(/\d{1,3}/g)].map((digits) => Number(digits[0])).filter((n) => n > 0)

interface Span {
  start: number
  end: number
  refs: number[]
  kind: 'marker' | 'name'
}

/** Markers in the text, in order. Unknown ids are returned too (as empty `refs`) so they can be dropped. */
function markerSpans(text: string, known: ReadonlySet<number>): Span[] {
  const spans: Span[] = []
  const taken = (start: number, end: number) =>
    spans.some((span) => start < span.end && end > span.start)
  for (const match of text.matchAll(MARKER_RE)) {
    const body = match[1] ?? match[2] ?? ''
    let start = match.index ?? 0
    let end = start + match[0].length
    // "([[file:3]])" is one marker with its own parentheses
    if (text[start - 1] === '(' && text[end] === ')') {
      start -= 1
      end += 1
    }
    spans.push({ start, end, refs: idsOf(body).filter((ref) => known.has(ref)), kind: 'marker' })
  }
  for (const match of text.matchAll(BARE_RE)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    const ref = Number(match[1])
    if (known.has(ref) && !taken(start, end))
      spans.push({ start, end, refs: [ref], kind: 'marker' })
  }
  return spans.sort((a, b) => a.start - b.start)
}

const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['***', '***'],
  ['**', '**'],
  ['__', '__'],
  ['`', '`'],
  ['*', '*'],
  ['“', '”'],
  ['"', '"'],
  ['‘', '’'],
  ["'", "'"],
  ['«', '»'],
]

const isWordChar = (ch: string | undefined): boolean => !!ch && /[\p{L}\p{N}_]/u.test(ch)

/** True when `index` sits inside an unfinished `inline code` span of its line or a fenced block. */
function insideCode(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1
  const ticks = text.slice(lineStart, index).split('`').length - 1
  if (ticks % 2 === 1) return true
  const fences = text.slice(0, lineStart).match(/^\s*(?:```|~~~)/gm)
  return !!fences && fences.length % 2 === 1
}

/**
 * Where the model wrote the name of a known file. Longer names win over names they contain
 * ("Report (1).docx" over "Report.docx"); a name wrapped in `code`, **bold** or quotes is taken
 * together with its wrapper. The name without its extension also counts when it is long enough
 * to be unambiguous.
 */
function nameSpans(text: string, sources: readonly HomeChatSource[]): Span[] {
  const spans: Span[] = []
  const haystack = text.toLocaleLowerCase()
  // a lowercase form of a different length would shift every offset: match case-sensitively then
  const folded = haystack.length === text.length ? haystack : text
  const needles: Array<{ needle: string; ref: number }> = []
  for (const source of sources) {
    if (source.ref === undefined || !source.name) continue
    const name = norm(source.name)
    needles.push({ needle: name.toLocaleLowerCase(), ref: source.ref })
    const base = name.replace(/\.[A-Za-z0-9]{1,8}$/, '')
    if (base !== name && base.length >= 10)
      needles.push({ needle: base.toLocaleLowerCase(), ref: source.ref })
  }
  needles.sort((a, b) => b.needle.length - a.needle.length)
  const used: Array<[number, number]> = []
  for (const { needle, ref } of needles) {
    if (!needle) continue
    let from = 0
    for (;;) {
      const at = folded.indexOf(needle, from)
      if (at < 0) break
      from = at + needle.length
      const end = at + needle.length
      if (isWordChar(text[at - 1]) || isWordChar(text[end])) continue
      if (used.some(([s, e]) => at < e && end > s)) continue
      let start = at
      let stop = end
      let wrapped = false
      for (const [open, close] of PAIRS) {
        if (text.slice(start - open.length, start) === open && text.startsWith(close, stop)) {
          start -= open.length
          stop += close.length
          wrapped = true
          break
        }
      }
      if (!wrapped && insideCode(text, at)) continue
      used.push([start, stop])
      spans.push({ start, end: stop, refs: [ref], kind: 'name' })
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

export interface LinkedAnswer {
  /** the answer with each file mention rewritten to `[file](genoffice-file:ID)` */
  markdown: string
  /** ids of the files the answer mentions, in the order they appear, once each */
  cited: number[]
}

const link = (ref: number) => `[file](${FILE_LINK_SCHEME}${ref})`
/** Href of the link that carries the one-line reason after a file (rendered as secondary text). */
export const FILE_NOTE_HREF = `${FILE_LINK_SCHEME}note`

const CHIP = String.raw`\[file\]\(${FILE_LINK_SCHEME}\d+\)`
/** A line that starts with file chips ("- ", "1. " allowed), then "— reason" / ": reason" / " - reason". */
const NOTE_LINE = new RegExp(
  String.raw`^(\s*(?:[-*•]\s+|\d+[.)]\s+)?${CHIP}(?:(?:\s*(?:&|,|\+|và|and)\s*|\s+)${CHIP})*)\s*(?:[—–:]|\s-)\s*(\S.*)$`,
  'u',
)

/** Marks the reason that follows the file(s) at the start of a line, so it can be shown as secondary text. */
function markNotes(markdown: string): string {
  if (!markdown.includes(FILE_LINK_SCHEME)) return markdown
  let fenced = false
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced
      if (fenced || !line.includes(FILE_LINK_SCHEME)) return line
      const match = NOTE_LINE.exec(line)
      if (!match) return line
      // a label cannot hold brackets or inline markup: keep such lines as they are
      const note = match[2]!
      if (/[[\]]/.test(note)) return line
      return `${match[1]} [— ${note.replace(/[*`_]/g, '')}](${FILE_NOTE_HREF})`
    })
    .join('\n')
}

/**
 * Rewrites the answer so every file it mentions is a link the renderer turns into a chip.
 * `streaming` keeps the pass cheap and stable: only explicit markers are linked (plain names
 * stay text until the answer is complete), and a half-written marker is hidden.
 */
export function linkAnswer(
  rawText: string,
  sources: readonly HomeChatSource[],
  options: { streaming?: boolean } = {},
): LinkedAnswer {
  let text = rawText.normalize('NFC')
  if (options.streaming) text = hidePartialMarker(text)
  const known = new Set<number>()
  for (const source of sources) if (source.ref !== undefined) known.add(source.ref)
  const markers = markerSpans(text, known)
  const names = options.streaming ? [] : nameSpans(text, sources)

  // a marker right after the name of the same file (or inside it) is the same mention
  const merged: Span[] = []
  const all = [...names, ...markers].sort((a, b) => a.start - b.start || b.end - a.end)
  for (const span of all) {
    const last = merged.at(-1)
    if (last && span.start < last.end) continue // overlapped: the earlier span already covers it
    if (
      last &&
      span.kind === 'marker' &&
      last.kind === 'name' &&
      span.refs.length > 0 &&
      span.refs.every((ref) => last.refs.includes(ref)) &&
      /^[\s]*$/.test(text.slice(last.end, span.start))
    ) {
      last.end = span.end
      continue
    }
    merged.push({ ...span })
  }

  let out = ''
  let cursor = 0
  const cited: number[] = []
  for (const span of merged) {
    let before = text.slice(cursor, span.start)
    if (span.refs.length === 0) before = before.replace(/ $/, '') // an unknown marker just disappears
    out += before
    out += span.refs.map(link).join(' ')
    for (const ref of span.refs) if (!cited.includes(ref)) cited.push(ref)
    cursor = span.end
  }
  out += text.slice(cursor)
  return { markdown: markNotes(out), cited }
}

/** Plain text of an answer: markers removed and, where the name was not written, replaced by it. */
export function plainAnswer(text: string, sources: readonly HomeChatSource[]): string {
  const known = new Set<number>()
  for (const source of sources) if (source.ref !== undefined) known.add(source.ref)
  const normalized = text.normalize('NFC')
  let out = ''
  let cursor = 0
  for (const span of markerSpans(normalized, known)) {
    out += normalized.slice(cursor, span.start)
    cursor = span.end
    const written = fold(out.replace(/[\s`*_"'“”‘’«»(]+$/u, ''))
    const missing = span.refs
      .map((ref) => sources.find((source) => source.ref === ref)?.name ?? '')
      .filter((name) => name && !written.endsWith(fold(name)))
    if (missing.length === 0) out = out.replace(/ $/, '')
    else out += missing.join(', ')
  }
  return out + normalized.slice(cursor)
}

export interface PickedSources {
  sources: HomeChatSource[]
  /** nothing was cited: these are the retrieved files, offered as related */
  related: boolean
}

/**
 * The files to offer under an answer: the ones it cites (markers, then names), in order of
 * citation, at most {@link MAX_CITED_FILES}. Only when it cites none, the retrieved files stand
 * in, flagged `related`.
 */
export function pickSources(
  text: string,
  candidates: readonly HomeChatSource[],
  options: { fallback?: boolean; pool?: readonly HomeChatSource[] } = {},
): PickedSources {
  const { cited } = linkAnswer(text, candidates)
  const byRef = new Map(candidates.map((source) => [source.ref, source] as const))
  const picked = cited
    .map((ref) => byRef.get(ref))
    .filter((source): source is HomeChatSource => !!source)
    .slice(0, MAX_CITED_FILES)
    .map((source) => ({ ...source }))
  const pool = options.pool ?? candidates
  if (picked.length > 0 || options.fallback === false || !text.trim())
    return { sources: picked, related: false }
  return {
    sources: pool.slice(0, MAX_CITED_FILES).map((source) => ({ ...source, related: true })),
    related: pool.length > 0,
  }
}

/**
 * The document-memory bridge the tool-calling providers use, with every file numbered: each search
 * hit gains a `ref` (the id to cite) and a read result gains the `ref` of its file. The model sees
 * these in the tool output, the renderer resolves the same ids from the table.
 */
export function refBridge(
  bridge: DocumentMemoryBridge,
  table: () => FileRefTable,
): DocumentMemoryBridge {
  const out: DocumentMemoryBridge = {}
  const { documentMemorySearch, documentMemoryRead, documentMemoryOpen } = bridge
  if (documentMemorySearch) {
    out.documentMemorySearch = async (query, limit) => {
      const result = await documentMemorySearch(query, limit)
      const files = table()
      const hits = (result.hits ?? []).map((hit) => {
        const usable = Number.isSafeInteger(hit.documentId) && (hit.documentId > 0 || !!hit.path)
        return usable ? { ...hit, ref: files.addHit(hit).ref } : hit
      })
      return { ...result, hits: hits as DocumentMemorySearchResult['hits'] }
    }
  }
  if (documentMemoryRead) {
    out.documentMemoryRead = async (chunkId): Promise<DocumentMemoryReadResult> => {
      const result = await documentMemoryRead(chunkId)
      const ref = table().refForPath(result.path)
      return ref === undefined ? result : ({ ...result, ref } as DocumentMemoryReadResult)
    }
  }
  if (documentMemoryOpen) out.documentMemoryOpen = documentMemoryOpen
  return out
}
