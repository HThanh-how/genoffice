import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, resolve, join } from 'node:path'
import { build } from 'esbuild'
import type { Plugin } from 'vite'

const TARGET_WORKER_NAMES = new Set([
  'storage-accounting-worker',
  'backup-retention-worker',
  'index-status-worker',
  'search-worker',
  'file-index-writer-worker',
])

const nodeBuiltinExternals = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  'node:sqlite',
]

const externalPackages = Array.from(
  new Set([
    ...nodeBuiltinExternals,
    'onnxruntime-node',
    '@huggingface/tokenizers',
    'usearch',
    'electron',
  ]),
)

function hasModulePathQuery(query: string | undefined): boolean {
  if (!query) return false
  if (query === 'modulePath') return true
  const parts = query.split('&')
  return parts.some((p) => p === 'modulePath' || p.startsWith('modulePath='))
}

function getTargetWorkerName(cleanPathOrSource: string): string | null {
  const normalized = cleanPathOrSource.replace(/\\/g, '/')
  const base = basename(normalized)
  const name = base.replace(/\.[^.]+$/, '')
  return TARGET_WORKER_NAMES.has(name) ? name : null
}

const activeCleanups = new Set<() => void>()
let processExitHookRegistered = false

function registerGlobalExitHook(): void {
  if (processExitHookRegistered) return
  processExitHookRegistered = true

  const runAllCleanups = () => {
    for (const cleanup of activeCleanups) {
      try {
        cleanup()
      } catch {
        // Ignore during process shutdown
      }
    }
    activeCleanups.clear()
  }

  process.once('exit', runAllCleanups)
  process.once('SIGINT', runAllCleanups)
  process.once('SIGTERM', runAllCleanups)
}

/**
 * Manually trigger cleanup of owned temp worker bundle directories.
 * Safe to call after all worker threads have terminated.
 */
export function cleanupOwnedTempWorkers(): void {
  for (const cleanup of activeCleanups) {
    try {
      cleanup()
    } catch {
      // Ignore
    }
  }
  activeCleanups.clear()
}

export interface BundledModulePathPluginOptions {
  /** Optional override for tsconfig path passed to esbuild */
  tsconfigPath?: string
}

/**
 * Vite test plugin that intercepts `?modulePath` imports for `storage-accounting-worker`
 * and `backup-retention-worker`, bundling their real TypeScript source and transitive repo
 * dependencies via esbuild into dedicated temporary CJS files outside the repo.
 *
 * This allows Node Worker threads in test runs to execute actual current worker code without
 * crashing on extensionless TypeScript imports, matching production packaged engine behavior.
 */
export function bundledModulePathPlugin(
  options: BundledModulePathPluginOptions = {},
): Plugin {
  registerGlobalExitHook()

  const bundleCache = new Map<string, string>()
  let ownedTempDir: string | null = null

  function cleanupThisTempDir(): void {
    if (ownedTempDir && existsSync(ownedTempDir)) {
      try {
        rmSync(ownedTempDir, { recursive: true, force: true })
        ownedTempDir = null
      } catch {
        // Ignore
      }
    }
  }

  activeCleanups.add(cleanupThisTempDir)

  function getOrCreateTempDir(): string {
    if (!ownedTempDir || !existsSync(ownedTempDir)) {
      ownedTempDir = mkdtempSync(join(tmpdir(), 'genoffice-worker-bundle-'))
    }
    return ownedTempDir
  }

  const tsconfigPath =
    options.tsconfigPath ?? resolve(__dirname, '../../tsconfig.json')

  return {
    name: 'genoffice:bundled-module-path',
    enforce: 'pre',

    async resolveId(source, importer, resolveOptions) {
      const [rawSource, query] = source.split('?')
      if (!hasModulePathQuery(query)) {
        return null
      }

      const workerName = getTargetWorkerName(rawSource)
      if (!workerName) {
        return null
      }

      // Resolve the actual source file through Vite's standard resolution
      const resolved = await this.resolve(rawSource, importer, {
        skipSelf: true,
        ...resolveOptions,
      })

      if (resolved?.id) {
        return `${resolved.id}?modulePath`
      }

      if (isAbsolute(rawSource)) {
        return `${rawSource}?modulePath`
      }

      if (importer) {
        const candidate = resolve(dirname(importer), rawSource)
        return `${candidate}?modulePath`
      }

      return null
    },

    async load(id) {
      const [cleanPath, query] = id.split('?')
      if (!hasModulePathQuery(query)) {
        return null
      }

      const workerName = getTargetWorkerName(cleanPath)
      if (!workerName) {
        return null
      }

      // Locate entry file on disk
      let entryFile = cleanPath
      if (!existsSync(entryFile)) {
        if (existsSync(entryFile + '.ts')) {
          entryFile = entryFile + '.ts'
        } else if (existsSync(entryFile + '.js')) {
          entryFile = entryFile + '.js'
        } else {
          throw new Error(
            `[bundledModulePathPlugin] Entry file not found for ${cleanPath}`,
          )
        }
      }

      // Dedup per entry per run using scoped cache
      if (bundleCache.has(entryFile)) {
        const cachedPath = bundleCache.get(entryFile)!
        if (existsSync(cachedPath)) {
          return {
            code: `export default ${JSON.stringify(cachedPath)};\n`,
            map: null,
          }
        }
      }

      const tempDir = getOrCreateTempDir()
      const outPath = join(tempDir, `${workerName}.cjs`)

      // Bundle actual TS entry and transitive repo source via esbuild
      await build({
        entryPoints: [entryFile],
        outfile: outPath,
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'cjs',
        sourcemap: 'inline',
        external: externalPackages,
        define: {
          'import.meta': '__genofficeWorkerImportMeta',
        },
        banner: { js: 'const __genofficeWorkerImportMeta = { url: require("node:url").pathToFileURL(__filename).href, filename: __filename, dirname: __dirname };' },
        tsconfig:
          tsconfigPath && existsSync(tsconfigPath) ? tsconfigPath : undefined,
        logLevel: 'error',
      })

      bundleCache.set(entryFile, outPath)

      return {
        code: `export default ${JSON.stringify(outPath)};\n`,
        map: null,
      }
    },
  }
}

export default bundledModulePathPlugin
