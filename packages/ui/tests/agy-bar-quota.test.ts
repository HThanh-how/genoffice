// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AgyChatBar, type AgyBarApi, type AgyBarUsage } from '../src/AgyChatBar'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

function usageOf(remaining: number | null, extra: Partial<AgyBarUsage> = {}): AgyBarUsage {
  return {
    groups: remaining === null ? null : [{ name: 'flash', buckets: [{ window: '5h', remaining }] }],
    readAt: Date.now(),
    refreshing: false,
    failed: false,
    ...extra,
  }
}

async function mount(usage: AgyBarUsage, listeners: string[] = []): Promise<HTMLElement> {
  const api: AgyBarApi = {
    getAgyChatState: async () => ({
      active: true,
      selected: 'f',
      models: [{ id: 'f', label: 'F', group: 'flash', relativeCost: 1, speed: 'fast' }],
    }),
    selectAgyChatModel: async () => true,
    getAgyChatUsage: async () => usage,
    refreshAgyChatUsage: async () => usage,
    onAgyChatUsage: () => () => {},
    onAgyChatActivity: () => {
      listeners.push('activity')
      return () => {}
    },
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(createElement(AgyChatBar, { lang: 'en', api, part: 'bar', showModel: false })),
  )
  return host
}

describe('AgyChatBar usage chip', () => {
  it('always shows once there is a reading, even when quota is comfortable', async () => {
    const chip = (await mount(usageOf(0.8))).querySelector('.agy-bar-usage')
    expect(chip?.textContent).toContain('80% left')
    expect(chip?.classList.contains('is-ok')).toBe(true)
  })

  it('stays hidden with no reading at all', async () => {
    expect((await mount(usageOf(null))).querySelector('.agy-bar-usage')).toBeNull()
  })

  it('20% left is warn, never red', async () => {
    const chip = (await mount(usageOf(0.199))).querySelector('.agy-bar-usage')
    expect(chip?.textContent).toContain('20% left')
    expect(chip?.classList.contains('is-warn')).toBe(true)
    expect(chip?.classList.contains('is-low')).toBe(false)
  })

  it('is red at 19% left', async () => {
    const chip = (await mount(usageOf(0.19))).querySelector('.agy-bar-usage')
    expect(chip?.classList.contains('is-low')).toBe(true)
  })

  it('shows when sign-in is needed, even with no numbers', async () => {
    const el = await mount(usageOf(null, { needsLogin: true, failed: true }))
    expect(el.querySelector('.agy-bar-usage')).not.toBeNull()
  })

  it('part=bar never subscribes to run activity', async () => {
    const listeners: string[] = []
    await mount(usageOf(0.1), listeners)
    expect(listeners).toHaveLength(0)
  })
})
