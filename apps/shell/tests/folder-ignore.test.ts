import { describe, expect, it } from 'vitest'
import {
  addFolderIgnoreToRules,
  buildFolderIgnoreRule,
  decideFolderIgnoreMenu,
  folderIgnoreRuleId,
  removeFolderIgnoreFromRules,
} from '../src/shared/fork/folder-ignore'
import type { IgnoreRule } from '../src/shared/fork/document-index-api'

describe('folder ignore rule', () => {
  it('builds a deterministic user rule scoped to the folder', () => {
    const rule = buildFolderIgnoreRule('D:\\Work\\Old\\', true)!
    expect(rule).toMatchObject({
      pattern: '**',
      scope: 'D:/Work/Old',
      action: 'ignore',
      source: 'user',
      enabled: true,
      description: 'Ignored from Home',
    })
    expect(rule.id).toBe('folder-ignore:d:/work/old')
    expect(folderIgnoreRuleId('d:/WORK/old', true)).toBe(rule.id)
    expect(folderIgnoreRuleId('/a/B', false)).not.toBe(folderIgnoreRuleId('/a/b', false))
  })

  it('keeps long ids within 100 chars and distinct', () => {
    const a = 'D:/' + 'x'.repeat(150) + '/a'
    const b = 'D:/' + 'x'.repeat(150) + '/b'
    expect(folderIgnoreRuleId(a, true).length).toBeLessThanOrEqual(100)
    expect(folderIgnoreRuleId(a, true)).not.toBe(folderIgnoreRuleId(b, true))
    expect(folderIgnoreRuleId(a, true)).toBe(folderIgnoreRuleId(a, true))
  })

  it('add is idempotent, remove only touches its own rule', () => {
    const other: IgnoreRule = { id: 'r1', pattern: '*.bak', enabled: true, scope: 'global' }
    const added = addFolderIgnoreToRules([other], 'D:/Work/Old', true)!
    expect(added.changed).toBe(true)
    expect(added.rules).toHaveLength(2)
    const again = addFolderIgnoreToRules(added.rules, 'd:\\work\\old', true)!
    expect(again.changed).toBe(false)
    const sibling = removeFolderIgnoreFromRules(added.rules, 'D:/Work/Other', true)
    expect(sibling.changed).toBe(false)
    const removed = removeFolderIgnoreFromRules(added.rules, 'D:/WORK/old', true)
    expect(removed.changed).toBe(true)
    expect(removed.rules).toEqual([other])
  })

  it('re-enables a disabled copy of the rule', () => {
    const rule = { ...buildFolderIgnoreRule('D:/a', true)!, enabled: false }
    const res = addFolderIgnoreToRules([rule], 'D:/a', true)!
    expect(res.changed).toBe(true)
    expect(res.rules).toHaveLength(1)
    expect(res.rules[0].enabled).toBe(true)
  })

  it('rejects over-long scope', () => {
    expect(buildFolderIgnoreRule('D:/' + 'x'.repeat(600), true)).toBeNull()
  })
})

describe('decideFolderIgnoreMenu', () => {
  const path = 'D:/Work/Old'
  const own = {
    ignored: true,
    source: 'user',
    scope: 'D:/Work/Old',
    pattern: '**',
    ruleId: 'folder-ignore:d:/work/old',
  }
  const decide = (result: Parameters<typeof decideFolderIgnoreMenu>[0]['result'], isRoot = false) =>
    decideFolderIgnoreMenu({ path, isRoot, result, caseInsensitive: true }).kind

  it('hides at root, checks while pending, hides on failure', () => {
    expect(decide({ ignored: false }, true)).toBe('hidden')
    expect(decide(undefined)).toBe('checking')
    expect(decide(null)).toBe('hidden')
  })
  it('offers ignore when not ignored (including allow override)', () => {
    expect(decide({ ignored: false })).toBe('ignore')
  })
  it('offers stop only for the folder-ignore rule of exactly this folder', () => {
    expect(decide(own)).toBe('stop')
    expect(decide({ ...own, scope: 'D:/WORK/old' })).toBe('stop')
  })
  it('blocks when another rule ignores the folder', () => {
    expect(decide({ ignored: true, source: 'preset', scope: 'global', pattern: 'node_modules' })).toBe('blocked')
    expect(decide({ ...own, scope: 'D:/Work' })).toBe('blocked')
    expect(decide({ ...own, source: '.genofficeignore' })).toBe('blocked')
  })
})

describe('folder ignore handlers (main)', () => {
  it('add/remove through IPC handlers changes evaluateIgnore for the folder and its files', async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const policy = await import('../src/main/document-memory/ignore-policy')
    const { DOCUMENT_INDEX_CHANNELS } = await import('../src/shared/fork/document-index-api')
    const dir = mkdtempSync(join(tmpdir(), 'folder-ignore-'))
    try {
      policy.setIgnoreStoragePath(join(dir, 'rules.json'))
      policy.setActiveIgnoreRules([])
      const root = join(dir, 'root')
      const sub = join(root, 'old')
      mkdirSync(sub, { recursive: true })
      const handlers = new Map<string, (...a: unknown[]) => unknown>()
      let invalidated = 0
      policy.registerIgnoreIpcHandlers(
        { handle: (ch, fn) => void handlers.set(ch, fn as never) },
        () => void invalidated++,
      )
      const call = (ch: string, ...a: unknown[]) => handlers.get(ch)!({}, ...a) as any
      expect(policy.evaluateIgnore(sub, root).ignored).toBe(false)
      expect(call(DOCUMENT_INDEX_CHANNELS.addFolderIgnore, sub)).toEqual({ ok: true, changed: true })
      expect(policy.evaluateIgnore(sub, root).ignored).toBe(true)
      expect(policy.evaluateIgnore(join(sub, 'a.docx'), root).ignored).toBe(true)
      expect(policy.evaluateIgnore(join(root, 'keep.docx'), root).ignored).toBe(false)
      expect(call(DOCUMENT_INDEX_CHANNELS.addFolderIgnore, sub)).toEqual({ ok: true, changed: false })
      expect(call(DOCUMENT_INDEX_CHANNELS.removeFolderIgnore, sub)).toEqual({ ok: true, changed: true })
      expect(policy.evaluateIgnore(sub, root).ignored).toBe(false)
      expect(invalidated).toBe(2)
      expect(call(DOCUMENT_INDEX_CHANNELS.addFolderIgnore, 5).ok).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
