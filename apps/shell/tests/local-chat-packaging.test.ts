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

it('bundles @genoffice/local-llm into the main process and keeps only the native binding as a runtime dependency', () => {
  // electron-vite externalizes `dependencies`; a workspace package listed there is required at
  // runtime as TypeScript source from app.asar and crashes the packaged app at startup.
  const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as {
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
  }
  expect(pkg.dependencies['@genoffice/local-llm']).toBeUndefined()
  expect(pkg.devDependencies['@genoffice/local-llm']).toBeDefined()
  expect(pkg.dependencies['node-llama-cpp']).toBe('3.22.3')
})

it('unpacks ESM-only dependencies of node-llama-cpp next to the host (exports maps block require.resolve)', () => {
  const { nativeRuntimePackages } = require('../../../tools/local-llm-packaging.cjs') as {
    nativeRuntimePackages: (root: string) => Map<string, string>
  }
  const keys = [...nativeRuntimePackages(join(__dirname, '../../..')).keys()]
  // chalk and nanoid are ESM-only: the host crashed with ERR_MODULE_NOT_FOUND when they were skipped
  expect(keys.some((key) => key.endsWith('node_modules/chalk'))).toBe(true)
  expect(keys.some((key) => key.endsWith('node_modules/nanoid'))).toBe(true)
})

it('copies the host dependency closure, nested versions included, into app.asar.unpacked', () => {
  const { mkdtempSync, existsSync, readFileSync } = require('node:fs')
  const { tmpdir } = require('node:os')
  const { copyNativeRuntime } = require('../../../tools/local-llm-packaging.cjs') as {
    copyNativeRuntime: (root: string, resources: string) => number
  }
  const resources = mkdtempSync(join(tmpdir(), 'gen-res-'))
  expect(copyNativeRuntime(join(__dirname, '../../..'), resources)).toBeGreaterThan(50)
  const unpacked = join(resources, 'app.asar.unpacked', 'node_modules')
  // chalk 5 and nanoid sit under node-llama-cpp and were the packages the packaged host could not find
  const chalk = join(unpacked, 'node-llama-cpp', 'node_modules', 'chalk', 'package.json')
  expect(existsSync(chalk)).toBe(true)
  expect(JSON.parse(readFileSync(chalk, 'utf8')).version.split('.')[0]).toBe('5')
  expect(
    existsSync(join(unpacked, 'node-llama-cpp', 'node_modules', 'nanoid', 'package.json')),
  ).toBe(true)
})
