import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { extractTags, wikiTags } from '../src/main/wiki-index'
import type { VaultFs } from '../src/main/wiki-index'

afterEach(() => vi.restoreAllMocks())

describe('extractTags', () => {
  it('finds #tags in prose and skips headings and code', () => {
    const text = [
      '# Heading\n',
      'note with #work and #work/urgent\n',
      '`#notatag` code\n',
      '```sh\n#comment\n```\n',
    ].join('')
    expect(extractTags(text)).toEqual(['work', 'work/urgent'])
  })
  it('skips pure numbers after the hash (they are rarely tags)', () => {
    expect(extractTags('issue #123 fixed')).toEqual([])
  })
  it('skips link fragments and URL hashes, which are anchors, not tags', () => {
    const text = [
      'see [intro](#heading) and [deep](Other.md#section) then #real\n',
      'https://example.com/#top and <https://a.b/#frag> and www.x.y/#nope #also\n',
    ].join('')
    expect(extractTags(text)).toEqual(['real', 'also'])
  })
})

const memFs = (files: Record<string, string>): VaultFs => ({
  list: async (_dir) => ({
    files: Object.keys(files).map((f) => f.split(/[\\/]/).pop()!),
    dirs: [],
  }),
  read: async (path) => files[path] ?? '',
  mtimeMs: async () => 1,
  statKind: async () => 'note',
})

describe('wikiTags', () => {
  it('collects tags across files with counts, most used first', async () => {
    const root = '/vault'
    const fs = memFs({
      [join(root, 'A.md')]: 'has #work and #urgent',
      [join(root, 'B.md')]: 'more #work',
      [join(root, 'C.md')]: 'no tags here',
    })
    const tags = await wikiTags(root, fs)
    expect(tags[0]).toEqual({ tag: 'work', files: [join(root, 'A.md'), join(root, 'B.md')] })
    expect(tags[1]!.tag).toBe('urgent')
  })
})
