// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'

const source = ts.createSourceFile(
  'docs-main.ts',
  readFileSync(new URL('../src/main/docs-main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
)
const text = (pick: (node: ts.Node) => boolean): string => {
  let found: ts.Node | undefined
  const visit = (node: ts.Node) => {
    if (!found && pick(node)) found = node
    else ts.forEachChild(node, visit)
  }
  visit(source)
  return found!.getText(source)
}
// the production handler and hook, run without booting Electron
const code = [
  text((n) => ts.isVariableStatement(n) && n.getText(source).includes('providerChangeGuard')),
  text((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'setAiProviderChangeGuard'),
  text(
    (n) =>
      ts.isExpressionStatement(n) &&
      n.getText(source).startsWith("ipcMain.handle('ai:set-settings'"),
  ),
].join('\n')

function fixture(stored: { provider?: string } | null) {
  let handler!: (event: unknown, settings: unknown) => Promise<{ ok: boolean }>
  const written: unknown[] = []
  const context = createContext({
    exports: {},
    console,
    readJson: () => stored,
    SETTINGS_PATH: () => '/synthetic/ai-settings.json',
    defaultAiSettings: () => ({ provider: 'local' }),
    applySettingsWrite: async (settings: unknown) => {
      written.push(settings)
      return { ok: true, settings }
    },
    writeJsonAtomic: () => {},
    listAgyModels: async () => [],
    broadcastAiSettingsChanged: () => {},
    maybePrewarmAgy: () => {},
    ipcMain: {
      handle: (_channel: string, h: typeof handler) => {
        handler = h
      },
    },
  })
  runInContext(
    ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  )
  const exports = context.exports as {
    setAiProviderChangeGuard(g: (next: string, previous: string) => Promise<boolean>): void
  }
  return { save: (s: unknown) => handler({}, s), written, guard: exports.setAiProviderChangeGuard }
}

it('Not now keeps the provider in use and saves everything else', async () => {
  const f = fixture({ provider: 'gemini' })
  const guard = vi.fn(async () => false)
  f.guard(guard)
  expect(await f.save({ provider: 'local', apiKeyNote: 'kept' })).toEqual({ ok: true })
  expect(guard).toHaveBeenCalledWith('local', 'gemini')
  expect(f.written).toEqual([{ provider: 'gemini', apiKeyNote: 'kept' }])
})

it('Download lets the switch through', async () => {
  const f = fixture({ provider: 'gemini' })
  f.guard(async () => true)
  await f.save({ provider: 'local' })
  expect(f.written).toEqual([{ provider: 'local' }])
})

it('is not asked when the provider does not change, or where no guard is set', async () => {
  const f = fixture({ provider: 'local' })
  const guard = vi.fn(async () => false)
  f.guard(guard)
  await f.save({ provider: 'local', maxOutputTokens: 1 })
  // a fresh install has no stored provider: Local is already the one in use
  const fresh = fixture(null)
  fresh.guard(guard)
  await fresh.save({ provider: 'local' })
  expect(guard).not.toHaveBeenCalled()
  const standalone = fixture({ provider: 'gemini' })
  await standalone.save({ provider: 'local' })
  expect(standalone.written).toEqual([{ provider: 'local' }])
})
