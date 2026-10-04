/**
 * @vitest-environment jsdom
 */
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HomeApi } from '../src/shared/home-api'
import { LocaleProvider } from '../src/renderer/src/locale'
import { PdfPagesSettings } from '../src/renderer/src/fork/PdfPagesSettings'
import { EmbeddingModelSettings } from '../src/renderer/src/fork/EmbeddingModelSettings'
import { DbLocationSettings } from '../src/renderer/src/fork/DbLocationSettings'
import { EverythingSettings } from '../src/renderer/src/fork/EverythingSettings'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(node: ReactNode, lang: 'en' | 'vi' | 'zh' = 'en') {
  await act(async () => {
    root.render(createElement(LocaleProvider, { initial: lang }, node))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('index settings request feedback', () => {
  it('shows PDF setting load failures and recovers only after the person retries', async () => {
    const getPdfPages = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ pages: 30, default: 30, max: 400 })
    await render(
      createElement(PdfPagesSettings, { api: { getPdfPages } as unknown as HomeApi }),
      'vi',
    )
    expect(host.textContent).toContain('Không tải được cài đặt số trang PDF.')
    await act(async () => {
      host.querySelector('button')!.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(getPdfPages).toHaveBeenCalledTimes(2)
    expect(host.querySelector('input[aria-label="Số trang đọc của mỗi PDF"]')).not.toBeNull()
  })

  it('keeps embedding model load failure visible and supports retry in Chinese', async () => {
    const getEmbeddingModel = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({
        profile: 'standard',
        recommended: 'standard',
        machine: { totalMemGiB: 16, logicalCores: 8 },
        profiles: {
          standard: { name: 'Standard', dimensions: 384, downloadMB: 100, memoryMB: 500 },
          high: { name: 'High', dimensions: 768, downloadMB: 600, memoryMB: 3000 },
        },
      })
    window.aiOffice = { getEmbeddingModel } as never
    await render(createElement(EmbeddingModelSettings), 'zh')
    expect(host.textContent).toContain('无法加载搜索模型设置。')
    await act(async () => {
      host.querySelector('button')!.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(getEmbeddingModel).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('搜索模型')
  })

  it('shows database-location load failures with a deliberate retry', async () => {
    const getDbLocation = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ dir: 'C:\\index', isDefault: true, sizeBytes: 10 })
    await render(
      createElement(DbLocationSettings, { api: { getDbLocation } as unknown as HomeApi }),
      'en',
    )
    expect(host.textContent).toContain('Could not load the index location.')
    await act(async () => {
      host.querySelector('button')!.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(getDbLocation).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('C:\\index')
  })

  it('keeps Everything connection failure visible and retries on request', async () => {
    const getEverything = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ supported: true, enabled: false, found: false })
    await render(
      createElement(EverythingSettings, { api: { getEverything } as unknown as HomeApi }),
      'vi',
    )
    expect(host.textContent).toContain('Không tải được cài đặt Everything.')
    await act(async () => {
      host.querySelector('button')!.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(getEverything).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('Tìm tên file nhanh (Everything)')
  })
})
