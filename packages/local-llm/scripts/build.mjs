import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
for (const [input, output] of [
  ['host/entry', 'host'],
  ['index', 'index'],
]) {
  await build({
    entryPoints: [fileURLToPath(new URL(`../src/${input}.ts`, import.meta.url))],
    outfile: fileURLToPath(new URL(`../dist/${output}.mjs`, import.meta.url)),
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    sourcemap: true,
  })
}
