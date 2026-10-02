import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as osJoin, win32 } from 'node:path'
import { isJunkPath, isProgramFile } from './junk'

// es.exe exists only on Windows and always answers with Windows paths
const { basename, join } = win32

/** One file found by name by Everything (the voidtools desktop search). */
export interface EverythingHit {
  path: string
  name: string
}

/** Exit code of es.exe when Everything itself is not running. */
const ES_NOT_RUNNING = 8
const QUERY_TIMEOUT_MS = 4_000
/** How long a "not available" answer is trusted before es.exe is tried again. */
const RETRY_AFTER_MS = 30_000
const MAX_WORDS = 12
/** Everything returns every file, junk included: ask for more than needed, then filter. */
const OVERSAMPLE = 8
const MAX_FETCH = 400

/** Where es.exe usually lives when it is not on PATH. */
function knownLocations(env: NodeJS.ProcessEnv): string[] {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA, env.ProgramW6432]
  const dirs = ['Everything', 'Everything 1.5a', 'Programs\\Everything']
  return roots.flatMap((root) => (root ? dirs.map((dir) => join(root, dir, 'es.exe')) : []))
}

/**
 * The words that go to es.exe. Everything has its own search syntax and es.exe its own options,
 * so anything that could be read as either (a leading "-" or "/", quotes, operators) is dropped:
 * a typed question must stay a plain name search.
 */
export function esQueryWords(query: string): string[] {
  return query
    .normalize('NFC')
    .split(/\s+/)
    .map((word) => word.replace(/["<>|!]/g, '').replace(/^[-/]+/, ''))
    .filter((word) => word.length > 0)
    .slice(0, MAX_WORDS)
}

/** Minimal CSV reader for es.exe's export: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((cell) => cell !== '')) rows.push(row)
      row = []
    } else field += ch
  }
  row.push(field)
  if (row.some((cell) => cell !== '')) rows.push(row)
  return rows
}

/** Turn es.exe's CSV (header row, then Name/Path columns or one full-path column) into hits. */
export function parseEsCsv(text: string): EverythingHit[] {
  const rows = parseCsv(text)
  const header = rows.shift()
  if (!header) return []
  const find = (...names: string[]): number =>
    header.findIndex((cell) => names.includes(cell.trim().toLowerCase()))
  const nameColumn = find('name')
  const pathColumn = find('path')
  const fullColumn = find('filename', 'full path', 'full path and name')
  const hits: EverythingHit[] = []
  for (const row of rows) {
    const folder = pathColumn >= 0 ? (row[pathColumn] ?? '') : ''
    const name = nameColumn >= 0 ? (row[nameColumn] ?? '') : ''
    const path =
      nameColumn >= 0 && pathColumn >= 0
        ? folder && name
          ? join(folder, name)
          : ''
        : (row[fullColumn >= 0 ? fullColumn : 0] ?? '')
    if (path) hits.push({ path, name: basename(path) })
  }
  return hits
}

export type EsRunner = (
  file: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number | null; missing?: boolean }>

const runEs: EsRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs }, (error) => {
      if (!error) return resolve({ code: 0 })
      const failure = error as NodeJS.ErrnoException & { code?: number | string }
      if (failure.code === 'ENOENT') return resolve({ code: null, missing: true })
      resolve({ code: typeof failure.code === 'number' ? failure.code : null })
    })
  })

export interface EverythingOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** a path the user set in Settings; tried before the usual places */
  configuredPath?: () => string | undefined
  /** false when the person turned the feature off */
  enabled?: () => boolean
  run?: EsRunner
  exists?: (path: string) => boolean
  now?: () => number
}

/**
 * File-name search through Everything's command-line client (es.exe). Everything keeps every
 * file name of an NTFS drive in memory and follows changes as they happen, so this answers at
 * once and is never behind. It is optional: without es.exe, or with Everything not running,
 * every call quietly returns nothing and the caller carries on with its own index.
 */
export class EverythingSearch {
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private readonly run: EsRunner
  private readonly exists: (path: string) => boolean
  private readonly now: () => number
  private readonly configuredPath: () => string | undefined
  private readonly enabled: () => boolean
  private unavailableUntil = 0
  /** cleared the first time an es.exe turns out not to accept the sort option */
  private sortWorks = true

  constructor(options: EverythingOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.env = options.env ?? process.env
    this.run = options.run ?? runEs
    this.exists = options.exists ?? existsSync
    this.now = options.now ?? Date.now
    this.configuredPath = options.configuredPath ?? (() => undefined)
    this.enabled = options.enabled ?? (() => true)
  }

  /** The es.exe to run, or null when this computer has none. */
  locate(): string | null {
    if (this.platform !== 'win32' || !this.enabled()) return null
    const candidates = [this.configuredPath(), ...knownLocations(this.env)]
    for (const candidate of candidates) if (candidate && this.exists(candidate)) return candidate
    // PATH: es.exe is often just unzipped next to a folder that is on it
    for (const dir of (this.env.PATH ?? this.env.Path ?? '').split(';')) {
      const candidate = dir ? join(dir.replace(/^"|"$/g, ''), 'es.exe') : ''
      if (candidate && this.exists(candidate)) return candidate
    }
    return null
  }

  /**
   * Files whose name matches every word typed, newest first, system and cache files left out.
   * Whole words are tried first ("mỹ lệ" must not match "MyFile" or "Barthelemy"); only when
   * that leaves too few files does it look for the words inside longer ones.
   */
  async search(query: string, limit: number): Promise<EverythingHit[]> {
    if (this.now() < this.unavailableUntil) return []
    const words = esQueryWords(query)
    const esPath = words.length ? this.locate() : null
    if (!esPath) return []
    const dir = await mkdtemp(osJoin(tmpdir(), 'genoffice-es-'))
    try {
      const found = new Map<string, EverythingHit>()
      for (const wholeWord of [true, false]) {
        const hits = await this.ask(esPath, osJoin(dir, 'result.csv'), words, limit, wholeWord)
        if (hits === null) return []
        for (const hit of hits) found.set(hit.path.toLowerCase(), hit)
        if (found.size >= limit) break
      }
      return [...found.values()].slice(0, limit)
    } catch {
      return []
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** One es.exe run; null when Everything cannot answer at all (not running, or failed). */
  private async ask(
    esPath: string,
    out: string,
    words: string[],
    limit: number,
    wholeWord: boolean,
  ): Promise<EverythingHit[] | null> {
    const fetch = Math.min(MAX_FETCH, Math.max(limit, 1) * OVERSAMPLE)
    // Written to a file: es.exe prints through the console code page when piped, which turns
    // Vietnamese letters into "?"; the export is UTF-8.
    const args = (sorted: boolean): string[] => [
      '-n',
      String(fetch),
      ...(wholeWord ? ['-whole-word'] : []),
      ...(sorted ? ['-sort', 'date-modified-descending'] : []),
      '-name',
      '-path-column',
      '-export-csv',
      out,
      '-utf8-bom',
      ...words,
    ]
    let result = await this.run(esPath, args(this.sortWorks), QUERY_TIMEOUT_MS)
    // an older es.exe may not know the sort option: the order is a nicety, the answer is not
    if (!result.missing && result.code !== 0 && result.code !== ES_NOT_RUNNING && this.sortWorks) {
      result = await this.run(esPath, args(false), QUERY_TIMEOUT_MS)
      if (result.code === 0) this.sortWorks = false
    }
    if (result.missing || result.code === ES_NOT_RUNNING) {
      this.unavailableUntil = this.now() + RETRY_AFTER_MS
      return null
    }
    if (result.code !== 0) return null
    const hits = parseEsCsv(await readFile(out, 'utf8'))
    return hits.filter((hit) => !isJunkPath(hit.path) && !isProgramFile(hit.path))
  }
}
