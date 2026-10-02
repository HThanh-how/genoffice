import type { HomeApi } from '../../../shared/home-api'
import { nameWords, normalizeDocumentText } from '../../../main/document-memory/normalization'

export interface NamedFile {
  path: string
  name: string
}

/**
 * Files whose NAME fits what the person typed, from the recent list and the folder file index.
 * These need no document reading, so a file just opened or never indexed is still found.
 */
export async function findFilesByName(
  api: HomeApi,
  query: string,
  limit = 6,
): Promise<NamedFile[]> {
  const words = nameWords(query)
  if (words.length === 0) return []
  const need = words.length <= 2 ? words.length : Math.ceil(words.length * 0.6)
  const [recent, found] = await Promise.allSettled([
    api.recents({ limit: 300 }),
    api.searchFiles({ q: words.join(' '), limit }),
  ])
  const out: NamedFile[] = []
  const seen = new Set<string>()
  const add = (file: { path: string; name: string }) => {
    if (seen.has(file.path) || out.length >= limit) return
    seen.add(file.path)
    out.push({ path: file.path, name: file.name })
  }
  if (recent.status === 'fulfilled') {
    for (const entry of recent.value.entries) {
      const folded = normalizeDocumentText(entry.name)
      const joined = folded.replace(/ /g, '')
      let matched = 0
      for (const word of words) if (folded.includes(word) || joined.includes(word)) matched++
      if (matched >= need) add(entry)
    }
  }
  if (found.status === 'fulfilled') for (const hit of found.value.hits) add(hit)
  return out
}
