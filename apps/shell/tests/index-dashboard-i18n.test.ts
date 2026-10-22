import { describe, expect, it } from 'vitest'
import { EN, TEXT } from '../src/renderer/src/fork/index-dashboard-i18n'

type Tree = { [key: string]: string | Tree }

function flatten(tree: Tree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out[path] = value
    else Object.assign(out, flatten(value, path))
  }
  return out
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('Index screen dictionary', () => {
  const english = flatten(EN as unknown as Tree)

  it('ships English, Vietnamese and both Chinese tables', () => {
    expect(Object.keys(TEXT).sort()).toEqual(['en', 'vi', 'zh', 'zh-TW'])
  })

  for (const [lang, dict] of Object.entries(TEXT)) {
    it(`${lang}: same keys and same placeholders as English, nothing left blank`, () => {
      const flat = flatten(dict as unknown as Tree)
      expect(Object.keys(flat).sort()).toEqual(Object.keys(english).sort())
      for (const [key, text] of Object.entries(flat)) {
        expect(text.trim().length, `${lang} ${key} is empty`).toBeGreaterThan(0)
        expect(placeholders(text), `${lang} ${key} placeholders`).toEqual(
          placeholders(english[key]!),
        )
      }
    })
  }
})
