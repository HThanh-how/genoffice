import { createRequire } from 'node:module'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { it, expect } from 'vitest'

const require = createRequire(__filename)
it('ships the native CPU dependency closure, excludes other platforms and GPU packages, and emits ESM host', () => {
  const config = require('../electron-builder.cjs')
  expect(config.asarUnpack).toContain('out/main/local-llm-host.mjs')
  expect(config.asarUnpack).toContain('node_modules/node-llama-cpp/**')
  expect(config.asarUnpack).toContain('node_modules/@node-llama-cpp/**')
  expect(config.asarUnpack).toContain('node_modules/lifecycle-utils/**')
  expect(config.files).toContain('!node_modules/@node-llama-cpp/**')
  expect(config.files).toContain('node_modules/@node-llama-cpp/${os}-${arch}{,-metal}/**')
  expect(config.files).toContain('!node_modules/@node-llama-cpp/*cuda*/**')
  expect(config.files).toContain('!node_modules/@node-llama-cpp/*vulkan*/**')
  const root = join(__dirname, '../..')
  const { FileMatcher } = require('app-builder-lib/out/fileMatcher')
  const repository = join(root, '..')
  const filter = new FileMatcher(
    repository,
    repository,
    (pattern: string) => pattern.replaceAll('${os}', 'win').replaceAll('${arch}', 'x64'),
    config.files,
  ).createFilter()
  const file = { isDirectory: () => false }
  expect(
    filter(
      join(repository, 'node_modules/@node-llama-cpp/win-x64/bins/win-x64/llama-addon.node'),
      file,
    ),
  ).toBe(true)
  for (const backend of [
    'win-x64-cuda',
    'win-x64-cuda-ext',
    'win-x64-vulkan',
    'win-arm64',
    'linux-x64',
  ])
    expect(
      filter(join(repository, `node_modules/@node-llama-cpp/${backend}/bins/runtime.node`), file),
    ).toBe(false)
  for (const name of ['shell', 'docs', 'sheets', 'slides'])
    expect(readFileSync(join(root, name, 'electron.vite.config.ts'), 'utf8')).toContain(
      'localLlmHostPlugin()',
    )
  expect(existsSync(join(root, '../packages/local-llm/src/host/entry.ts'))).toBe(true)
})
