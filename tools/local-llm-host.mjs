import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

/** Keep the native runtime an ESM entry; node-llama-cpp cannot be required from CJS. */
export function localLlmHostPlugin() {
  return {
    name: 'genoffice-local-llm-host',
    async generateBundle() {
      const result = await build({
        entryPoints: [
          fileURLToPath(new URL('../packages/local-llm/src/host/entry.ts', import.meta.url)),
        ],
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        write: false,
      })
      this.emitFile({
        type: 'asset',
        fileName: 'local-llm-host.mjs',
        source: result.outputFiles[0].text,
      })
    },
  }
}
