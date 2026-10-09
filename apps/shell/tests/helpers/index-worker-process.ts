import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { createIndexProcess, type IndexProcessData } from '../../src/main/document-memory/process-worker'

/**
 * Bundles the REAL indexing worker (src/main/document-memory/worker.ts, the same entry electron-vite emits through
 * `./worker?modulePath`) with esbuild and runs it as a real child process through the production `createIndexProcess`.
 * This is what proves (1) the worker bundle contains the compaction lane and (2) compaction work leaves the main thread.
 */
let bundlePromise: Promise<{ file: string; dir: string; modules: string[] }> | null = null

export function bundleIndexWorker(): Promise<{ file: string; dir: string; modules: string[] }> {
  bundlePromise ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'genoffice-index-worker-'))
    const file = join(dir, 'worker.cjs')
    const stubModulePath = {
      name: 'stub-modulepath',
      setup(b: import('esbuild').PluginBuild) {
        // nested `?modulePath` imports (the accounting thread) are never used inside the index worker
        b.onResolve({ filter: /\?modulePath$/ }, (a) => ({ path: a.path, namespace: 'mp-stub' }))
        b.onLoad({ filter: /.*/, namespace: 'mp-stub' }, () => ({ contents: 'export default "unused-in-index-worker"', loader: 'js' }))
      },
    }
    const result = await build({
      entryPoints: [resolve(__dirname, '../../src/main/document-memory/worker.ts')],
      outfile: file,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      logLevel: 'error',
      metafile: true,
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'node:sqlite', 'onnxruntime-node', '@huggingface/tokenizers', 'usearch', 'electron'],
      define: { 'import.meta': '__genofficeWorkerImportMeta' },
      banner: { js: 'const __genofficeWorkerImportMeta = { url: require("node:url").pathToFileURL(__filename).href, filename: __filename, dirname: __dirname };' },
      tsconfig: resolve(__dirname, '../../tsconfig.json'),
      plugins: [stubModulePath],
    })
    const modules = Object.keys(result.metafile.inputs)
    process.once('exit', () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    })
    return { file, dir, modules }
  })()
  return bundlePromise
}

/** A `workerFactory` for DocumentMemoryManager that starts the bundled real worker as a child process. */
export async function realIndexWorkerFactory(): Promise<(script: string, env: Record<string, string>) => ReturnType<typeof createIndexProcess>> {
  const { file } = await bundleIndexWorker()
  if (!existsSync(file)) throw new Error('index worker bundle missing')
  // the bundle lives in a temp dir: native externals (onnxruntime-node, usearch) resolve through the repo's node_modules
  const roots = [resolve(__dirname, '../../node_modules'), resolve(__dirname, '../../../../node_modules')]
  process.env.NODE_PATH = [...roots, process.env.NODE_PATH].filter(Boolean).join(delimiter)
  return (_script, env) => createIndexProcess(file, env as unknown as IndexProcessData)
}
