// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { IndexCardHeading } from '../src/renderer/src/fork/IndexCard'
import { SettingsCard } from '../src/renderer/src/fork/settings-ui/SettingsCard'
import { indexV2Copy, indexV2Words } from '../src/renderer/src/i18n/strings-index-v2'
import { settingsCardCopy } from '../src/renderer/src/i18n/strings-settings-card'
import { strings } from '../src/renderer/src/strings'

describe('merged Index and Settings cards', () => {
  it('styles the icon, stacked text and hint in both heading contexts', () => {
    const style = document.createElement('style')
    style.textContent = readFileSync(
      resolve('src/renderer/src/fork/settings-ui/settings-card.css'),
      'utf8',
    )
    const host = document.createElement('div')
    host.innerHTML =
      renderToStaticMarkup(
        createElement(SettingsCard, { title: 'Settings', subtitle: 'Hint', children: null }),
      ) +
      renderToStaticMarkup(
        createElement(IndexCardHeading, { title: 'Index', hint: 'Hint', icon: null }),
      )
    document.head.append(style)
    document.body.append(host)
    try {
      const headings = host.querySelectorAll('.set-group-title')
      expect(headings).toHaveLength(2)
      for (const heading of headings) {
        const icon = getComputedStyle(heading.querySelector('.set-group-icon')!)
        const text = getComputedStyle(heading.querySelector('.set-group-text')!)
        const hint = getComputedStyle(heading.querySelector('.set-group-hint')!)
        expect(icon.display).toBe('grid')
        expect(icon.width).toBe('40px')
        expect(text.display).toBe('flex')
        expect(text.flexDirection).toBe('column')
        expect(hint.fontSize).toBe('12px')
      }
    } finally {
      host.remove()
      style.remove()
    }
  })

  it('keeps both new locale maps complete with English fallbacks', () => {
    const keys = (copy: object) => Object.keys(copy).sort()
    for (const lang of Object.keys(strings)) {
      expect(keys(settingsCardCopy(lang))).toEqual(keys(settingsCardCopy('en')))
    }
    for (const copy of Object.values(indexV2Copy)) {
      expect(keys(copy)).toEqual(keys(indexV2Copy.zh!))
      expect(Object.values(copy).every((value) => value.trim().length > 0)).toBe(true)
    }
    expect(indexV2Words('unknown')).toBe(indexV2Copy.en)
    expect(settingsCardCopy('unknown')).toBe(settingsCardCopy('en'))
  })
})
