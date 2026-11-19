import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createPackageWithOptions } from '@electron/asar'

const require = createRequire(import.meta.url)
const root = resolve('.')
const { nativeRuntimePackages } = require('../../../tools/local-llm-packaging.cjs')
const source = join(root, '.tooling/local-llm-packed/source')
await mkdir(join(source, 'out/main'), { recursive: true })
for (const [relative, directory] of nativeRuntimePackages(root))
  await cp(directory, join(source, relative), { recursive: true })
await cp(
  join(root, 'node_modules/@node-llama-cpp/win-x64'),
  join(source, 'node_modules/@node-llama-cpp/win-x64'),
  { recursive: true },
)
await cp(
  join(root, 'packages/local-llm/dist/host.mjs'),
  join(source, 'out/main/local-llm-host.mjs'),
)
await writeFile(
  join(source, 'package.json'),
  JSON.stringify({
    name: 'local-native-packaging-smoke',
    version: '0.1.0',
    type: 'module',
    main: 'main.mjs',
  }),
)
await build({
  entryPoints: [join(root, 'packages/local-llm/scripts/electron-smoke.mjs')],
  outfile: join(source, 'main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['electron'],
})
await createPackageWithOptions(source, join(root, '.tooling/local-llm-packed/app.asar'), {
  unpack: '**',
})
console.log('Prepared ASAR + unpacked native dependency closure (CPU only)')
