import type { HomeApi } from '../../../shared/home-api'
import { nameWords, normalizeDocumentText } from '../../../main/document-memory/normalization'

export interface NamedFile {
  path: string
  name: string
  /** last modified, when the list it came from knows it */
  mtimeMs?: number
}

interface ScoredFile extends NamedFile {
  /** Exact basenames and prefixes should beat broad matches from the recent list. */
  score: number
}

function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (b.length > a.length) j++
    else {
      i++
      j++
    }
  }
  return edits + Number(i < a.length || j < b.length) <= 1
}

function nameScore(name: string, path: string, words: readonly string[], minimum: number): number {
  const scoreWords = [...words]
  // `nameWords` appends the equivalent form when it sees "ra viện" / "xuất viện".
  if (scoreWords.includes('ra') && scoreWords.includes('xuat')) {
    const alias = scoreWords.at(-1)
    if (alias === 'ra' || alias === 'xuat') scoreWords.pop()
  }
  const folded = normalizeDocumentText(name.replace(/\.[^.]+$/, ''))
  const joined = folded.replace(/ /g, '')
  const query = scoreWords.join(' ')
  const compactQuery = scoreWords.join('')
  const exactBasename = folded === query || joined === compactQuery
  const prefixBasename = folded.startsWith(query) || joined.startsWith(compactQuery)
  // A filename may join the typed words in camel case or separators (e.g. MyLe-2).
  // Preserve that useful basename match even though its token boundaries differ.
  if (exactBasename) return 140
  if (prefixBasename) return 130
  if (joined.includes(compactQuery)) return 115

  const parentEnd = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const parent = parentEnd >= 0 ? path.slice(0, parentEnd) : ''
  const nameTokens = folded.split(' ').filter(Boolean)
  const allTokens = [...nameTokens, ...normalizeDocumentText(parent).split(' ').filter(Boolean)]
  let exact = 0
  let prefix = 0
  let typo = 0
  for (const word of scoreWords) {
    if (allTokens.some((token) => token === word)) exact++
    else if (allTokens.some((token) => token.startsWith(word))) prefix++
    else if (word.length >= 4 && allTokens.some((token) => oneEditApart(token, word))) typo++
  }
  const matched = exact + prefix + typo
  if (matched < minimum) return 0
  if (matched === scoreWords.length && typo === 0) {
    const basenameCoverage =
      nameTokens.filter((token) => scoreWords.includes(token)).length / scoreWords.length
    if (exactBasename) return 140
    if (prefixBasename) return 130
    return 110 + (exact / scoreWords.length) * 5 + basenameCoverage
  }
  if (matched === scoreWords.length)
    return 90 + (exact / scoreWords.length) * 5 + (prefix / scoreWords.length) * 2
  return (matched / scoreWords.length) * 50 + exact * 0.01 + prefix * 0.001
}

/**
 * Files whose NAME fits what the person typed, from the recent list and the folder file index.
 * These need no document reading, so a file just opened or never indexed is still found.
 */
export async function findFilesByName(
  api: HomeApi,
  query: string,
  limit = 6,
  /** how many the folder index is asked for before scoring (a name shared by dozens of files needs more than `limit`) */
  fetchLimit = limit,
): Promise<NamedFile[]> {
  const words = nameWords(query)
  if (words.length === 0) return []
  const need = words.length <= 2 ? words.length : Math.ceil(words.length * 0.6)
  const [recent, found] = await Promise.allSettled([
    api.recents({ limit: 300 }),
    api.searchFiles({ q: words.join(' '), limit: Math.max(limit, fetchLimit) }),
  ])
  const byPath = new Map<string, ScoredFile>()
  const add = (file: { path: string; name: string; mtimeMs?: number }) => {
    const score = nameScore(file.name, file.path, words, need)
    if (score <= 0) return
    const previous = byPath.get(file.path)
    if (!previous || score > previous.score) byPath.set(file.path, { ...file, score })
  }
  if (recent.status === 'fulfilled') {
    for (const entry of recent.value.entries) {
      add(entry)
    }
  }
  if (found.status === 'fulfilled') for (const hit of found.value.hits) add(hit)
  return [...byPath.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ path, name, mtimeMs }) => ({
      path,
      name,
      ...(typeof mtimeMs === 'number' ? { mtimeMs } : {}),
    }))
}
