import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

function findRepoRoot(startDir: string): string {
  let cur = startDir
  while (cur !== dirname(cur)) {
    if (existsSync(resolve(cur, 'tools/check-document-memory-architecture.mjs'))) {
      return cur
    }
    cur = dirname(cur)
  }
  throw new Error(`Unable to locate repository root from ${startDir}`)
}

export const REAL_REPO_ROOT = findRepoRoot(__dirname)
export const CHECKER_SCRIPT_PATH = resolve(REAL_REPO_ROOT, 'tools/check-document-memory-architecture.mjs')

export const EXPLICIT_CHECKER_FILES = [
  'apps/shell/src/main/document-memory/manager.ts',
  'apps/shell/src/main/document-memory/store.ts',
  'apps/shell/src/main/document-memory/storage-migration.ts',
  'apps/shell/src/main/document-memory/storage/schema-v3.ts',
  'apps/shell/src/main/fork/document-index-snapshot-service.ts',
  'apps/shell/src/main/fork/document-index-ipc.ts',
  'apps/shell/src/main/fork/document-index-folder-handlers.ts',
] as const

export function discoverIpcFiles(mainDir: string): string[] {
  const results: string[] = []
  function scan(dir: string) {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry)
      if (statSync(full).isDirectory()) {
        scan(full)
      } else if (/(?:ipc|-handlers)\.ts$/.test(entry)) {
        results.push(full)
      }
    }
  }
  scan(mainDir)
  return results
}

export interface ArchitectureFixture {
  readonly fixtureRoot: string
  readonly checkerScriptPath: string
  runChecker(): { status: number | null; stdout: string; stderr: string; output: string }
  mutateFile(relPath: string, mutator: (content: string) => string): () => void
  cleanup(): void
}

export function createArchitectureFixture(): ArchitectureFixture {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'arch-fixture-'))

  // 1. Copy explicit files required by checker (manager, store, migration, schema, snapshot service, default IPC)
  for (const relPath of EXPLICIT_CHECKER_FILES) {
    const src = resolve(REAL_REPO_ROOT, relPath)
    const dst = resolve(fixtureRoot, relPath)
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
  }

  // 2. Discover and copy all other IPC files in apps/shell/src/main
  const mainDir = resolve(REAL_REPO_ROOT, 'apps/shell/src/main')
  const discoveredIpc = discoverIpcFiles(mainDir)
  for (const src of discoveredIpc) {
    const relPath = relative(REAL_REPO_ROOT, src)
    const dst = resolve(fixtureRoot, relPath)
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
  }

  // 3. Copy full renderer tree (apps/shell/src/renderer) which is walked recursively by the checker
  const rendererSrc = resolve(REAL_REPO_ROOT, 'apps/shell/src/renderer')
  const rendererDst = resolve(fixtureRoot, 'apps/shell/src/renderer')
  mkdirSync(dirname(rendererDst), { recursive: true })
  cpSync(rendererSrc, rendererDst, { recursive: true })

  function runChecker(): { status: number | null; stdout: string; stderr: string; output: string } {
    const res = spawnSync(process.execPath, [CHECKER_SCRIPT_PATH], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    })
    const output = (res.stdout ?? '') + (res.stderr ?? '')
    return {
      status: res.status,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
      output,
    }
  }

  function mutateFile(relPath: string, mutator: (content: string) => string): () => void {
    if (isAbsolute(relPath)) {
      throw new Error(`Absolute paths are not permitted in mutateFile: ${relPath}`)
    }

    const fullPath = resolve(fixtureRoot, relPath)
    const relFromFixture = relative(fixtureRoot, fullPath)
    if (relFromFixture.startsWith('..') || isAbsolute(relFromFixture) || fullPath === fixtureRoot) {
      throw new Error(`Path escapes fixture root: ${relPath} (resolved to ${fullPath})`)
    }

    const relFromRepo = relative(REAL_REPO_ROOT, fullPath)
    if (!relFromRepo.startsWith('..') && !isAbsolute(relFromRepo)) {
      throw new Error(`CRITICAL: Attempted to mutate real repository source at ${fullPath}!`)
    }

    if (!existsSync(fullPath)) {
      throw new Error(`Target file does not exist in fixture: ${relPath} (${fullPath})`)
    }

    const current = readFileSync(fullPath, 'utf8')
    const mutated = mutator(current)
    writeFileSync(fullPath, mutated, 'utf8')

    return () => {
      writeFileSync(fullPath, current, 'utf8')
    }
  }

  function cleanup(): void {
    if (existsSync(fixtureRoot)) {
      const relFromRepo = relative(REAL_REPO_ROOT, fixtureRoot)
      if (!relFromRepo.startsWith('..') && !isAbsolute(relFromRepo)) {
        throw new Error(`CRITICAL: Refusing to delete fixtureRoot inside real repository! ${fixtureRoot}`)
      }
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  }

  return {
    fixtureRoot,
    checkerScriptPath: CHECKER_SCRIPT_PATH,
    runChecker,
    mutateFile,
    cleanup,
  }
}
