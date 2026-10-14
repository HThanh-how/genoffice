// @vitest-environment jsdom
// @ts-expect-error global React act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, createElement } from 'react'
import { IndexingRulesStudio } from '../src/renderer/src/fork/IndexingRulesStudio'
import { UiFeedbackHost } from '../src/renderer/src/ui-feedback'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { HomeApi } from '../src/shared/home-api'
import type {
  IgnorePolicyConfig,
  IgnoreRule,
  IndexedFolder,
  IndexingPreset,
} from '../src/shared/fork/document-index-api'
import {
  classifyTestResult,
  filterRules,
  isEditableRule,
  pageSelectionIds,
  rowDescription,
} from '../src/renderer/src/fork/indexing-rules/policy-ui-state'

const PRESETS: IndexingPreset[] = [
  {
    id: 'preset-build-artifacts',
    name: 'Build artifacts',
    action: 'ignore',
    category: 'recommended',
    description: 'Skip build output folders',
    patterns: ['**/node_modules/**', '**/dist/**'],
    enabled: true,
  },
  {
    id: 'preset-media',
    name: 'Media files',
    action: 'ignore',
    category: 'media',
    description: 'Skip media content',
    patterns: ['*.jpg', '*.mp4'],
    enabled: false,
  },
]

const ROOT_A = 'C:\\Docs'
const ROOT_B = 'C:\\Notes'

function folder(root: string): IndexedFolder {
  return {
    root,
    state: 'complete',
    priority: false,
    unavailable: false,
    totalFiles: 0,
    readyFiles: 0,
    pendingFiles: 0,
  }
}

function userRule(id: string, action: 'allow' | 'ignore' = 'ignore'): IgnoreRule {
  return {
    id,
    pattern: `*.${id}`,
    enabled: true,
    scope: 'global',
    action,
    source: 'user',
  }
}

interface StudioTestApi {
  config: IgnorePolicyConfig
  fileRules: IgnoreRule[]
  roots: string[]
  saveResults: Array<{ ok: boolean; error?: string; validationErrors?: string[] }>
  saveCalls: IgnorePolicyConfig[]
  saveDelayMs: number
  ignoreFileResponses: Array<{
    root: string
    exists: boolean
    content: string
    revision: string
    delayMs: number
  }>
  ignoreSaveResults: Array<{ ok: boolean; error?: string; validationErrors?: string[] }>
  testResult?: {
    ignored: boolean
    eligibility?: 'supported' | 'unsupported'
    winningRule?: IgnoreRule
    explanation?: string
  }
  testThrows: boolean
}

function makeApi(overrides: Partial<StudioTestApi> = {}): { api: HomeApi; state: StudioTestApi } {
  const state: StudioTestApi = {
    config: { schemaVersion: 1, mode: 'standard', rules: [], presets: {} },
    fileRules: [],
    roots: [ROOT_A],
    saveResults: [{ ok: true }],
    saveCalls: [],
    saveDelayMs: 0,
    ignoreFileResponses: [
      { root: ROOT_A, exists: true, content: '@mode standard\n', revision: 'r1', delayMs: 0 },
    ],
    ignoreSaveResults: [{ ok: true }],
    testThrows: false,
    ...overrides,
  }
  let saveIndex = 0
  let ignoreSaveIndex = 0
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  const api = {
    getIgnorePolicyConfig: async () => state.config,
    getPolicyPresets: async () => PRESETS,
    getIgnoreRules: async () => [...state.config.rules, ...state.fileRules],
    listIndexedFolders: async () => state.roots.map(folder),
    getGenOfficeIgnoreFile: async (root: string) => {
      const response = state.ignoreFileResponses.find((entry) => entry.root === root) ?? {
        root,
        exists: false,
        content: '',
        revision: '',
        delayMs: 0,
      }
      if (response.delayMs) await sleep(response.delayMs)
      return response
    },
    saveIgnorePolicyConfig: async (payload: IgnorePolicyConfig) => {
      state.saveCalls.push(payload)
      if (state.saveDelayMs) await sleep(state.saveDelayMs)
      return state.saveResults[saveIndex++] ?? { ok: true }
    },
    saveGenOfficeIgnoreFile: async () =>
      state.ignoreSaveResults[ignoreSaveIndex++] ?? { ok: true, revision: 'r2' },
    testIgnorePath: async () => {
      if (state.testThrows) throw new Error('ipc-failure')
      return state.testResult ?? { ignored: false, eligibility: 'supported' }
    },
    searchIndexedFiles: async () => [],
  }
  return { api: api as unknown as HomeApi, state }
}

let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
let unmounted = false

async function mountStudio(api: HomeApi) {
  unmounted = false
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(
          'div',
          null,
          createElement(IndexingRulesStudio, { api }),
          createElement(UiFeedbackHost),
        ),
      ),
    )
  })
}

async function teardown() {
  if (!root || unmounted) return
  unmounted = true
  await act(async () => {
    root.unmount()
  })
  host.remove()
}

async function click(element: Element | null) {
  if (!element) throw new Error('target element not found')
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
}

const nativeValueSetter = (element: HTMLElement): ((this: HTMLElement, value: string) => void) => {
  if (element instanceof window.HTMLTextAreaElement) {
    return Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  }
  if (element instanceof window.HTMLSelectElement) {
    return Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
  }
  return Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
}

async function setInput(element: Element | null, value: string) {
  if (!element) throw new Error('target element not found')
  await act(async () => {
    nativeValueSetter(element).call(element, value)
    element.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

async function setSelect(element: Element | null, value: string) {
  if (!element) throw new Error('target element not found')
  await act(async () => {
    nativeValueSetter(element).call(element, value)
    element.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
}

function navButton(label: string): Element | undefined {
  return [...host.querySelectorAll('.ixr-nav button')].find(
    (button) => button.textContent?.trim() === label,
  )
}

function segmentedButton(container: string, label: string): Element | undefined {
  return [...host.querySelectorAll(`${container} button`)].find((button) =>
    button.textContent?.includes(label),
  )
}

function rows(): Element[] {
  return [...host.querySelectorAll('.ixr-table tbody .ixr-row')]
}

function dialogButton(label: string): Element | undefined {
  return [...document.querySelectorAll('.ui-feedback-button')].find(
    (button) => button.textContent?.trim() === label,
  )
}

function toastText(): string {
  return document.querySelector('.ui-feedback-root')?.textContent ?? ''
}

async function settle(ms = 250) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

describe('policy-ui-state helpers', () => {
  it('custom source filter excludes preset and .genofficeignore rules', () => {
    const rules = [
      userRule('u1'),
      { id: 'f1', pattern: '*.tmp', enabled: true, scope: 'global', source: '.genofficeignore' },
      { id: 'p1', pattern: '**/dist/**', enabled: true, scope: 'global', source: 'preset' },
    ]
    const filtered = filterRules(rules, {
      search: '',
      action: 'all',
      scope: 'all',
      source: 'user',
      state: 'all',
    })
    expect(filtered.map((rule) => rule.id)).toEqual(['u1'])
  })

  it('classifyTestResult never reports allowed when the engine did not answer', () => {
    expect(classifyTestResult(null)).toBe('error')
    expect(classifyTestResult(undefined)).toBe('error')
    expect(classifyTestResult({} as never)).toBe('error')
    expect(classifyTestResult({ ignored: false, eligibility: 'unsupported' })).toBe('unsupported')
    expect(classifyTestResult({ ignored: true })).toBe('ignored')
    expect(classifyTestResult({ ignored: false })).toBe('allowed')
  })

  it('page selection ids include only editable rules', () => {
    const page = [
      userRule('u1'),
      { id: 'f1', pattern: 'x', enabled: true, scope: 'global', source: '.genofficeignore' },
    ]
    expect([...pageSelectionIds(page)]).toEqual(['u1'])
    expect(isEditableRule(page[1] as IgnoreRule)).toBe(false)
  })

  it('file-rule rows drop the redundant engine description', () => {
    const fileRule: IgnoreRule = {
      id: 'f1',
      pattern: '**/archive_1/**',
      enabled: true,
      scope: 'C:\\Docs',
      source: '.genofficeignore',
      description: '.genofficeignore (ignore) in C:\\Docs',
    }
    expect(rowDescription(fileRule)).toBe('')
    expect(rowDescription(userRule('u1', 'ignore'))).toBe('')
    expect(rowDescription({ ...userRule('u2'), description: 'Office lock files' })).toBe(
      'Office lock files',
    )
  })
})

describe('IndexingRulesStudio state management', () => {
  afterEach(teardown)

  it('persists a mode change when the save succeeds', async () => {
    const { api, state } = makeApi({ saveResults: [{ ok: true }] })
    await mountStudio(api)
    await click(segmentedButton('.ixr-overview .ixr-segmented', 'Allowlist'))
    const allowlist = segmentedButton('.ixr-overview .ixr-segmented', 'Allowlist')
    expect(allowlist?.getAttribute('aria-checked')).toBe('true')
    expect(toastText()).toContain('Policy saved')
    expect(state.saveCalls[state.saveCalls.length - 1].mode).toBe('allowlist')
  })

  it('rolls back the mode when the save is rejected', async () => {
    const { api, state } = makeApi({ saveResults: [{ ok: false }] })
    await mountStudio(api)
    await click(segmentedButton('.ixr-overview .ixr-segmented', 'Allowlist'))
    const allowlist = segmentedButton('.ixr-overview .ixr-segmented', 'Allowlist')
    expect(allowlist?.getAttribute('aria-checked')).toBe('false')
    expect(toastText()).toContain('Save failed')
    expect(state.saveCalls.length).toBe(1)
  })

  it('rolls back the mode when the save throws', async () => {
    const { api } = makeApi({
      saveResults: [],
    })
    // Force a throw on save by removing the method after mount is impossible;
    // instead emulate a transport failure through a rejected result object.
    const failingApi = {
      ...api,
      saveIgnorePolicyConfig: async () => {
        throw new Error('ipc-down')
      },
    } as unknown as HomeApi
    await mountStudio(failingApi)
    await click(segmentedButton('.ixr-overview .ixr-segmented', 'Allowlist'))
    const allowlist = segmentedButton('.ixr-overview .ixr-segmented', 'Allowlist')
    expect(allowlist?.getAttribute('aria-checked')).toBe('false')
    expect(toastText()).toContain('Save failed')
  })

  it('rolls back a preset toggle when the save is rejected', async () => {
    const { api } = makeApi({ saveResults: [{ ok: false }] })
    await mountStudio(api)
    await click(host.querySelector('.ixr-disclose'))
    const switchButton = host.querySelector('.ixr-preset-list .ixr-switch')
    await click(switchButton)
    const reloaded = host.querySelector('.ixr-preset-list .ixr-switch')
    expect(reloaded?.getAttribute('aria-checked')).toBe('true')
    expect(toastText()).toContain('Save failed')
  })

  it('select-all is page-scoped, not global', async () => {
    const rules = Array.from({ length: 100 }, (_, index) => userRule(`r${index}`))
    const { api } = makeApi({ config: { schemaVersion: 1, mode: 'standard', rules, presets: {} } })
    await mountStudio(api)
    await click(navButton('Rules'))
    await click(host.querySelector('.ixr-th-check input'))
    const bulk = host.querySelector('.ixr-bulk')
    expect(bulk?.textContent).toContain('25 selected')
    expect(bulk?.textContent).toContain('25 editable')
    expect(rows().length).toBe(25)
  })

  it('bulk operations never touch read-only .genofficeignore rules', async () => {
    const { api, state } = makeApi({
      config: {
        schemaVersion: 1,
        mode: 'standard',
        rules: [userRule('a'), userRule('b')],
        presets: {},
      },
      fileRules: [
        { id: 'f1', pattern: '*.tmp', enabled: false, scope: ROOT_A, source: '.genofficeignore' },
        { id: 'f2', pattern: '*.bak', enabled: true, scope: ROOT_A, source: '.genofficeignore' },
      ],
    })
    await mountStudio(api)
    await click(navButton('Rules'))
    await click(host.querySelector('.ixr-th-check input'))
    const fileCheckbox = rows()[2]?.querySelector('input')
    expect(fileCheckbox).toBeNull()
    const enableButton = [...host.querySelectorAll('.ixr-bulk .ixr-btn')].find(
      (button) => button.textContent?.trim() === 'Enable',
    )
    await click(enableButton)
    const payload = state.saveCalls[state.saveCalls.length - 1]
    expect(payload.rules.length).toBe(2)
    expect(payload.rules.every((rule) => rule.source === 'user')).toBe(true)
  })

  it('reports an explicit error state when the tester IPC fails', async () => {
    const { api } = makeApi({ testThrows: true })
    await mountStudio(api)
    await setInput(host.querySelector('#ixr-tester-input'), 'drafts/report.docx')
    await click(host.querySelector('.ixr-tester-form .ixr-btn'))
    const result = host.querySelector('.ixr-test-result')
    expect(result?.classList.contains('outcome-error')).toBe(true)
    expect(host.querySelector('.ixr-outcome')?.textContent).toBe('Could not evaluate')
  })

  it('labels unsupported formats as unsupported, not allowed', async () => {
    const { api } = makeApi({
      testResult: { ignored: false, eligibility: 'unsupported' },
    })
    await mountStudio(api)
    await setInput(host.querySelector('#ixr-tester-input'), 'video.mp4')
    await click(host.querySelector('.ixr-tester-form .ixr-btn'))
    expect(host.querySelector('.ixr-outcome')?.textContent).toBe('Unsupported format')
  })

  it('shows the winning rule when a path is ignored', async () => {
    const { api } = makeApi({
      testResult: {
        ignored: true,
        winningRule: { id: 'f1', pattern: '*.tmp', enabled: true, scope: 'global' },
        explanation: 'Matched ignore rule "*.tmp".',
      },
    })
    await mountStudio(api)
    await setInput(host.querySelector('#ixr-tester-input'), 'cache/tmp.tmp')
    await click(host.querySelector('.ixr-tester-form .ixr-btn'))
    expect(host.querySelector('.ixr-outcome')?.textContent).toBe('Ignored')
    expect(host.querySelector('.ixr-test-result')?.textContent).toContain('*.tmp')
  })

  it('asks before saving an allow rule on a sensitive location', async () => {
    const { api, state } = makeApi()
    await mountStudio(api)
    await click(host.querySelector('.ixr-head-actions .ixr-btn-primary'))
    await setSelect(host.querySelector('.ixr-modal-form select'), 'allow')
    await setInput(host.querySelector('.ixr-modal-form input[type="text"]'), '.ssh/**')
    await click(host.querySelector('.ixr-modal-actions .ixr-btn-primary'))
    await click(dialogButton('Cancel'))
    expect(state.saveCalls.length).toBe(0)

    await click(host.querySelector('.ixr-head-actions .ixr-btn-primary'))
    await setSelect(host.querySelector('.ixr-modal-form select'), 'allow')
    await setInput(host.querySelector('.ixr-modal-form input[type="text"]'), '.ssh/**')
    await click(host.querySelector('.ixr-modal-actions .ixr-btn-primary'))
    await click(dialogButton('Allow'))
    expect(state.saveCalls.length).toBe(1)
    expect(state.saveCalls[0].rules[0].action).toBe('allow')
  })

  it('protects an unsaved editor draft when navigating away', async () => {
    const { api } = makeApi()
    await mountStudio(api)
    await click(navButton('.genofficeignore'))
    const textarea = host.querySelector('.ixr-editor-text')
    await setInput(textarea, '@mode standard\n!*.pdf\n')
    await click(navButton('Overview'))
    expect(dialogButton('Cancel')).toBeTruthy()
    await click(dialogButton('Cancel'))
    expect(navButton('.genofficeignore')?.getAttribute('aria-selected')).toBe('true')
    expect((host.querySelector('.ixr-editor-text') as HTMLTextAreaElement | null)?.value).toBe(
      '@mode standard\n!*.pdf\n',
    )
    await click(navButton('Overview'))
    await click(dialogButton('Discard'))
    expect(host.querySelector('.ixr-overview')).toBeTruthy()
  })

  it('shows validation errors from the ignore-file save', async () => {
    const { api } = makeApi({
      ignoreSaveResults: [{ ok: false, validationErrors: ['Line 2: unknown directive'] }],
    })
    await mountStudio(api)
    await click(navButton('.genofficeignore'))
    await setInput(host.querySelector('.ixr-editor-text'), '@mode standard\nbadline\n')
    await click(host.querySelector('.ixr-editor-actions .ixr-btn-primary'))
    expect(host.querySelector('.ixr-error-list')?.textContent).toContain('Line 2')
  })

  it('surfaces a conflict when the file changed on disk', async () => {
    const { api } = makeApi({ ignoreSaveResults: [{ ok: false, error: 'conflict' }] })
    await mountStudio(api)
    await click(navButton('.genofficeignore'))
    await setInput(host.querySelector('.ixr-editor-text'), '@mode allowlist\n')
    await click(host.querySelector('.ixr-editor-actions .ixr-btn-primary'))
    expect(host.querySelector('.ixr-alert.warning')).toBeTruthy()
  })

  it('discards a stale editor response from an older root request', async () => {
    const { api } = makeApi({
      roots: [ROOT_A, ROOT_B],
      ignoreFileResponses: [
        { root: ROOT_A, exists: true, content: 'SLOW-A', revision: 'rA', delayMs: 120 },
        { root: ROOT_B, exists: true, content: 'FAST-B', revision: 'rB', delayMs: 10 },
      ],
    })
    await mountStudio(api)
    await click(navButton('.genofficeignore'))
    await setSelect(host.querySelector('.ixr-editor-toolbar select'), ROOT_B)
    await settle(300)
    const value = (host.querySelector('.ixr-editor-text') as HTMLTextAreaElement | null)?.value
    expect(value).toBe('FAST-B')
  })

  it('does not apply a save response after the studio unmounted', async () => {
    const { api, state } = makeApi({ saveDelayMs: 100, saveResults: [{ ok: false }] })
    await mountStudio(api)
    await click(segmentedButton('.ixr-overview .ixr-segmented', 'Allowlist'))
    await teardown()
    await settle(200)
    expect(state.saveCalls.length).toBe(1)
  })
})

describe('IndexingRulesStudio scalability', () => {
  afterEach(teardown)

  it('renders and filters 5,000 rules with bounded DOM and fast filtering', async () => {
    const rules = Array.from({ length: 5000 }, (_, index) => userRule(`r${index}`))
    const { api } = makeApi({
      config: { schemaVersion: 1, mode: 'standard', rules, presets: {} },
    })
    const mountStart = performance.now()
    await mountStudio(api)
    const mountMs = performance.now() - mountStart
    await click(navButton('Rules'))
    expect(rows().length).toBe(25)
    expect(host.querySelector('.ixr-pagination')?.textContent).toContain('5000 rules')

    const filterStart = performance.now()
    const filtered = filterRules(rules, {
      search: 'r4',
      action: 'all',
      scope: 'all',
      source: 'all',
      state: 'all',
    })
    const filterMs = performance.now() - filterStart
    console.log(
      `5000-rule studio: mount ${Math.round(mountMs)}ms, filter ${Math.round(filterMs)}ms`,
    )
    expect(filtered.length).toBeGreaterThan(0)
    expect(filterMs).toBeLessThan(300)
    expect(mountMs).toBeLessThan(3000)
  })

  it('paginates a 1,000-rule workspace at 100 rows per page', async () => {
    const rules = Array.from({ length: 1000 }, (_, index) => userRule(`r${index}`))
    const { api } = makeApi({
      config: { schemaVersion: 1, mode: 'standard', rules, presets: {} },
    })
    const mountStart = performance.now()
    await mountStudio(api)
    const mountMs = performance.now() - mountStart
    await click(navButton('Rules'))
    await setSelect(host.querySelector('.ixr-page-size select'), '100')
    console.log(`1000-rule studio: mount ${Math.round(mountMs)}ms, 100 rows rendered`)
    expect(rows().length).toBe(100)
    expect(host.querySelector('.ixr-pagination')?.textContent).toContain('Page 1 of 10')
  })
})
